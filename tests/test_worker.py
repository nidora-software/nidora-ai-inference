from __future__ import annotations

import time

from nidora_ai_inference.core.config import PipelineProfile
from nidora_ai_inference.core.jobs import JobState, JobStore
from nidora_ai_inference.core.worker import GpuWorker


def make_worker(settings, defaults=None):
    store = JobStore(settings.db_path)
    profiles = {
        "mock": PipelineProfile(
            name="mock",
            kind="mock",
            defaults=defaults or {"num_frames": 4, "width": 32, "height": 32},
        )
    }
    worker = GpuWorker(store=store, settings=settings, profiles=profiles)
    return store, worker


def wait_state(store, job_id, states, timeout=15.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        job = store.get(job_id)
        if job.state in states:
            return job
        time.sleep(0.02)
    raise TimeoutError(f"job stuck in {store.get(job_id).state}")


def test_happy_path(settings):
    store, worker = make_worker(settings)
    worker.start()
    try:
        job = store.create("mock", {"prompt": "x"})
        worker.submit(job.id)
        done = wait_state(store, job.id, {JobState.COMPLETED, JobState.FAILED})
        assert done.state == JobState.COMPLETED
        assert done.artifacts and done.artifacts[0]["media_type"] == "video/mp4"
        assert (settings.outputs_dir / job.id / "output.mp4").is_file()
        assert worker.loaded_pipeline == "mock"
    finally:
        worker.stop()


def test_unknown_profile_fails_job(settings):
    store, worker = make_worker(settings)
    worker.start()
    try:
        job = store.create("does-not-exist", {})
        worker.submit(job.id)
        done = wait_state(store, job.id, {JobState.FAILED})
        assert "unknown pipeline profile" in done.error
    finally:
        worker.stop()


def test_invalid_params_fail_job(settings):
    # Params slip past the API only if defaults are bad — worker must still fail safely.
    store, worker = make_worker(settings, defaults={"num_frames": -1})
    worker.start()
    try:
        job = store.create("mock", {})
        worker.submit(job.id)
        done = wait_state(store, job.id, {JobState.FAILED})
        assert "ValidationError" in done.error
    finally:
        worker.stop()


def test_cancel_queued_job_is_skipped(settings):
    store, worker = make_worker(settings)
    # Worker not started: job sits queued.
    job = store.create("mock", {})
    assert worker.cancel(job.id) == "cancelled"
    worker.start()
    try:
        worker.submit(job.id)
        time.sleep(0.3)
        assert store.get(job.id).state == JobState.CANCELLED
    finally:
        worker.stop()


def test_cancel_running_job(settings):
    store, worker = make_worker(settings)
    worker.start()
    try:
        job = store.create("mock", {"num_frames": 240, "delay_s": 0.05})
        worker.submit(job.id)
        wait_state(store, job.id, {JobState.RUNNING})
        time.sleep(0.1)
        assert worker.cancel(job.id) == "cancelling"
        done = wait_state(store, job.id, {JobState.CANCELLED})
        assert done.state == JobState.CANCELLED
    finally:
        worker.stop()


def test_cancel_terminal_returns_none(settings):
    store, worker = make_worker(settings)
    worker.start()
    try:
        job = store.create("mock", {})
        worker.submit(job.id)
        wait_state(store, job.id, {JobState.COMPLETED})
        assert worker.cancel(job.id) is None
    finally:
        worker.stop()


def test_requeue_on_startup(settings):
    store, worker = make_worker(settings)
    job = store.create("mock", {})
    # start() re-enqueues queued jobs from a previous run
    worker.start()
    try:
        done = wait_state(store, job.id, {JobState.COMPLETED})
        assert done.state == JobState.COMPLETED
    finally:
        worker.stop()
