#!/usr/bin/env bash
# Container entrypoint: optional Cloudflare Tunnel + `sglang serve`.
#
# Environment:
#   MODEL_PATH         REQUIRED — HF repo id or local path (no default)
#   LORA_PATH          default lightx2v/Wan2.2-Distill-Loras ("none" disables)
#   PORT               default 8000
#   CF_TUNNEL_TOKEN    optional: Cloudflare Tunnel for a stable HTTPS hostname
#   SGLANG_EXTRA_ARGS  extra `sglang serve` flags appended verbatim
#                      (attention backend, offload, torch compile, parallelism)
#
# SECURITY: sglang's diffusion server has NO built-in auth (verified against
# v0.5.16 source). Do not expose the port publicly — run tunnel-only and put
# Cloudflare Access (service token) in front of the hostname.
# `--warmup-mode server` is the CLI's own default for `serve`; not repeated here.
set -euo pipefail

PORT="${PORT:-8000}"

if [ -z "${MODEL_PATH:-}" ]; then
    echo "[entrypoint] ERROR: MODEL_PATH is required (e.g. MODEL_PATH=Wan-AI/Wan2.2-I2V-A14B-Diffusers)" >&2
    exit 1
fi

if [ -n "${CF_TUNNEL_TOKEN:-}" ]; then
    echo "[entrypoint] starting cloudflared tunnel (public hostname -> localhost:${PORT})"
    cloudflared tunnel --no-autoupdate run --token "$CF_TUNNEL_TOKEN" &
else
    echo "[entrypoint] WARNING: no CF_TUNNEL_TOKEN — remember the API has no built-in auth;"
    echo "[entrypoint]          only expose the port on trusted networks"
fi

args=(
    --model-path "$MODEL_PATH"
    --host 0.0.0.0
    --port "$PORT"
)

LORA_PATH="${LORA_PATH:-lightx2v/Wan2.2-Distill-Loras}"
if [ "$LORA_PATH" != "none" ]; then
    args+=(--lora-path "$LORA_PATH")
fi

# shellcheck disable=SC2086 — word splitting of extra args is intentional
exec sglang serve "${args[@]}" ${SGLANG_EXTRA_ARGS:-} "$@"
