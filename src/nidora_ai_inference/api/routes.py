"""All API endpoints."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import ValidationError

from ..core.jobs import TERMINAL_STATES
from ..outputs.storage import resolve_output_file
from ..pipelines import resolve_pipeline_class
from .schemas import HealthResponse, JobCreate, JobResponse, PipelineInfo

router = APIRouter()


@router.post("/v1/jobs", response_model=JobResponse, status_code=202)
def create_job(body: JobCreate, request: Request) -> JobResponse:
    state = request.app.state
    profile = state.profiles.get(body.pipeline)
    if profile is None:
        raise HTTPException(404, f"unknown pipeline: {body.pipeline!r}")

    try:
        cls = resolve_pipeline_class(profile.kind)
    except (KeyError, ImportError) as exc:
        raise HTTPException(500, f"pipeline kind unavailable: {exc}") from exc

    merged = {**profile.defaults, **body.params}
    try:
        cls.Params(**merged)
    except ValidationError as exc:
        raise HTTPException(422, detail=exc.errors(include_url=False)) from exc

    job = state.store.create(pipeline=body.pipeline, params=body.params)
    state.worker.submit(job.id)
    return JobResponse.from_job(job)


@router.get("/v1/jobs/{job_id}", response_model=JobResponse)
def get_job(job_id: str, request: Request) -> JobResponse:
    job = request.app.state.store.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    return JobResponse.from_job(job)


@router.get("/v1/jobs", response_model=list[JobResponse])
def list_jobs(request: Request, limit: int = 50) -> list[JobResponse]:
    return [JobResponse.from_job(j) for j in request.app.state.store.list(limit=limit)]


@router.delete("/v1/jobs/{job_id}")
def cancel_job(job_id: str, request: Request) -> dict[str, str]:
    state = request.app.state
    job = state.store.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    if job.state in TERMINAL_STATES:
        raise HTTPException(409, f"job already {job.state}")
    result = state.worker.cancel(job_id)
    if result is None:
        # Raced into a terminal state between the check and the cancel.
        job = state.store.get(job_id)
        raise HTTPException(409, f"job already {job.state}")
    return {"id": job_id, "state": result}


@router.get("/v1/pipelines", response_model=list[PipelineInfo])
def list_pipelines(request: Request) -> list[PipelineInfo]:
    out = []
    for name, profile in request.app.state.profiles.items():
        try:
            cls = resolve_pipeline_class(profile.kind)
        except (KeyError, ImportError):
            continue  # profile whose deps aren't installed — hide rather than 500
        out.append(
            PipelineInfo(
                name=name,
                kind=profile.kind,
                defaults=profile.defaults,
                params_schema=cls.params_schema(),
            )
        )
    return out


@router.post("/v1/pipelines/{name}/load", status_code=202)
def load_pipeline(name: str, request: Request) -> dict[str, str | None]:
    """Warmup: queue a pipeline load so the first job doesn't pay the cost.
    Runs on the worker thread, serialized behind any queued jobs."""
    state = request.app.state
    if name not in state.profiles:
        raise HTTPException(404, f"unknown pipeline: {name!r}")
    state.worker.warmup(name)
    return {
        "pipeline": name,
        "state": "load_queued",
        "loaded_pipeline": state.worker.loaded_pipeline,
        "activity": state.worker.activity,
    }


@router.post("/v1/pipelines/{name}/unload", status_code=202)
def unload_pipeline(name: str, request: Request) -> dict[str, str | None]:
    """Queue an unload of `name` (no-op if it isn't the loaded pipeline)."""
    state = request.app.state
    if name not in state.profiles:
        raise HTTPException(404, f"unknown pipeline: {name!r}")
    state.worker.offload(name)
    return {
        "pipeline": name,
        "state": "unload_queued",
        "loaded_pipeline": state.worker.loaded_pipeline,
        "activity": state.worker.activity,
    }


@router.get("/v1/outputs/{job_id}/{filename}")
def get_output(job_id: str, filename: str, request: Request) -> FileResponse:
    path = resolve_output_file(request.app.state.settings.outputs_dir, job_id, filename)
    if path is None:
        raise HTTPException(404, "file not found")
    return FileResponse(path)


@router.get("/health", response_model=HealthResponse)
def health(request: Request) -> HealthResponse:
    state = request.app.state
    return HealthResponse(
        status="ok",
        device=state.settings.resolve_device(),
        offload=state.settings.offload,
        attention=state.settings.attention,
        dtype=state.settings.dtype,
        loaded_pipeline=state.worker.loaded_pipeline,
        activity=state.worker.activity,
        queue_depth=state.store.queue_depth(),
    )
