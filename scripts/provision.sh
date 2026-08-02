#!/usr/bin/env bash
# Provisioning script for rented GPU pods (RunPod / vast.ai).
# Idempotent: safe to run on every boot.
#
# Env (all optional):
#   NIDORA_REPO       git URL to clone when the repo isn't baked into the image
#   NIDORA_APP_DIR    where the repo lives            (default /workspace/nidora-ai-inference)
#   NIDORA_MODELS_DIR where weights go                (default /workspace/models)
#   HF_TOKEN          HuggingFace token for gated repos
set -euo pipefail

APP_DIR="${NIDORA_APP_DIR:-/workspace/nidora-ai-inference}"
export NIDORA_MODELS_DIR="${NIDORA_MODELS_DIR:-/workspace/models}"
export NIDORA_OUTPUTS_DIR="${NIDORA_OUTPUTS_DIR:-/workspace/outputs}"
export NIDORA_DB_PATH="${NIDORA_DB_PATH:-/workspace/jobs.sqlite3}"
export HF_HUB_ENABLE_HF_TRANSFER=1

# 1. Code
if [ ! -d "$APP_DIR" ]; then
    if [ -z "${NIDORA_REPO:-}" ]; then
        echo "ERROR: $APP_DIR missing and NIDORA_REPO not set" >&2
        exit 1
    fi
    git clone --depth 1 "$NIDORA_REPO" "$APP_DIR"
else
    git -C "$APP_DIR" pull --ff-only || true
fi
cd "$APP_DIR"

# 2. uv + dependencies (accel extra only when CUDA is present)
if ! command -v uv >/dev/null 2>&1; then
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$HOME/.local/bin:$PATH"
fi
if command -v nvidia-smi >/dev/null 2>&1; then
    uv sync --extra accel
else
    uv sync
fi

# 3. Models (idempotent — snapshot_download skips complete files)
uv run nidora-ai-inference download --all

# 4. Serve
exec uv run nidora-ai-inference serve
