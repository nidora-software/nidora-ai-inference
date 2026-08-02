from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from nidora_ai_inference.app import create_app
from nidora_ai_inference.core.config import Settings

PIPELINES_YAML = """
pipelines:
  mock:
    kind: mock
    defaults:
      num_frames: 4
      width: 32
      height: 32
"""

MODELS_YAML = """
models: {}
"""


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    pipelines = tmp_path / "pipelines.yaml"
    pipelines.write_text(PIPELINES_YAML)
    models = tmp_path / "models.yaml"
    models.write_text(MODELS_YAML)
    return Settings(
        models_dir=tmp_path / "models",
        outputs_dir=tmp_path / "outputs",
        db_path=tmp_path / "jobs.sqlite3",
        pipelines_config=pipelines,
        models_config=models,
        device="cpu",
    )


@pytest.fixture
def client(settings: Settings) -> Iterator[TestClient]:
    app = create_app(settings)
    with TestClient(app) as c:
        yield c


def wait_for_state(client: TestClient, job_id: str, states: set[str], timeout: float = 15.0):
    import time

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        job = client.get(f"/v1/jobs/{job_id}").json()
        if job["state"] in states:
            return job
        time.sleep(0.05)
    raise TimeoutError(f"job {job_id} did not reach {states} within {timeout}s: {job}")
