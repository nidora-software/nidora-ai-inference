"""Client for the local SGLang Diffusion server.

The server binds 127.0.0.1 in gateway mode and has no authentication of its
own — which is precisely why nothing outside the pod may reach it.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass

import httpx

log = logging.getLogger("nidora_agent.sglang")

#: SGLang statuses that mean the job will not progress further.
TERMINAL_OK = {"completed", "succeeded"}
TERMINAL_BAD = {"failed", "error", "cancelled", "canceled"}


class SglangError(Exception):
    """A failure talking to the local SGLang server.

    ``retryable`` decides whether the gateway should hand the job to another
    pod. A 5xx or a dropped connection is worth retrying elsewhere; a 4xx means
    the request itself is wrong and retrying only burns the client's deadline.
    """

    def __init__(self, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.retryable = retryable


@dataclass
class VideoJob:
    id: str
    status: str


class SglangClient:
    def __init__(self, base_url: str, poll_interval_s: float = 2.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.poll_interval_s = poll_interval_s

    async def is_ready(self, client: httpx.AsyncClient) -> bool:
        """True once the model is loaded and warmed.

        With server-mode warmup (the CLI default) the server does not report
        healthy until warmup finishes, so a healthy server is a *fast* server.
        This is the gate that stops the gateway sending work to a pod that is
        still loading a 14B model — or OOM-looping and never will.
        """
        try:
            response = await client.get(f"{self.base_url}/health", timeout=5.0)
            return response.status_code == 200
        except httpx.HTTPError:
            return False

    async def create_video(
        self,
        client: httpx.AsyncClient,
        endpoint: str,
        fields: dict[str, object],
        image: bytes,
        filename: str = "input.jpg",
    ) -> VideoJob:
        files = {"input_reference": (filename, image, "application/octet-stream")}
        data = {key: str(value) for key, value in fields.items()}
        try:
            response = await client.post(
                f"{self.base_url}{endpoint}", data=data, files=files, timeout=120.0
            )
        except httpx.HTTPError as exc:
            raise SglangError(f"could not reach the local sglang server: {exc}", retryable=True) from exc

        if response.status_code >= 500:
            raise SglangError(
                f"sglang {endpoint} failed ({response.status_code}): {response.text[:500]}",
                retryable=True,
            )
        if response.status_code >= 400:
            # Almost always a field name or value SGLang did not accept. The
            # body is logged verbatim because that is how a field-name drift
            # between versions gets diagnosed.
            raise SglangError(
                f"sglang rejected the request ({response.status_code}): {response.text[:500]}",
                retryable=False,
            )

        payload = response.json()
        job_id = payload.get("id")
        if not isinstance(job_id, str) or not job_id:
            raise SglangError(f"sglang returned no job id: {response.text[:300]}", retryable=False)
        return VideoJob(id=job_id, status=str(payload.get("status", "queued")))

    async def wait_for_video(
        self,
        client: httpx.AsyncClient,
        job_id: str,
        deadline: float,
        on_poll=None,
    ) -> str:
        """Poll until terminal. Returns the final status, raises on failure."""
        while True:
            if asyncio.get_running_loop().time() > deadline:
                raise SglangError("timed out waiting for sglang to finish", retryable=False)

            try:
                response = await client.get(f"{self.base_url}/v1/videos/{job_id}", timeout=30.0)
            except httpx.HTTPError as exc:
                raise SglangError(f"lost contact with sglang: {exc}", retryable=True) from exc

            if response.status_code >= 500:
                raise SglangError(
                    f"sglang poll failed ({response.status_code}): {response.text[:300]}",
                    retryable=True,
                )
            if response.status_code == 404:
                raise SglangError("sglang forgot the job", retryable=True)
            if response.status_code >= 400:
                raise SglangError(
                    f"sglang poll rejected ({response.status_code}): {response.text[:300]}",
                    retryable=False,
                )

            payload = response.json()
            status = str(payload.get("status", "")).lower()
            if status in TERMINAL_OK:
                return status
            if status in TERMINAL_BAD:
                detail = payload.get("error") or payload.get("failure_reason") or status
                raise SglangError(f"sglang reported {status}: {str(detail)[:300]}", retryable=False)

            if on_poll is not None:
                await on_poll(status)
            await asyncio.sleep(self.poll_interval_s)

    async def download_content(self, client: httpx.AsyncClient, job_id: str) -> bytes:
        try:
            response = await client.get(
                f"{self.base_url}/v1/videos/{job_id}/content", timeout=300.0
            )
        except httpx.HTTPError as exc:
            raise SglangError(f"could not download the clip: {exc}", retryable=True) from exc
        if response.status_code != 200:
            raise SglangError(
                f"sglang content download failed ({response.status_code})",
                retryable=response.status_code >= 500,
            )
        return response.content

    async def cancel(self, client: httpx.AsyncClient, job_id: str) -> None:
        """Best-effort upstream cancel.

        SGLang v0.5.16's diffusion API may not expose a cancel for an in-flight
        video job; if it does not, the agent simply stops polling and the GPU
        finishes the work unobserved. Failures here are logged, never raised.
        """
        for method, path in (
            ("DELETE", f"/v1/videos/{job_id}"),
            ("POST", f"/v1/videos/{job_id}/cancel"),
        ):
            try:
                response = await client.request(
                    method, f"{self.base_url}{path}", timeout=10.0
                )
                if response.status_code < 300:
                    log.info("cancelled sglang job %s via %s %s", job_id, method, path)
                    return
            except httpx.HTTPError:
                continue
        log.info("no upstream cancel available for sglang job %s; abandoning locally", job_id)
