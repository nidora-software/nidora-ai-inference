"""Job execution: what the agent sends to SGLang and what it reports back."""

from __future__ import annotations

import asyncio
import hashlib

import httpx
import pytest

from conftest import assignment, make_config, serve
from nidora_agent.runner import Assignment, JobState, Runner
from nidora_agent.sglang import SglangClient


async def run_one(fake_gateway, fake_sglang, raw=None, **config_overrides):
    async with serve(fake_gateway.app) as gateway_url, serve(fake_sglang.app) as sglang_url:
        config = make_config(gateway_url, sglang_url, **config_overrides)
        runner = Runner(
            config.gateway_url,
            config.headers,
            SglangClient(config.sglang_url, config.sglang_poll_interval_s),
            job_timeout_s=config.job_timeout_s,
            upload_attempts=config.upload_attempts,
        )
        state = JobState(assignment=Assignment.from_payload(raw or assignment()))
        async with httpx.AsyncClient() as client:
            result = await runner.run(client, state)
        return result, state


async def test_happy_path_forwards_the_resolved_fields_verbatim(fake_gateway, fake_sglang):
    fake_sglang.clip = b"a generated clip"
    result, _ = await run_one(fake_gateway, fake_sglang)

    assert result["state"] == "completed"
    assert result["bytes"] == len(fake_sglang.clip)
    assert result["sha256"] == hashlib.sha256(fake_sglang.clip).hexdigest()

    # The agent is a dumb executor: every generation parameter must arrive
    # exactly as the gateway resolved it, with nothing invented pod-side.
    assert len(fake_sglang.submissions) == 1
    sent = fake_sglang.submissions[0]
    assert sent["prompt"] == "a woman smiles"
    assert sent["negative_prompt"] == "blurry"
    assert sent["size"] == "464x832"
    assert sent["seconds"] == "5"
    assert sent["num_inference_steps"] == "4"
    assert sent["guidance_scale"] == "1.0"
    assert sent["input_bytes"] == len(fake_gateway.image)

    assert len(fake_gateway.uploads) == 1
    upload = fake_gateway.uploads[0]
    assert upload["bytes"] == len(fake_sglang.clip)
    # The declared checksum must match the bytes actually sent, or the gateway
    # cannot detect a truncated upload.
    assert upload["declared_sha256"] == upload["sha256"]


async def test_seed_is_forwarded_when_the_gateway_sets_one(fake_gateway, fake_sglang):
    await run_one(fake_gateway, fake_sglang, raw=assignment(seed=1234))
    assert fake_sglang.submissions[0]["seed"] == "1234"


async def test_server_error_is_reported_as_retryable(fake_gateway, fake_sglang):
    # A 5xx means this pod is unwell; another one is worth trying.
    fake_sglang.create_status = 500
    result, _ = await run_one(fake_gateway, fake_sglang)
    assert result["state"] == "failed"
    assert result["retryable"] is True
    assert fake_gateway.uploads == []


async def test_client_error_is_reported_as_not_retryable(fake_gateway, fake_sglang):
    # A 422 means the request itself is wrong. Retrying elsewhere would fail
    # identically and burn the client's 20-minute deadline doing it.
    fake_sglang.create_status = 422
    result, _ = await run_one(fake_gateway, fake_sglang)
    assert result["state"] == "failed"
    assert result["retryable"] is False


async def test_content_download_failure_is_retryable(fake_gateway, fake_sglang):
    fake_sglang.content_status = 503
    result, _ = await run_one(fake_gateway, fake_sglang)
    assert result["state"] == "failed"
    assert result["retryable"] is True


async def test_upload_is_retried_then_succeeds(fake_gateway, fake_sglang):
    fake_gateway.upload_failures = 2
    result, _ = await run_one(fake_gateway, fake_sglang)
    assert result["state"] == "completed"
    assert len(fake_gateway.uploads) == 3


async def test_result_is_only_reported_after_the_upload_lands(fake_gateway, fake_sglang):
    # A completed job whose bytes never arrived would 404 on download, so the
    # agent must never claim success before the upload returns 2xx.
    fake_gateway.upload_status = 400
    result, _ = await run_one(fake_gateway, fake_sglang, upload_attempts=1)
    assert result["state"] == "failed"


async def test_cancel_stops_generation_and_cancels_upstream(fake_gateway, fake_sglang):
    fake_sglang.delay_s = 5.0

    async with serve(fake_gateway.app) as gateway_url, serve(fake_sglang.app) as sglang_url:
        config = make_config(gateway_url, sglang_url)
        runner = Runner(
            config.gateway_url,
            config.headers,
            SglangClient(config.sglang_url, 0.01),
            job_timeout_s=30,
            upload_attempts=1,
        )
        state = JobState(assignment=Assignment.from_payload(assignment()))

        async with httpx.AsyncClient() as client:
            task = asyncio.create_task(runner.run(client, state))
            # Let it get as far as submitting to sglang, then cancel.
            for _ in range(200):
                if state.upstream_id:
                    break
                await asyncio.sleep(0.01)
            state.cancelled.set()
            result = await asyncio.wait_for(task, timeout=10)

    assert result["state"] == "cancelled"
    assert fake_gateway.uploads == []
    assert fake_sglang.cancels == [state.upstream_id]


async def test_a_timed_out_job_fails_rather_than_hanging(fake_gateway, fake_sglang):
    fake_sglang.delay_s = 60.0
    result, _ = await run_one(fake_gateway, fake_sglang, job_timeout_s=0)
    assert result["state"] == "failed"
    assert "timed out" in result["error"]


async def test_a_corrupt_input_is_caught_by_its_checksum(fake_gateway, fake_sglang):
    raw = assignment()
    raw["input"]["sha256"] = "0" * 64
    result, _ = await run_one(fake_gateway, fake_sglang, raw=raw)
    assert result["state"] == "failed"
    assert result["retryable"] is True
    assert fake_sglang.submissions == []
