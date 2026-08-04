#!/usr/bin/env bash
# Container entrypoint: optional Cloudflare Tunnel + `sglang serve`.
#
# Environment:
#   MODEL_PATH         default Wan-AI/Wan2.2-I2V-A14B-Diffusers
#   LORA_PATH          default lightx2v/Wan2.2-Distill-Loras ("none" disables)
#   API_KEY            Bearer token required on /v1/* (set on public deployments)
#   PORT               default 8000
#   CF_TUNNEL_TOKEN    optional: Cloudflare Tunnel for a stable HTTPS hostname
#   SGLANG_EXTRA_ARGS  extra `sglang serve` flags appended verbatim
#                      (attention backend, offload, torch compile, parallelism)
set -euo pipefail

PORT="${PORT:-8000}"

if [ -n "${CF_TUNNEL_TOKEN:-}" ]; then
    echo "[entrypoint] starting cloudflared tunnel (public hostname -> localhost:${PORT})"
    cloudflared tunnel --no-autoupdate run --token "$CF_TUNNEL_TOKEN" &
fi

args=(
    --model-path "${MODEL_PATH:-Wan-AI/Wan2.2-I2V-A14B-Diffusers}"
    --host 0.0.0.0
    --port "$PORT"
    --warmup-mode server
)

LORA_PATH="${LORA_PATH:-lightx2v/Wan2.2-Distill-Loras}"
if [ "$LORA_PATH" != "none" ]; then
    args+=(--lora-path "$LORA_PATH")
fi

if [ -n "${API_KEY:-}" ]; then
    args+=(--api-key "$API_KEY")
else
    echo "[entrypoint] WARNING: API_KEY not set — the API is unauthenticated"
fi

# shellcheck disable=SC2086 — word splitting of extra args is intentional
exec sglang serve "${args[@]}" ${SGLANG_EXTRA_ARGS:-} "$@"
