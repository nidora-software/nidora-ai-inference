from __future__ import annotations

from conftest import wait_for_state


def test_list_pipelines(client):
    res = client.get("/v1/pipelines")
    assert res.status_code == 200
    pipelines = {p["name"]: p for p in res.json()}
    assert "mock" in pipelines
    assert pipelines["mock"]["kind"] == "mock"
    assert pipelines["mock"]["defaults"]["num_frames"] == 4
    assert "properties" in pipelines["mock"]["params_schema"]


def test_health(client):
    res = client.get("/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert body["device"] == "cpu"
    assert "activity" in body


def test_auto_warmup_on_startup(client):
    # NIDORA_WARMUP defaults to "auto": the first profile loads at boot.
    import time

    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if client.get("/health").json()["loaded_pipeline"] == "mock":
            break
        time.sleep(0.02)
    assert client.get("/health").json()["loaded_pipeline"] == "mock"


def test_pipeline_load_and_unload(client):
    import time

    res = client.post("/v1/pipelines/mock/load")
    assert res.status_code == 202
    assert res.json()["state"] == "load_queued"

    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if client.get("/health").json()["loaded_pipeline"] == "mock":
            break
        time.sleep(0.02)
    assert client.get("/health").json()["loaded_pipeline"] == "mock"

    res = client.post("/v1/pipelines/mock/unload")
    assert res.status_code == 202
    assert res.json()["state"] == "unload_queued"

    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if client.get("/health").json()["loaded_pipeline"] is None:
            break
        time.sleep(0.02)
    assert client.get("/health").json()["loaded_pipeline"] is None


def test_pipeline_load_unknown_404(client):
    assert client.post("/v1/pipelines/nope/load").status_code == 404
    assert client.post("/v1/pipelines/nope/unload").status_code == 404


def test_job_end_to_end(client):
    res = client.post("/v1/jobs", json={"pipeline": "mock", "params": {"prompt": "gradient"}})
    assert res.status_code == 202
    job = res.json()
    assert job["state"] == "queued"
    assert job["params"] == {"prompt": "gradient"}

    done = wait_for_state(client, job["id"], {"completed", "failed"})
    assert done["state"] == "completed"
    assert isinstance(done["params"].get("seed"), int)  # effective seed echoed back
    assert done["progress"] == 1.0
    assert len(done["artifacts"]) == 1
    artifact = done["artifacts"][0]
    assert artifact["media_type"] == "video/mp4"

    video = client.get(artifact["url"])
    assert video.status_code == 200
    assert video.headers["content-type"] == "video/mp4"
    assert len(video.content) > 0


def test_job_failure(client):
    res = client.post("/v1/jobs", json={"pipeline": "mock", "params": {"fail": True}})
    job = wait_for_state(client, res.json()["id"], {"completed", "failed"})
    assert job["state"] == "failed"
    assert "mock failure" in job["error"]


def test_unknown_pipeline(client):
    res = client.post("/v1/jobs", json={"pipeline": "nope", "params": {}})
    assert res.status_code == 404


def test_invalid_params(client):
    res = client.post("/v1/jobs", json={"pipeline": "mock", "params": {"num_frames": -5}})
    assert res.status_code == 422


def test_job_not_found(client):
    assert client.get("/v1/jobs/j_missing").status_code == 404


def test_cancel_running_job(client):
    res = client.post(
        "/v1/jobs",
        json={"pipeline": "mock", "params": {"num_frames": 200, "delay_s": 0.1}},
    )
    job_id = res.json()["id"]
    wait_for_state(client, job_id, {"running"})

    cancel = client.delete(f"/v1/jobs/{job_id}")
    assert cancel.status_code == 200
    assert cancel.json()["state"] in {"cancelling", "cancelled"}

    done = wait_for_state(client, job_id, {"cancelled", "completed", "failed"})
    assert done["state"] == "cancelled"


def test_cancel_terminal_job_conflict(client):
    res = client.post("/v1/jobs", json={"pipeline": "mock", "params": {}})
    job_id = res.json()["id"]
    wait_for_state(client, job_id, {"completed"})
    assert client.delete(f"/v1/jobs/{job_id}").status_code == 409


def test_output_path_traversal_blocked(client):
    res = client.post("/v1/jobs", json={"pipeline": "mock", "params": {}})
    job_id = res.json()["id"]
    wait_for_state(client, job_id, {"completed"})
    assert client.get(f"/v1/outputs/{job_id}/..%2F..%2Fjobs.sqlite3").status_code == 404
