#!/usr/bin/env bash
# Container entrypoint. Supervises two processes:
#
#   sglang serve   the diffusion server, on loopback
#   nidora_agent   the pull agent that dials out to the gateway
#
# A pod is only ever a member of a gateway fleet: it publishes no port, runs no
# tunnel, and needs no DNS record. sglang's diffusion server has NO built-in
# auth (verified against v0.5.16 source), which is why it stays on 127.0.0.1
# and the agent is the only thing that talks to it.
#
# Environment:
#   MODEL_PATH             REQUIRED — HF repo id or local path (no default)
#   GATEWAY_URL            REQUIRED — e.g. https://<your-hostname>
#   GATEWAY_AGENT_SECRET   REQUIRED — matches the gateway's AGENT_SHARED_SECRET
#   LORA_PATH              optional — LoRA repo id/path; unset = no LoRA
#   PORT                   default 8000
#   SGLANG_HOST            default 127.0.0.1 — only change to debug from the host
#   SGLANG_EXTRA_ARGS      extra `sglang serve` flags appended verbatim
#                          (attention backend, offload, torch compile, parallelism)
#   POD_ID                 optional: stable pod identity
#                          (see agent/src/nidora_agent/config.py)
#   AGENT_MAX_IN_FLIGHT    default 1
#   CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET  Access service token for the gateway
#
# `--warmup-mode server` is the CLI's own default for `serve`; not repeated here.
set -uo pipefail

PORT="${PORT:-8000}"
SGLANG_HOST="${SGLANG_HOST:-127.0.0.1}"

for var in MODEL_PATH GATEWAY_URL GATEWAY_AGENT_SECRET; do
    if [ -z "${!var:-}" ]; then
        echo "[entrypoint] ERROR: $var is required" >&2
        exit 1
    fi
done

if [ "$SGLANG_HOST" != "127.0.0.1" ] && [ "$SGLANG_HOST" != "localhost" ]; then
    echo "[entrypoint] WARNING: SGLANG_HOST=$SGLANG_HOST — sglang is listening beyond loopback"
    echo "[entrypoint]          with no auth. Nothing outside the pod needs to reach it."
fi

# --- process supervision -----------------------------------------------------
# `exec`ing sglang would replace this shell and leave nothing to supervise the
# agent. Instead every child is tracked, and the first one to exit takes the
# whole container down: a pod that has lost its agent is not usable, and a clean
# exit lets the provider restart it.

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
echo "[entrypoint] pulling jobs from ${GATEWAY_URL}"
start agent python -m nidora_agent

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
