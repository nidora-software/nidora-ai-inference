from __future__ import annotations

from nidora_ai_inference.core.jobs import JobState, JobStore


def make_store(tmp_path):
    return JobStore(tmp_path / "jobs.sqlite3")


def test_create_and_get(tmp_path):
    store = make_store(tmp_path)
    job = store.create("mock", {"prompt": "hi"})
    got = store.get(job.id)
    assert got is not None
    assert got.pipeline == "mock"
    assert got.params == {"prompt": "hi"}
    assert got.state == JobState.QUEUED
    assert got.created_at


def test_state_transitions_and_cas(tmp_path):
    store = make_store(tmp_path)
    job = store.create("mock", {})

    assert store.set_state(job.id, JobState.RUNNING, expect=JobState.QUEUED)
    assert store.get(job.id).started_at is not None
    # CAS fails when state doesn't match
    assert not store.set_state(job.id, JobState.RUNNING, expect=JobState.QUEUED)

    assert store.set_state(job.id, JobState.COMPLETED, artifacts=[{"url": "/x", "media_type": "v"}])
    got = store.get(job.id)
    assert got.state == JobState.COMPLETED
    assert got.finished_at is not None
    assert got.progress == 1.0
    assert got.artifacts == [{"url": "/x", "media_type": "v"}]


def test_progress_clamped(tmp_path):
    store = make_store(tmp_path)
    job = store.create("mock", {})
    store.set_progress(job.id, 1.7)
    assert store.get(job.id).progress == 1.0
    store.set_progress(job.id, -0.2)
    assert store.get(job.id).progress == 0.0


def test_recover_on_startup(tmp_path):
    store = make_store(tmp_path)
    running = store.create("mock", {})
    queued = store.create("mock", {})
    store.set_state(running.id, JobState.RUNNING)

    requeue = store.recover_on_startup()
    assert requeue == [queued.id]
    recovered = store.get(running.id)
    assert recovered.state == JobState.FAILED
    assert "restart" in recovered.error


def test_queue_depth(tmp_path):
    store = make_store(tmp_path)
    a = store.create("mock", {})
    store.create("mock", {})
    assert store.queue_depth() == 2
    store.set_state(a.id, JobState.COMPLETED)
    assert store.queue_depth() == 1
