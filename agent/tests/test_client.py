"""The poll loop: readiness reporting, resilience, and lease handling."""

from __future__ import annotations

import asyncio

import httpx

from conftest import assignment, make_config, serve
from nidora_agent.client import Agent
from nidora_agent.config import detect_pod_id, load_config


async def drive(agent: Agent, cycles: int = 1) -> None:
    """Run a bounded number of poll cycles instead of the endless loop."""
    async with httpx.AsyncClient() as client:
        for _ in range(cycles):
            await agent._cycle(client)
        # Let any job tasks the cycle spawned finish.
        if agent.tasks:
            await asyncio.wait(set(agent.tasks.values()), timeout=15)


async def test_reports_sglang_as_not_ready_while_the_model_loads(fake_gateway, fake_sglang):
    # This is the gate that stops the gateway sending work to a pod that is
    # still loading a 14B model, or is OOM-looping and never will be ready.
    fake_sglang.ready = False

    async with serve(fake_gateway.app) as gw, serve(fake_sglang.app) as sg:
        agent = Agent(make_config(gw, sg))
        await drive(agent)
        assert fake_gateway.polls[-1]["sglang_ready"] is False

        fake_sglang.ready = True
        await drive(agent)
        assert fake_gateway.polls[-1]["sglang_ready"] is True


async def test_advertises_its_capabilities_on_every_poll(fake_gateway, fake_sglang):
    async with serve(fake_gateway.app) as gw, serve(fake_sglang.app) as sg:
        agent = Agent(make_config(gw, sg, max_in_flight=2))
        await drive(agent)

    poll = fake_gateway.polls[0]
    assert poll["pod_id"] == "pod-test"
    assert poll["max_in_flight"] == 2
    assert poll["model_path"] == "Wan-AI/Wan2.2-I2V-A14B-Diffusers"
    assert poll["gpu"] == "mock-gpu"


async def test_runs_an_assigned_job_end_to_end(fake_gateway, fake_sglang):
    fake_gateway.script = [{"assign": [assignment()]}, {}]

    async with serve(fake_gateway.app) as gw, serve(fake_sglang.app) as sg:
        agent = Agent(make_config(gw, sg))
        await drive(agent, cycles=1)

    assert len(fake_gateway.results) == 1
    assert fake_gateway.results[0]["state"] == "completed"
    assert fake_gateway.results[0]["lease_id"] == "lease-1"


async def test_reports_in_flight_jobs_so_the_gateway_can_renew_the_lease(fake_gateway, fake_sglang):
    fake_sglang.delay_s = 5.0
    fake_gateway.script = [{"assign": [assignment()]}, {}]

    async with serve(fake_gateway.app) as gw, serve(fake_sglang.app) as sg:
        agent = Agent(make_config(gw, sg))
        async with httpx.AsyncClient() as client:
            await agent._cycle(client)          # picks the job up
            for _ in range(200):                 # let it reach the generating phase
                if agent.jobs and agent.jobs["j_1"].upstream_id:
                    break
                await asyncio.sleep(0.01)
            await agent._cycle(client)          # the poll that renews

            in_flight = fake_gateway.polls[-1]["in_flight"]
            assert len(in_flight) == 1
            assert in_flight[0]["job_id"] == "j_1"
            assert in_flight[0]["lease_id"] == "lease-1"
            assert in_flight[0]["phase"] == "generating"

            for state in agent.jobs.values():
                state.cancelled.set()
            if agent.tasks:
                await asyncio.wait(set(agent.tasks.values()), timeout=10)


async def test_abandons_a_job_the_gateway_declares_orphaned(fake_gateway, fake_sglang):
    # An orphaned job may already have been completed by another pod; finishing
    # and uploading ours would clobber the real result.
    fake_sglang.delay_s = 5.0
    fake_gateway.script = [{"assign": [assignment()]}, {"orphan": ["j_1"]}]

    async with serve(fake_gateway.app) as gw, serve(fake_sglang.app) as sg:
        agent = Agent(make_config(gw, sg))
        async with httpx.AsyncClient() as client:
            await agent._cycle(client)
            for _ in range(200):
                if agent.jobs and agent.jobs["j_1"].upstream_id:
                    break
                await asyncio.sleep(0.01)
            await agent._cycle(client)
            assert agent.jobs["j_1"].cancelled.is_set()
            await asyncio.wait(set(agent.tasks.values()), timeout=10)

    assert fake_gateway.uploads == []


async def test_the_loop_survives_an_unreachable_gateway(fake_gateway, fake_sglang):
    async with serve(fake_sglang.app) as sg:
        # Point at a port with nothing listening.
        agent = Agent(make_config("http://127.0.0.1:1", sg))

        async def stop_soon():
            await asyncio.sleep(0.3)
            agent.stop()

        asyncio.create_task(stop_soon())
        # Must return cleanly rather than raising out of the loop.
        await asyncio.wait_for(agent.run(), timeout=10)


async def test_a_duplicate_assignment_is_ignored(fake_gateway, fake_sglang):
    fake_sglang.delay_s = 5.0
    fake_gateway.script = [{"assign": [assignment()]}, {"assign": [assignment()]}]

    async with serve(fake_gateway.app) as gw, serve(fake_sglang.app) as sg:
        agent = Agent(make_config(gw, sg))
        async with httpx.AsyncClient() as client:
            await agent._cycle(client)
            await agent._cycle(client)
            assert len(agent.tasks) == 1
            for state in agent.jobs.values():
                state.cancelled.set()
            await asyncio.wait(set(agent.tasks.values()), timeout=10)

    assert len(fake_sglang.submissions) == 1


def test_pod_id_prefers_a_provider_assigned_identity(monkeypatch):
    # A hostname that changes per boot would orphan the pod's own jobs.
    monkeypatch.delenv("POD_ID", raising=False)
    monkeypatch.setenv("RUNPOD_POD_ID", "runpod-xyz")
    assert detect_pod_id() == "runpod-xyz"

    monkeypatch.setenv("POD_ID", "explicit")
    assert detect_pod_id() == "explicit"


def test_config_requires_a_secret_when_a_gateway_is_configured():
    import pytest

    with pytest.raises(SystemExit):
        load_config({"GATEWAY_URL": "https://inference.example.com"})


def test_access_headers_are_sent_only_when_both_halves_are_present():
    cfg = load_config(
        {
            "GATEWAY_URL": "https://inference.example.com",
            "GATEWAY_AGENT_SECRET": "s",
            "CF_ACCESS_CLIENT_ID": "id.access",
            "CF_ACCESS_CLIENT_SECRET": "sec",
        }
    )
    assert cfg.headers["CF-Access-Client-Id"] == "id.access"
    assert cfg.headers["CF-Access-Client-Secret"] == "sec"

    partial = load_config(
        {
            "GATEWAY_URL": "https://inference.example.com",
            "GATEWAY_AGENT_SECRET": "s",
            "CF_ACCESS_CLIENT_ID": "id.access",
        }
    )
    assert "CF-Access-Client-Id" not in partial.headers
