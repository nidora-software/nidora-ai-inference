"""A stand-in for SGLang Diffusion's OpenAI-compatible API.

Exists so the gateway, the agent and the whole end-to-end path can be tested on
a laptop and in CI with no GPU, no CUDA image and no 126 GB model download.

Knobs (all environment variables):
  MOCK_DELAY_S        seconds a generation takes                  (default 1)
  MOCK_READY_AFTER_S  seconds before /health returns 200 —
                      simulates the ~10 minute model load          (default 0)
  MOCK_FAIL_MODE      create | poll | content — where to fail      (default none)
  MOCK_FAIL_STATUS    HTTP status to fail with                     (default 500)

Run: uvicorn server:app --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import os
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, Form, Response, UploadFile
from fastapi.responses import JSONResponse

DELAY_S = float(os.environ.get("MOCK_DELAY_S", "1"))
READY_AFTER_S = float(os.environ.get("MOCK_READY_AFTER_S", "0"))
FAIL_MODE = os.environ.get("MOCK_FAIL_MODE", "")
FAIL_STATUS = int(os.environ.get("MOCK_FAIL_STATUS", "500"))

FIXTURE = Path(__file__).parent / "fixtures" / "tiny.mp4"
STARTED_AT = time.monotonic()

app = FastAPI(title="mock-sglang-diffusion")

#: job id -> {"created": monotonic, "fields": {...}, "input_bytes": int}
JOBS: dict[str, dict] = {}


def _ready() -> bool:
    return time.monotonic() - STARTED_AT >= READY_AFTER_S


@app.get("/health")
async def health() -> Response:
    # Mirrors the real server: not healthy until warmup completes, so a healthy
    # server is a warm server.
    if not _ready():
        return Response(status_code=503)
    return Response(status_code=200)


@app.get("/models")
async def models() -> JSONResponse:
    return JSONResponse(
        {"data": [{"id": os.environ.get("MODEL_PATH", "mock/wan22-i2v"), "task": "i2v"}]}
    )


@app.post("/v1/videos")
async def create_video(
    input_reference: UploadFile | None = None,
    prompt: str = Form(""),
    negative_prompt: str = Form(""),
    size: str = Form("480x832"),
    seconds: str = Form("5"),
    num_inference_steps: str = Form("4"),
    guidance_scale: str = Form("1.0"),
    seed: str = Form(""),
) -> JSONResponse:
    if FAIL_MODE == "create":
        return JSONResponse({"error": "mock create failure"}, status_code=FAIL_STATUS)
    if not _ready():
        return JSONResponse({"error": "model still loading"}, status_code=503)

    payload = await input_reference.read() if input_reference else b""
    job_id = f"video_{uuid.uuid4().hex[:12]}"
    JOBS[job_id] = {
        "created": time.monotonic(),
        # Echoed back on poll so tests can assert exactly which fields the
        # gateway resolved and the agent forwarded.
        "fields": {
            "prompt": prompt,
            "negative_prompt": negative_prompt,
            "size": size,
            "seconds": seconds,
            "num_inference_steps": num_inference_steps,
            "guidance_scale": guidance_scale,
            "seed": seed,
        },
        "input_bytes": len(payload),
    }
    return JSONResponse({"id": job_id, "status": "queued"}, status_code=200)


@app.get("/v1/videos/{job_id}")
async def get_video(job_id: str) -> JSONResponse:
    if FAIL_MODE == "poll":
        return JSONResponse({"error": "mock poll failure"}, status_code=FAIL_STATUS)
    job = JOBS.get(job_id)
    if job is None:
        return JSONResponse({"error": "not found"}, status_code=404)

    elapsed = time.monotonic() - job["created"]
    status = "completed" if elapsed >= DELAY_S else "in_progress"
    return JSONResponse(
        {"id": job_id, "status": status, "echo": job["fields"], "input_bytes": job["input_bytes"]}
    )


@app.get("/v1/videos/{job_id}/content")
async def get_content(job_id: str) -> Response:
    if FAIL_MODE == "content":
        return JSONResponse({"error": "mock content failure"}, status_code=FAIL_STATUS)
    if job_id not in JOBS:
        return JSONResponse({"error": "not found"}, status_code=404)
    return Response(content=FIXTURE.read_bytes(), media_type="video/mp4")


@app.delete("/v1/videos/{job_id}")
async def cancel(job_id: str) -> Response:
    JOBS.pop(job_id, None)
    return Response(status_code=204)


@app.get("/v1/videos")
async def list_videos() -> JSONResponse:
    return JSONResponse({"data": [{"id": jid} for jid in JOBS]})


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8000")))
