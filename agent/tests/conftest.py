"""Test fixtures: an in-process fake gateway and a fake SGLang server.

Both are plain ASGI apps on ephemeral ports, so the agent under test uses its
real HTTP client against real sockets — the failure modes that matter here
(timeouts, status codes, retries) do not survive mocking.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import socket
from dataclasses import dataclass, field

import pytest
import uvicorn
from fastapi import FastAPI, Form, Request, Response, UploadFile
from fastapi.responses import JSONResponse

from nidora_agent.config import Config


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@contextlib.asynccontextmanager
async def serve(app: FastAPI):
    port = _free_port()
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error")
    server = uvicorn.Server(config)
    task = asyncio.create_task(server.serve())
    try:
        for _ in range(200):
            if server.started:
                break
            await asyncio.sleep(0.01)
        else:
            raise RuntimeError("test server did not start")
        yield f"http://127.0.0.1:{port}"
    finally:
        server.should_exit = True
        await task


@dataclass
class FakeSglang:
    app: FastAPI
    ready: bool = True
    delay_s: float = 0.0
    create_status: int = 200
    poll_status: int = 200
    content_status: int = 200
    clip: bytes = b"mock-mp4-bytes"
    #: Every form payload the agent submitted, for asserting field translation.
    submissions: list[dict] = field(default_factory=list)
    cancels: list[str] = field(default_factory=list)


@pytest.fixture
def fake_sglang() -> FakeSglang:
    app = FastAPI()
    state = FakeSglang(app=app)
    jobs: dict[str, float] = {}

    @app.get("/health")
    async def health() -> Response:
        return Response(status_code=200 if state.ready else 503)

    @app.post("/v1/videos")
    async def create(
        input_reference: UploadFile | None = None,
        prompt: str = Form(""),
        negative_prompt: str = Form(""),
        size: str = Form(""),
        seconds: str = Form(""),
        num_inference_steps: str = Form(""),
        guidance_scale: str = Form(""),
        seed: str = Form(""),
    ) -> JSONResponse:
        if state.create_status != 200:
            return JSONResponse({"error": "boom"}, status_code=state.create_status)
        payload = await input_reference.read() if input_reference else b""
        state.submissions.append(
            {
                "prompt": prompt,
                "negative_prompt": negative_prompt,
                "size": size,
                "seconds": seconds,
                "num_inference_steps": num_inference_steps,
                "guidance_scale": guidance_scale,
                "seed": seed,
                "input_bytes": len(payload),
            }
        )
        job_id = f"video_{len(state.submissions)}"
        jobs[job_id] = asyncio.get_running_loop().time() + state.delay_s
        return JSONResponse({"id": job_id, "status": "queued"})

    @app.get("/v1/videos/{job_id}")
    async def poll(job_id: str) -> JSONResponse:
        if state.poll_status != 200:
            return JSONResponse({"error": "boom"}, status_code=state.poll_status)
        done_at = jobs.get(job_id)
        if done_at is None:
            return JSONResponse({"error": "not found"}, status_code=404)
        ready = asyncio.get_running_loop().time() >= done_at
        return JSONResponse({"id": job_id, "status": "completed" if ready else "in_progress"})

    @app.get("/v1/videos/{job_id}/content")
    async def content(job_id: str) -> Response:
        if state.content_status != 200:
            return JSONResponse({"error": "boom"}, status_code=state.content_status)
        return Response(content=state.clip, media_type="video/mp4")

    @app.delete("/v1/videos/{job_id}")
    async def cancel(job_id: str) -> Response:
        state.cancels.append(job_id)
        jobs.pop(job_id, None)
        return Response(status_code=204)

    return state


@dataclass
class FakeGateway:
    app: FastAPI
    image: bytes = b"\xff\xd8\xffmock-jpeg"
    #: Poll responses handed out in order; the last one repeats.
    script: list[dict] = field(default_factory=list)
    polls: list[dict] = field(default_factory=list)
    uploads: list[dict] = field(default_factory=list)
    results: list[dict] = field(default_factory=list)
    input_status: int = 200
    upload_status: int = 200
    #: Number of upload attempts to fail before succeeding.
    upload_failures: int = 0


@pytest.fixture
def fake_gateway() -> FakeGateway:
    app = FastAPI()
    state = FakeGateway(app=app)

    @app.post("/v1/agent/poll")
    async def poll(request: Request) -> JSONResponse:
        body = await request.json()
        state.polls.append(body)
        index = min(len(state.polls) - 1, len(state.script) - 1) if state.script else -1
        payload = dict(state.script[index]) if index >= 0 else {}
        payload.setdefault("session_id", "s")
        payload.setdefault("lease_ttl_s", 120)
        payload.setdefault("poll_wait_s", 25)
        payload.setdefault("assign", [])
        payload.setdefault("cancel", [])
        payload.setdefault("orphan", [])
        payload.setdefault("drain", False)
        return JSONResponse(payload)

    @app.get("/v1/agent/jobs/{job_id}/input")
    async def get_input(job_id: str, lease_id: str = "") -> Response:
        if state.input_status != 200:
            return Response(status_code=state.input_status)
        return Response(content=state.image, media_type="application/octet-stream")

    @app.post("/v1/agent/jobs/{job_id}/artifact")
    async def artifact(job_id: str, request: Request, lease_id: str = "", filename: str = "") -> Response:
        body = await request.body()
        state.uploads.append(
            {
                "job_id": job_id,
                "lease_id": lease_id,
                "filename": filename,
                "bytes": len(body),
                "sha256": hashlib.sha256(body).hexdigest(),
                "declared_sha256": request.headers.get("x-content-sha256"),
            }
        )
        if state.upload_failures > 0:
            state.upload_failures -= 1
            return JSONResponse({"detail": "transient"}, status_code=500)
        if state.upload_status != 200:
            return JSONResponse({"detail": "nope"}, status_code=state.upload_status)
        return JSONResponse({"ok": True})

    @app.post("/v1/agent/jobs/{job_id}/result")
    async def result(job_id: str, request: Request, lease_id: str = "") -> Response:
        body = await request.json()
        state.results.append({"job_id": job_id, "lease_id": lease_id, **body})
        return JSONResponse({"id": job_id})

    return state


def make_config(gateway_url: str, sglang_url: str, **overrides) -> Config:
    defaults = dict(
        gateway_url=gateway_url,
        agent_secret="secret",
        pod_id="pod-test",
        max_in_flight=1,
        sglang_url=sglang_url,
        model_path="Wan-AI/Wan2.2-I2V-A14B-Diffusers",
        lora_path=None,
        gpu="mock-gpu",
        poll_wait_s=0,
        poll_error_backoff_s=0.01,
        poll_error_backoff_max_s=0.05,
        job_timeout_s=10,
        sglang_poll_interval_s=0.01,
        upload_attempts=3,
        cf_access_client_id=None,
        cf_access_client_secret=None,
        log_level="CRITICAL",
        headers={"X-Agent-Secret": "secret"},
    )
    defaults.update(overrides)
    return Config(**defaults)


def assignment(job_id: str = "j_1", lease_id: str = "lease-1", **fields) -> dict:
    return {
        "job_id": job_id,
        "lease_id": lease_id,
        "model": "Wan-AI/Wan2.2-I2V-A14B-Diffusers",
        "deadline_at": 0,
        "input": {"url": f"/v1/agent/jobs/{job_id}/input", "sha256": None, "bytes": None},
        "sglang": {
            "endpoint": "/v1/videos",
            "fields": {
                "prompt": "a woman smiles",
                "negative_prompt": "blurry",
                "size": "464x832",
                "seconds": 5,
                "num_inference_steps": 4,
                "guidance_scale": 1.0,
                **fields,
            },
        },
    }
