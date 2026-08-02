"""Single GPU worker thread.

Consumes job ids from an in-process queue, keeps at most one pipeline loaded
(LRU of 1), and supports cooperative cancellation via per-job events checked
from the pipeline's step callback.
"""

from __future__ import annotations

import logging
import queue
import secrets
import threading
from dataclasses import dataclass

from ..outputs.storage import artifact_records, job_output_dir
from ..pipelines import JobCancelled, JobContext, Pipeline, resolve_pipeline_class
from .config import PipelineProfile, Settings
from .jobs import JobState, JobStore

log = logging.getLogger("nidora.worker")

_STOP = object()


@dataclass
class _Warmup:
    profile: str


@dataclass
class _Offload:
    profile: str | None  # None = whatever is currently loaded


class GpuWorker:
    def __init__(
        self,
        store: JobStore,
        settings: Settings,
        profiles: dict[str, PipelineProfile],
    ):
        self.store = store
        self.settings = settings
        self.profiles = profiles
        self._queue: queue.SimpleQueue = queue.SimpleQueue()
        self._cancel_events: dict[str, threading.Event] = {}
        self._cancel_lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._current: Pipeline | None = None
        self._current_profile: str | None = None
        self._activity: str = "idle"

    # -- lifecycle ---------------------------------------------------------

    def start(self) -> None:
        for job_id in self.store.recover_on_startup():
            self._queue.put(job_id)
        self._thread = threading.Thread(target=self._run, name="gpu-worker", daemon=True)
        self._thread.start()

    def stop(self, timeout: float = 10.0) -> None:
        self._queue.put(_STOP)
        if self._thread:
            self._thread.join(timeout=timeout)

    @property
    def loaded_pipeline(self) -> str | None:
        return self._current_profile

    @property
    def activity(self) -> str:
        """"idle" | "loading:<profile>" | "job:<job_id>"."""
        return self._activity

    # -- job submission / cancellation --------------------------------------

    def submit(self, job_id: str) -> None:
        self._queue.put(job_id)

    def warmup(self, profile_name: str) -> None:
        """Queue a pipeline load ahead of any job needing it."""
        self._queue.put(_Warmup(profile_name))

    def offload(self, profile_name: str | None = None) -> None:
        """Queue an unload of `profile_name` (or whatever is loaded)."""
        self._queue.put(_Offload(profile_name))

    def cancel(self, job_id: str) -> str | None:
        """Returns the resulting state ("cancelled" | "cancelling") or None if
        the job can't be cancelled (unknown or already terminal)."""
        if self.store.set_state(
            job_id, JobState.CANCELLED, error="cancelled by user", expect=JobState.QUEUED
        ):
            return "cancelled"
        with self._cancel_lock:
            event = self._cancel_events.get(job_id)
        if event is not None:
            event.set()
            return "cancelling"
        return None

    # -- worker loop ---------------------------------------------------------

    def _run(self) -> None:
        while True:
            item = self._queue.get()
            if item is _STOP:
                self._unload_current()
                return
            if isinstance(item, _Warmup):
                self._warmup(item.profile)
            elif isinstance(item, _Offload):
                if item.profile is None or item.profile == self._current_profile:
                    self._unload_current()
            else:
                self._process(item)
            self._activity = "idle"

    def _warmup(self, profile_name: str) -> None:
        try:
            self._ensure_pipeline(profile_name)
            log.info("warmup done: %s", profile_name)
        except Exception:  # noqa: BLE001 — warmup errors must never kill the worker
            log.exception("warmup failed: %s", profile_name)

    def _process(self, job_id: str) -> None:
        # CAS queued -> running: skips jobs cancelled while waiting in queue.
        if not self.store.set_state(job_id, JobState.RUNNING, expect=JobState.QUEUED):
            return
        job = self.store.get(job_id)
        if job is None:
            return

        cancel_event = threading.Event()
        with self._cancel_lock:
            self._cancel_events[job_id] = cancel_event

        self._activity = f"job:{job_id}"
        try:
            pipeline = self._ensure_pipeline(job.pipeline)
            self._activity = f"job:{job_id}"  # _ensure_pipeline may have set loading:*
            params = pipeline.validate_params(job.params)
            # Materialize a random seed so every generation is reproducible:
            # the effective seed is written back into the job's stored params.
            if getattr(params, "seed", ...) is None:
                seed = secrets.randbits(31)
                params = params.model_copy(update={"seed": seed})
                self.store.update_params(job_id, {**job.params, "seed": seed})
            ctx = JobContext(
                job_id=job_id,
                cancel_event=cancel_event,
                report_progress=lambda step, total: self.store.set_progress(
                    job_id, step / max(total, 1)
                ),
                output_dir=job_output_dir(self.settings.outputs_dir, job_id),
            )
            log.info("job %s: running pipeline %s", job_id, job.pipeline)
            artifacts = pipeline.generate(params, ctx)
            self.store.set_state(
                job_id, JobState.COMPLETED, artifacts=artifact_records(job_id, artifacts)
            )
            log.info("job %s: completed (%d artifacts)", job_id, len(artifacts))
        except JobCancelled:
            self.store.set_state(job_id, JobState.CANCELLED, error="cancelled by user")
            log.info("job %s: cancelled", job_id)
        except Exception as exc:  # noqa: BLE001 — job errors must never kill the worker
            self.store.set_state(job_id, JobState.FAILED, error=f"{type(exc).__name__}: {exc}")
            log.exception("job %s: failed", job_id)
        finally:
            with self._cancel_lock:
                self._cancel_events.pop(job_id, None)

    # -- pipeline cache (LRU of 1) -------------------------------------------

    def _ensure_pipeline(self, profile_name: str) -> Pipeline:
        if self._current is not None and self._current_profile == profile_name:
            return self._current

        profile = self.profiles.get(profile_name)
        if profile is None:
            raise KeyError(f"unknown pipeline profile: {profile_name!r}")

        self._unload_current()
        cls = resolve_pipeline_class(profile.kind)
        pipeline = cls(profile, self.settings)
        log.info("loading pipeline %s (kind=%s)", profile_name, profile.kind)
        self._activity = f"loading:{profile_name}"
        try:
            pipeline.load()
        except Exception:
            pipeline.unload()
            raise
        self._current = pipeline
        self._current_profile = profile_name
        return pipeline

    def _unload_current(self) -> None:
        if self._current is not None:
            log.info("unloading pipeline %s", self._current_profile)
            try:
                self._current.unload()
            except Exception:
                log.exception("error unloading pipeline %s", self._current_profile)
            self._current = None
            self._current_profile = None
