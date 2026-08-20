"""Executing one assigned job.

The agent is deliberately a dumb executor: every generation parameter arrives
fully resolved in the assignment, so retuning them is a gateway redeploy rather
than a 30-minute CUDA image rebuild.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import logging
from dataclasses import dataclass, field

import httpx

from .sglang import SglangClient, SglangError

log = logging.getLogger("nidora_agent.runner")

#: Gateway-side field builders put this where the input image belongs (e.g.
#: inside MiniMax-H3's `conditions` JSON); the agent substitutes the fetched
#: bytes as a data: URI. Base64 is JSON-safe, so the substitution cannot
#: corrupt a JSON-carrying field.
INPUT_DATA_URI_PLACEHOLDER = "{{INPUT_DATA_URI}}"


def _sniff_media_type(data: bytes) -> str:
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return "application/octet-stream"


def resolve_input_placeholders(fields: dict[str, object], image: bytes) -> dict[str, object]:
    """Replace INPUT_DATA_URI_PLACEHOLDER in string fields with a data: URI."""
    if not any(
        isinstance(value, str) and INPUT_DATA_URI_PLACEHOLDER in value
        for value in fields.values()
    ):
        return fields
    data_uri = (
        f"data:{_sniff_media_type(image)};base64,{base64.b64encode(image).decode('ascii')}"
    )
    return {
        key: value.replace(INPUT_DATA_URI_PLACEHOLDER, data_uri)
        if isinstance(value, str)
        else value
        for key, value in fields.items()
    }


@dataclass
class Assignment:
    job_id: str
    lease_id: str
    model: str
    endpoint: str
    fields: dict[str, object]
    input_url: str
    input_sha256: str | None

    @classmethod
    def from_payload(cls, payload: dict) -> "Assignment":
        sglang = payload.get("sglang") or {}
        source = payload.get("input") or {}
        return cls(
            job_id=str(payload["job_id"]),
            lease_id=str(payload["lease_id"]),
            model=str(payload.get("model", "")),
            endpoint=str(sglang.get("endpoint", "/v1/videos")),
            fields=dict(sglang.get("fields") or {}),
            input_url=str(source.get("url", "")),
            input_sha256=source.get("sha256"),
        )


@dataclass
class JobState:
    """What the agent reports about a job on each poll."""

    assignment: Assignment
    phase: str = "starting"
    progress: float = 0.0
    upstream_id: str | None = None
    cancelled: asyncio.Event = field(default_factory=asyncio.Event)


class StaleLease(Exception):
    """The gateway no longer considers this pod the owner of the job."""


class Runner:
    """Drives one job: fetch input -> submit -> poll -> download -> upload."""

    def __init__(
        self,
        gateway_url: str,
        headers: dict[str, str],
        sglang: SglangClient,
        *,
        job_timeout_s: int,
        upload_attempts: int,
    ) -> None:
        self.gateway_url = gateway_url
        self.headers = headers
        self.sglang = sglang
        self.job_timeout_s = job_timeout_s
        self.upload_attempts = upload_attempts

    async def run(self, client: httpx.AsyncClient, state: JobState) -> dict:
        """Execute the job and return the body for POST .../result.

        Never raises for an expected failure — a failure is a result too, and
        reporting it is what lets the gateway retry elsewhere or fail fast.
        """
        job = state.assignment
        deadline = asyncio.get_running_loop().time() + self.job_timeout_s

        try:
            state.phase = "downloading_input"
            image = await self._fetch_input(client, job)

            if state.cancelled.is_set():
                return {"state": "cancelled"}

            state.phase = "submitting"
            upstream = await self.sglang.create_video(
                client, job.endpoint, resolve_input_placeholders(job.fields, image), image
            )
            state.upstream_id = upstream.id
            state.phase = "generating"
            state.progress = 0.1

            async def on_poll(_status: str) -> None:
                if state.cancelled.is_set():
                    raise _Cancelled()
                # SGLang does not report step progress, so this is a coarse
                # "still working" signal rather than a real percentage. Its job
                # is to renew the lease, which the poll loop does anyway.
                state.progress = min(0.9, state.progress + 0.02)

            await self.sglang.wait_for_video(client, upstream.id, deadline, on_poll)

            state.phase = "downloading_output"
            state.progress = 0.95
            media = await self.sglang.download_content(client, upstream.id)

            state.phase = "uploading"
            digest = hashlib.sha256(media).hexdigest()
            await self._upload(client, job, media, digest)

            return {
                "state": "completed",
                "filename": "output.mp4",
                "bytes": len(media),
                "sha256": digest,
                "upstream_id": upstream.id,
            }

        except _Cancelled:
            if state.upstream_id:
                await self.sglang.cancel(client, state.upstream_id)
            return {"state": "cancelled"}
        except StaleLease:
            raise
        except SglangError as exc:
            log.warning("job %s failed: %s (retryable=%s)", job.job_id, exc, exc.retryable)
            return {"state": "failed", "error": str(exc), "retryable": exc.retryable}
        except Exception as exc:  # noqa: BLE001 - a crash here must still be reported
            log.exception("job %s crashed in the agent", job.job_id)
            return {"state": "failed", "error": f"agent error: {exc}", "retryable": True}

    async def _fetch_input(self, client: httpx.AsyncClient, job: Assignment) -> bytes:
        url = f"{self.gateway_url}{job.input_url}"
        response = await client.get(
            url, params={"lease_id": job.lease_id}, headers=self.headers, timeout=120.0
        )
        if response.status_code == 409:
            raise StaleLease(job.job_id)
        response.raise_for_status()
        data = response.content

        if job.input_sha256:
            actual = hashlib.sha256(data).hexdigest()
            if actual != job.input_sha256:
                raise SglangError("input image failed its checksum", retryable=True)
        return data

    async def _upload(
        self, client: httpx.AsyncClient, job: Assignment, media: bytes, digest: str
    ) -> None:
        """Upload the clip, retrying transient failures.

        The result is only reported after this returns, so a completed job
        always has its bytes on the gateway's disk. Re-POSTing is idempotent —
        the gateway overwrites its part file — so a retry after a timeout is
        safe even when the first attempt actually landed.
        """
        url = f"{self.gateway_url}/v1/agent/jobs/{job.job_id}/artifact"
        headers = {
            **self.headers,
            "Content-Type": "video/mp4",
            "X-Content-SHA256": digest,
        }

        last: Exception | None = None
        for attempt in range(1, self.upload_attempts + 1):
            try:
                response = await client.post(
                    url,
                    params={"lease_id": job.lease_id, "filename": "output.mp4"},
                    headers=headers,
                    content=media,
                    timeout=300.0,
                )
                if response.status_code == 409:
                    raise StaleLease(job.job_id)
                if response.status_code < 300:
                    return
                if response.status_code < 500:
                    raise SglangError(
                        f"gateway rejected the artifact ({response.status_code}): {response.text[:200]}",
                        retryable=False,
                    )
                last = SglangError(
                    f"gateway artifact upload failed ({response.status_code})", retryable=True
                )
            except httpx.HTTPError as exc:
                last = exc

            if attempt < self.upload_attempts:
                await asyncio.sleep(min(2**attempt, 10))

        raise SglangError(f"artifact upload failed after {self.upload_attempts} attempts: {last}", retryable=True)


class _Cancelled(Exception):
    """Internal: the client cancelled this job while it was generating."""
