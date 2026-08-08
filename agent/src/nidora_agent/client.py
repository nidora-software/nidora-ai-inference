"""The poll loop: the agent's whole control flow.

One request per cycle carries registration, readiness, lease renewal and
progress up, and brings assignments, cancellations and orphan notices down.
Between cycles the gateway parks the request, so an idle pod costs one
in-flight HTTP request and picks up new work within milliseconds of it being
submitted rather than on the next tick.
"""

from __future__ import annotations

import asyncio
import logging
import random

import httpx

from .config import AGENT_VERSION, Config
from .runner import Assignment, JobState, Runner, StaleLease
from .sglang import SglangClient

log = logging.getLogger("nidora_agent.client")


class Agent:
    def __init__(self, config: Config) -> None:
        self.config = config
        self.sglang = SglangClient(config.sglang_url, config.sglang_poll_interval_s)
        self.runner = Runner(
            config.gateway_url,
            config.headers,
            self.sglang,
            job_timeout_s=config.job_timeout_s,
            upload_attempts=config.upload_attempts,
        )
        self.jobs: dict[str, JobState] = {}
        self.tasks: dict[str, asyncio.Task] = {}
        self.sglang_ready = False
        self._stop = asyncio.Event()

    def stop(self) -> None:
        self._stop.set()

    async def run(self) -> None:
        limits = httpx.Limits(max_connections=8, max_keepalive_connections=4)
        async with httpx.AsyncClient(limits=limits, follow_redirects=False) as client:
            backoff = self.config.poll_error_backoff_s
            while not self._stop.is_set():
                try:
                    await self._cycle(client)
                    backoff = self.config.poll_error_backoff_s
                except httpx.HTTPError as exc:
                    # The gateway, the tunnel, or the network. Keep working on
                    # whatever is already running — sglang neither knows nor
                    # cares that the control plane is unreachable.
                    log.warning("poll failed (%s); retrying in %.1fs", exc, backoff)
                    await self._sleep(backoff)
                    backoff = min(
                        backoff * 2 * (0.75 + random.random() * 0.5),
                        self.config.poll_error_backoff_max_s,
                    )
                except Exception:  # noqa: BLE001 - the loop must never die
                    log.exception("unexpected error in the poll loop")
                    await self._sleep(backoff)

            await self._drain()

    async def _sleep(self, seconds: float) -> None:
        try:
            await asyncio.wait_for(self._stop.wait(), timeout=seconds)
        except asyncio.TimeoutError:
            pass

    async def _cycle(self, client: httpx.AsyncClient) -> None:
        # Readiness is checked every cycle, not once: a pod can go from loading
        # to ready ten minutes in, and can lose its server to an OOM at any
        # point after that.
        ready = await self.sglang.is_ready(client)
        if ready != self.sglang_ready:
            log.info("sglang readiness changed to %s", ready)
        self.sglang_ready = ready

        body = {
            "pod_id": self.config.pod_id,
            "agent_version": AGENT_VERSION,
            "max_in_flight": self.config.max_in_flight,
            "model_path": self.config.model_path,
            "lora_path": self.config.lora_path,
            "gpu": self.config.gpu,
            "sglang_ready": ready,
            "wait_s": self.config.poll_wait_s,
            "in_flight": [
                {
                    "job_id": job_id,
                    "lease_id": state.assignment.lease_id,
                    "progress": state.progress,
                    "phase": state.phase,
                    "upstream_id": state.upstream_id,
                }
                for job_id, state in self.jobs.items()
            ],
        }

        response = await client.post(
            f"{self.config.gateway_url}/agent/v1/poll",
            json=body,
            headers=self.config.headers,
            # Comfortably longer than the server's poll window, which is itself
            # inside Cloudflare's 125s proxy read timeout.
            timeout=self.config.poll_wait_s + 30,
        )
        response.raise_for_status()
        payload = response.json()

        # Jobs the gateway no longer thinks we own. Almost always a lease that
        # expired during a network partition; the job may already have been
        # completed by another pod, so uploading ours would be wrong.
        for job_id in payload.get("orphan") or []:
            state = self.jobs.get(job_id)
            if state:
                log.warning("job %s orphaned by the gateway; abandoning", job_id)
                state.cancelled.set()

        for job_id in payload.get("cancel") or []:
            state = self.jobs.get(job_id)
            if state:
                log.info("job %s cancelled by the client", job_id)
                state.cancelled.set()

        if payload.get("drain"):
            log.info("gateway asked this pod to drain; no new work will be accepted")

        for raw in payload.get("assign") or []:
            self._start(client, Assignment.from_payload(raw))

    def _start(self, client: httpx.AsyncClient, assignment: Assignment) -> None:
        if assignment.job_id in self.jobs:
            return  # duplicate delivery; the lease makes this harmless
        state = JobState(assignment=assignment)
        self.jobs[assignment.job_id] = state
        log.info("starting job %s (%s)", assignment.job_id, assignment.pipeline)
        task = asyncio.create_task(self._execute(client, state), name=f"job-{assignment.job_id}")
        self.tasks[assignment.job_id] = task

    async def _execute(self, client: httpx.AsyncClient, state: JobState) -> None:
        job_id = state.assignment.job_id
        try:
            result = await self.runner.run(client, state)
            await self._report(client, state, result)
        except StaleLease:
            log.warning("job %s lease is stale; dropping without reporting", job_id)
        except Exception:  # noqa: BLE001
            log.exception("job %s could not be reported", job_id)
        finally:
            self.jobs.pop(job_id, None)
            self.tasks.pop(job_id, None)

    async def _report(self, client: httpx.AsyncClient, state: JobState, result: dict) -> None:
        """Deliver the terminal outcome, retrying while the lease is still ours."""
        job = state.assignment
        url = f"{self.config.gateway_url}/agent/v1/jobs/{job.job_id}/result"
        for attempt in range(1, 4):
            try:
                response = await client.post(
                    url,
                    params={"lease_id": job.lease_id},
                    json=result,
                    headers=self.config.headers,
                    timeout=60.0,
                )
                if response.status_code == 409:
                    raise StaleLease(job.job_id)
                if response.status_code < 300:
                    log.info("job %s reported as %s", job.job_id, result.get("state"))
                    return
                log.warning(
                    "reporting job %s failed (%s): %s",
                    job.job_id,
                    response.status_code,
                    response.text[:200],
                )
            except httpx.HTTPError as exc:
                log.warning("reporting job %s failed: %s", job.job_id, exc)
            if attempt < 3:
                await asyncio.sleep(2**attempt)
        # Giving up is safe: the lease expires and the gateway requeues the job.
        log.error("gave up reporting job %s; the gateway will requeue it", job.job_id)

    async def _drain(self) -> None:
        """On SIGTERM, let in-flight jobs finish reporting before exiting."""
        if not self.tasks:
            return
        log.info("waiting for %d in-flight job(s) to finish", len(self.tasks))
        await asyncio.wait(set(self.tasks.values()), timeout=30)
