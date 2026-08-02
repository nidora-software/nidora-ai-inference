from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from nidora_ai_inference.app import create_app
from nidora_ai_inference.core.config import Settings

KEY = "test-secret-key"


@pytest.fixture
def auth_client(settings: Settings) -> Iterator[TestClient]:
    app = create_app(settings.model_copy(update={"api_key": KEY}))
    with TestClient(app) as c:
        yield c


def test_v1_rejected_without_key(auth_client):
    assert auth_client.get("/v1/pipelines").status_code == 401
    assert auth_client.post("/v1/jobs", json={"pipeline": "mock", "params": {}}).status_code == 401
    assert auth_client.get("/v1/jobs/j_x").status_code == 401
    assert auth_client.get("/v1/outputs/j_x/output.mp4").status_code == 401


def test_v1_rejected_with_wrong_key(auth_client):
    assert auth_client.get("/v1/pipelines", headers={"X-Api-Key": "nope"}).status_code == 401


def test_v1_accepted_with_header_key(auth_client):
    assert auth_client.get("/v1/pipelines", headers={"X-Api-Key": KEY}).status_code == 200


def test_v1_accepted_with_bearer(auth_client):
    res = auth_client.get("/v1/pipelines", headers={"Authorization": f"Bearer {KEY}"})
    assert res.status_code == 200


def test_health_open_without_key(auth_client):
    assert auth_client.get("/health").status_code == 200


def test_job_flow_with_key(auth_client):
    headers = {"X-Api-Key": KEY}
    res = auth_client.post("/v1/jobs", json={"pipeline": "mock", "params": {}}, headers=headers)
    assert res.status_code == 202


def test_no_key_configured_means_open(client):
    # The base fixture has no api_key — everything works unauthenticated.
    assert client.get("/v1/pipelines").status_code == 200
