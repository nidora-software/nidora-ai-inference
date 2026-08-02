#!/usr/bin/env bash
# Container entrypoint:
#   * optional Cloudflare Tunnel (NIDORA_CF_TUNNEL_TOKEN) — stable HTTPS
#     hostname regardless of provider IP/port
#   * SageAttention self-provisioning (NIDORA_BUILD_SAGE=0 disables): install
#     from the volume wheel cache, or build once in the background for this
#     pod's GPU arch, cache the wheel, and hot-reload the pipeline via the
#     API so the running server picks sage up without a restart.
set -euo pipefail

log() { echo "[entrypoint] $*"; }

if [ -n "${NIDORA_CF_TUNNEL_TOKEN:-}" ]; then
    log "starting cloudflared tunnel (public hostname -> localhost:8000)"
    cloudflared tunnel --no-autoupdate run --token "$NIDORA_CF_TUNNEL_TOKEN" &
fi

SAGE_REF="${NIDORA_SAGE_REF:-v2.2.0}"

sage_ok() {
    python - <<'EOF' 2>/dev/null
import sys
from importlib.metadata import version
from packaging.version import Version
sys.exit(0 if Version(version("sageattention")) >= Version("2.1.1") else 1)
EOF
}

gpu_cap() {
    python -c "import torch; print('%d%d' % torch.cuda.get_device_capability())" 2>/dev/null
}

install_cached_wheel() {
    local wheel
    wheel=$(ls -t "$1"/sageattention-*.whl 2>/dev/null | head -1)
    [ -n "$wheel" ] || return 1
    log "installing cached SageAttention wheel: $wheel"
    pip install --no-cache-dir --quiet "$wheel"
}

build_sage() { # $1 = wheel cache dir for this GPU arch
    mkdir -p "$1"
    local blog="$1/build.log" # persisted on the volume for post-mortems
    : >"$blog"
    if ! command -v g++ >/dev/null 2>&1; then
        log "installing g++ (one-time)..."
        { apt-get update -qq && apt-get install -y -qq --no-install-recommends g++; } \
            >>"$blog" 2>&1 || { log "g++ install failed — see $blog"; return 1; }
    fi
    if ! command -v nvcc >/dev/null 2>&1; then
        # Full toolkit, not piecemeal packages: torch's headers pull in
        # cusparse.h/cublas_v2.h/cuda_fp16.h etc., and hand-picking dev
        # packages keeps missing one. Pinned to the image's CUDA 12.9.
        log "installing CUDA toolkit 12.9 (conda, one-time, ~3-5 min)..."
        conda install -y -q -c nvidia cuda-toolkit=12.9 \
            >>"$blog" 2>&1 || { log "cuda-toolkit install failed — see $blog"; return 1; }
    fi
    # conda parks CUDA headers/libs under targets/; torch's extension build
    # only searches $CUDA_HOME/include, so widen the compiler search paths.
    export CUDA_HOME="${CUDA_HOME:-/opt/conda}"
    export CPATH="/opt/conda/targets/x86_64-linux/include${CPATH:+:$CPATH}"
    export LIBRARY_PATH="/opt/conda/targets/x86_64-linux/lib${LIBRARY_PATH:+:$LIBRARY_PATH}"
    local src
    src=$(mktemp -d)
    log "fetching SageAttention ${SAGE_REF}..."
    curl -LsSf "https://github.com/thu-ml/SageAttention/archive/refs/tags/${SAGE_REF}.tar.gz" \
        | tar xz -C "$src" --strip-components=1 || { log "fetch failed"; return 1; }
    pip install --no-cache-dir --quiet ninja packaging wheel >>"$blog" 2>&1
    # No TORCH_CUDA_ARCH_LIST: setup.py detects the local GPU and compiles
    # only its arch — ~5x less work than a fat multi-arch wheel. Low default
    # parallelism: the build overlaps the model load's ~40 GB RAM footprint.
    local jobs="${NIDORA_SAGE_MAX_JOBS:-2}"
    log "compiling SageAttention for this GPU (MAX_JOBS=$jobs, ~5-20 min; log: $blog)..."
    (cd "$src" && MAX_JOBS="$jobs" python setup.py bdist_wheel) >>"$blog" 2>&1 || {
        log "compile FAILED — compiler errors from $blog:"
        # The interesting lines are the nvcc/g++ errors, far above the
        # Python traceback that ends the log.
        grep -iE "error|killed|no space|fatal|undefined" "$blog" \
            | grep -vE "Logging error|--- |Error compiling|RuntimeError|error.*format string" \
            | head -25
        return 1
    }
    local wheel
    wheel=$(ls "$src"/dist/sageattention-*.whl 2>/dev/null | head -1)
    [ -n "$wheel" ] || { log "compile produced no wheel — see $blog"; return 1; }
    cp "$wheel" "$1"/ || return 1
    pip install --no-cache-dir --quiet "$1/$(basename "$wheel")" || return 1
    rm -rf "$src"
    log "SageAttention built and cached: $1/$(basename "$wheel")"
}

reload_pipeline() {
    # Re-apply the attention backend by unloading/reloading whatever pipeline
    # is currently loaded (queued on the worker, so it never races a job).
    local hdr=()
    [ -n "${NIDORA_API_KEY:-}" ] && hdr=(-H "X-Api-Key: ${NIDORA_API_KEY}")
    local lp
    lp=$(curl -s localhost:8000/health \
        | python -c 'import sys,json; print(json.load(sys.stdin).get("loaded_pipeline") or "")' \
        2>/dev/null) || return 0
    [ -n "$lp" ] || { log "no pipeline loaded yet — sage applies on next load"; return 0; }
    log "reloading pipeline ${lp} to enable sage attention"
    curl -s -X POST "${hdr[@]}" "localhost:8000/v1/pipelines/${lp}/unload" >/dev/null || true
    curl -s -X POST "${hdr[@]}" "localhost:8000/v1/pipelines/${lp}/load" >/dev/null || true
}

provision_sage() {
    local cap
    cap=$(gpu_cap)
    if [ -z "$cap" ]; then
        log "no CUDA GPU detected — skipping SageAttention provisioning"
        return 0
    fi
    if [ "$cap" -lt 80 ] 2>/dev/null; then
        log "GPU is sm${cap} (< sm80) — SageAttention unsupported, using sdpa"
        return 0
    fi
    local cache_dir="${NIDORA_WHEELS_DIR:-${NIDORA_MODELS_DIR:-/models}/.wheels}/sage-${SAGE_REF}-sm${cap}"
    if install_cached_wheel "$cache_dir"; then
        log "SageAttention ready (cached wheel)"
        return 0
    fi
    # First boot on this volume/GPU combo: build in the background and hot-
    # reload when done; the server starts on sdpa meanwhile.
    (
        set +e
        if build_sage "$cache_dir"; then
            sleep 5 # let uvicorn come up before poking the API
            reload_pipeline
        else
            log "SageAttention build failed — continuing on sdpa"
        fi
    ) &
}

case "${NIDORA_ATTENTION:-auto}" in
    auto|sage)
        if [ "${NIDORA_BUILD_SAGE:-1}" != "0" ] && ! sage_ok; then
            provision_sage
        fi
        ;;
esac

exec "$@"
