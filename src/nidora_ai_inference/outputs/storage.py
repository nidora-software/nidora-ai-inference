"""Output directory layout and artifact URL building.

Layout: {outputs_dir}/{job_id}/{filename}. URLs are served by the API's
/v1/outputs endpoint; swapping in S3 later only touches this module.
"""

from __future__ import annotations

from pathlib import Path

from ..pipelines.base import Artifact


def job_output_dir(outputs_dir: Path, job_id: str) -> Path:
    d = outputs_dir / job_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def artifact_url(job_id: str, artifact: Artifact) -> str:
    return f"/v1/outputs/{job_id}/{artifact.path.name}"


def artifact_records(job_id: str, artifacts: list[Artifact]) -> list[dict[str, str]]:
    return [
        {"url": artifact_url(job_id, a), "media_type": a.media_type, "filename": a.path.name}
        for a in artifacts
    ]


def resolve_output_file(outputs_dir: Path, job_id: str, filename: str) -> Path | None:
    """Safely resolve a served file, refusing path traversal."""
    base = (outputs_dir / job_id).resolve()
    candidate = (base / filename).resolve()
    if candidate.parent != base or not candidate.is_file():
        return None
    return candidate
