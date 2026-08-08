#!/usr/bin/env bash
# Container entrypoint. Supervises up to three processes:
#
#   sglang serve   always
#   cloudflared    when CF_TUNNEL_TOKEN is set   (standalone/tunnel mode)
#   nidora_agent   when GATEWAY_URL is set       (gateway/fleet mode)
#
# Environment:
#   MODEL_PATH             REQUIRED — HF repo id or local path (no default)
#   LORA_PATH              optional — LoRA repo id/path; unset = no LoRA
#   PORT                   default 8000
#   SGLANG_HOST            default 0.0.0.0 — set 127.0.0.1 in gateway mode
#   CF_TUNNEL_TOKEN        optional: Cloudflare Tunnel for a stable HTTPS hostname
#   SGLANG_EXTRA_ARGS      extra `sglang serve` flags appended verbatim
#                          (attention backend, offload, torch compile, parallelism)
#   GATEWAY_URL            optional: enables the pull agent (e.g. https://<your-hostname>)
#   GATEWAY_AGENT_SECRET   required when GATEWAY_URL is set
#   POD_ID                 optional: stable pod identity (see agent/config.py)
#   AGENT_PIPELINES        default wan22-i2v
#   AGENT_MAX_IN_FLIGHT    default 1
#   CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET  Access service token for the gateway
#
# TWO WAYS TO RUN
#
#   Gateway mode (recommended): GATEWAY_URL set, no CF_TUNNEL_TOKEN, and
#   SGLANG_HOST=127.0.0.1. The agent dials out to the gateway and pulls work.
#   Nothing on the pod is reachable from outside — no port, no tunnel, no DNS.
#
#   Standalone mode (the original): CF_TUNNEL_TOKEN set, no GATEWAY_URL. The
#   pod is its own public endpoint. sglang's diffusion server has NO built-in
#   auth (verified against v0.5.16 source), so the hostname MUST be protected
#   by Cloudflare Access and the port MUST NOT be published.
#
# `--warmup-mode server` is the CLI's own default for `serve`; not repeated here.
set -uo pipefail

PORT="${PORT:-8000}"
SGLANG_HOST="${SGLANG_HOST:-0.0.0.0}"

if [ -z "${MODEL_PATH:-}" ]; then
    echo "[entrypoint] ERROR: MODEL_PATH is required (e.g. MODEL_PATH=Wan-AI/Wan2.2-I2V-A14B-Diffusers)" >&2
    exit 1
fi

if [ -n "${GATEWAY_URL:-}" ] && [ -z "${GATEWAY_AGENT_SECRET:-}" ]; then
    echo "[entrypoint] ERROR: GATEWAY_AGENT_SECRET is required when GATEWAY_URL is set" >&2
    exit 1
fi

if [ -z "${GATEWAY_URL:-}" ] && [ -z "${CF_TUNNEL_TOKEN:-}" ]; then
    echo "[entrypoint] WARNING: neither GATEWAY_URL nor CF_TUNNEL_TOKEN is set — the API has"
    echo "[entrypoint]          no built-in auth; only expose the port on trusted networks"
fi

if [ -n "${GATEWAY_URL:-}" ] && [ "$SGLANG_HOST" = "0.0.0.0" ]; then
    echo "[entrypoint] NOTE: gateway mode with SGLANG_HOST=0.0.0.0 — sglang is listening on all"
    echo "[entrypoint]       interfaces with no auth. Set SGLANG_HOST=127.0.0.1 unless a"
    echo "[entrypoint]       published port is genuinely needed."
fi

# --- process supervision -----------------------------------------------------
# `exec`ing sglang would replace this shell and leave nothing to supervise the
# agent. Instead every child is tracked, and the first one to exit takes the
# whole container down: a pod that has lost its agent (or its tunnel) is not
# usable, and a clean exit lets the provider restart it.

pids=()
names=()

start() {
    local name="$1"
    shift
    "$@" &
    pids+=("$!")
    names+=("$name")
    echo "[entrypoint] started $name (pid $!)"
}

terminate_all() {
    # Guard the empty case: a signal arriving before any child starts would
    # otherwise expand an empty array under `set -u` on bash < 4.4.
    [ "${#pids[@]}" -eq 0 ] && return 0
    for pid in "${pids[@]}"; do
        kill -TERM "$pid" 2>/dev/null || true
    done
}

on_signal() {
    trap - TERM INT
    echo "[entrypoint] signal received — stopping children"
    terminate_all
    wait
    exit 0
}
trap on_signal TERM INT

# The tunnel comes up first so the hostname is reachable the moment sglang is.
if [ -n "${CF_TUNNEL_TOKEN:-}" ]; then
    echo "[entrypoint] cloudflared tunnel -> localhost:${PORT}"
    start cloudflared cloudflared tunnel --no-autoupdate run --token "$CF_TUNNEL_TOKEN"
fi

args=(
    --model-path "$MODEL_PATH"
    --host "$SGLANG_HOST"
    --port "$PORT"
)

if [ -n "${LORA_PATH:-}" ]; then
    args+=(--lora-path "$LORA_PATH")
fi

# Word splitting of SGLANG_EXTRA_ARGS is intentional: it carries multiple flags.
# (Prose must stay off the directive line — shellcheck errors on anything it
# cannot parse as key=value there.)
# shellcheck disable=SC2086
start sglang sglang serve "${args[@]}" ${SGLANG_EXTRA_ARGS:-} "$@"

# The agent starts immediately and reports sglang as not-ready until its health
# check passes, so the gateway withholds work during the ~10 minute model load.
if [ -n "${GATEWAY_URL:-}" ]; then
    echo "[entrypoint] gateway mode: pulling jobs from ${GATEWAY_URL}"
    start agent python -m nidora_agent
fi

# Wait for the first child to exit.
#
# Polled with `kill -0` rather than `wait -n`: it names the process that died,
# which is the entire post-mortem when a pod dies at 3am, and it works on
# bash 3.2 so the supervisor is testable outside the CUDA image. A couple of
# seconds of detection latency is irrelevant for process supervision.
SUPERVISE_INTERVAL="${SUPERVISE_INTERVAL:-2}"
while :; do
    for i in $(seq 0 $((${#pids[@]} - 1))); do
        if ! kill -0 "${pids[$i]}" 2>/dev/null; then
            failed="${names[$i]}"
            wait "${pids[$i]}"
            status=$?
            echo "[entrypoint] $failed exited (status=$status) — stopping the container" >&2
            terminate_all
            wait
            exit "$status"
        fi
    done
    sleep "$SUPERVISE_INTERVAL"
done
