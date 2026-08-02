"""API-level request/response models."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from ..core.jobs import Job


class JobCreate(BaseModel):
    pipeline: str
    params: dict[str, Any] = Field(default_factory=dict)


class ArtifactInfo(BaseModel):
    url: str
    media_type: str
    filename: str | None = None


class JobResponse(BaseModel):
    id: str
    pipeline: str
    state: str
    progress: float = 0.0
    error: str | None = None
    # Submitted params plus server-filled effective values (e.g. random seed).
    params: dict[str, Any] = Field(default_factory=dict)
    artifacts: list[ArtifactInfo] = Field(default_factory=list)
    created_at: str
    started_at: str | None = None
    finished_at: str | None = None

    @classmethod
    def from_job(cls, job: Job) -> JobResponse:
        return cls(
            id=job.id,
            pipeline=job.pipeline,
            state=job.state,
            progress=job.progress,
            error=job.error,
            params=job.params,
            artifacts=[ArtifactInfo(**a) for a in job.artifacts],
            created_at=job.created_at,
            started_at=job.started_at,
            finished_at=job.finished_at,
        )


class PipelineInfo(BaseModel):
    name: str
    kind: str
    defaults: dict[str, Any]
    params_schema: dict[str, Any]


class HealthResponse(BaseModel):
    status: str
    device: str
    offload: str
    attention: str
    dtype: str
    loaded_pipeline: str | None
    queue_depth: int
