#!/usr/bin/env bash
# One-time SageAttention wheel build — run INSIDE the CUDA devel image that
# matches the runtime image's python/torch/CUDA:
#
#   pytorch/pytorch:2.8.0-cuda12.9-cudnn9-devel
#
# e.g. a cheap many-core cloud instance (no GPU needed — nvcc cross-compiles
# for the arch list below). On 16-32 cores this takes ~5-15 min.
#
#   bash scripts/build-sage-wheel.sh
#
# Then attach the wheel from dist/ to the GitHub release referenced by the
# Dockerfile's SAGE_WHEEL_URL:
#
#   gh release create sage-v2.2.0-torch2.8-cu129 --notes "SageAttention wheel" \
#       sageattention-2.2.0-cp311-cp311-linux_x86_64.whl
#
# Rebuild + re-upload only when the base image's torch/CUDA/python changes.
set -euo pipefail

SAGE_REF="${SAGE_REF:-v2.2.0}"
# 8.0 A100, 8.6 3090/A6000, 8.9 4090/L40S, 9.0 H100, 12.0 RTX 5090.
export TORCH_CUDA_ARCH_LIST="${TORCH_CUDA_ARCH_LIST:-8.0;8.6;8.9;9.0;12.0}"

command -v nvcc >/dev/null || { echo "ERROR: nvcc not found — use the -devel image" >&2; exit 1; }
command -v git >/dev/null || { apt-get update && apt-get install -y --no-install-recommends git; }

pip install --no-cache-dir ninja packaging wheel

workdir=$(mktemp -d)
git clone --depth 1 --branch "$SAGE_REF" https://github.com/thu-ml/SageAttention.git "$workdir"
cd "$workdir"

EXT_PARALLEL=4 NVCC_APPEND_FLAGS="--threads 2" MAX_JOBS="$(nproc)" \
    python setup.py bdist_wheel

echo
echo "wheel ready:"
ls -la dist/
echo
echo "python: $(python -V), torch: $(python -c 'import torch; print(torch.__version__)')"
echo "upload it to the release referenced by the Dockerfile's SAGE_WHEEL_URL."
