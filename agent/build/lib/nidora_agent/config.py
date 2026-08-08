"""Agent configuration, entirely from the environment.

The agent only starts when GATEWAY_URL is set, so a pod launched the old way
(cloudflared + a public SGLang port) behaves exactly as it did before.
"""

from __future__ import annotations

import os
import socket
from dataclasses import dataclass, field

AGENT_VERSION = "0.1.0"


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name, "")
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise SystemExit(f"[agent] {name} must be an integer, got {raw!r}") from exc


def _csv(name: str, default: str) -> list[str]:
    raw = os.environ.get(name) or default
    return [item.strip() for item in raw.split(",") if item.strip()]


def detect_pod_id() -> str:
    """A stable identity across agent restarts.

    Stability matters: the gateway keys in-flight work by pod id, so a pod
    whose id changes on every boot orphans its own jobs instead of reclaiming
    them. Provider-assigned ids are preferred over the hostname for exactly
    that reason.
    """
    for var in ("POD_ID", "RUNPOD_POD_ID", "VAST_CONTAINER_ID", "CONTAINER_ID"):
        value = os.environ.get(var)
        if value:
            return value
    return socket.gethostname()


@dataclass(frozen=True)
class Config:
    gateway_url: str
    agent_secret: str
    pod_id: str
    pipelines: list[str]
    max_in_flight: int
    sglang_url: str
    model_path: str | None
    lora_path: str | None
    gpu: str | None

    poll_wait_s: int
    poll_error_backoff_s: float
    poll_error_backoff_max_s: float
    job_timeout_s: int
    sglang_poll_interval_s: float
    upload_attempts: int

    cf_access_client_id: str | None
    cf_access_client_secret: str | None

    log_level: str

    #: Headers sent on every gateway request.
    headers: dict[str, str] = field(default_factory=dict)


def load_config(env: dict[str, str] | None = None) -> Config:
    env = dict(os.environ if env is None else env)

    gateway_url = (env.get("GATEWAY_URL") or "").rstrip("/")
    if not gateway_url:
        raise SystemExit("[agent] GATEWAY_URL is required")
    secret = env.get("GATEWAY_AGENT_SECRET") or ""
    if not secret:
        raise SystemExit("[agent] GATEWAY_AGENT_SECRET is required when GATEWAY_URL is set")

    headers = {"X-Agent-Secret": secret}
    access_id = env.get("CF_ACCESS_CLIENT_ID")
    access_secret = env.get("CF_ACCESS_CLIENT_SECRET")
    if access_id and access_secret:
        # Cloudflare Access guards the whole hostname with a service-token
        # policy; without these the poll is rejected at the edge, never
        # reaching the gateway.
        headers["CF-Access-Client-Id"] = access_id
        headers["CF-Access-Client-Secret"] = access_secret

    port = env.get("PORT", "8000")
    return Config(
        gateway_url=gateway_url,
        agent_secret=secret,
        pod_id=detect_pod_id(),
        pipelines=_csv("AGENT_PIPELINES", "wan22-i2v"),
        max_in_flight=max(1, _int("AGENT_MAX_IN_FLIGHT", 1)),
        sglang_url=env.get("SGLANG_URL") or f"http://127.0.0.1:{port}",
        model_path=env.get("MODEL_PATH"),
        lora_path=env.get("LORA_PATH"),
        gpu=env.get("AGENT_GPU"),
        poll_wait_s=_int("AGENT_POLL_WAIT_S", 25),
        poll_error_backoff_s=float(env.get("AGENT_BACKOFF_S", "1")),
        poll_error_backoff_max_s=float(env.get("AGENT_BACKOFF_MAX_S", "30")),
        job_timeout_s=_int("AGENT_JOB_TIMEOUT_S", 900),
        sglang_poll_interval_s=float(env.get("AGENT_SGLANG_POLL_S", "2")),
        upload_attempts=_int("AGENT_UPLOAD_ATTEMPTS", 3),
        cf_access_client_id=access_id,
        cf_access_client_secret=access_secret,
        log_level=env.get("AGENT_LOG_LEVEL", "INFO"),
        headers=headers,
    )
