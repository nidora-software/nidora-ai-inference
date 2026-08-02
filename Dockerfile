# ---- SageAttention build stage ---------------------------------------------
# diffusers' sage attention backend needs sageattention>=2.1.1, which is not
# on PyPI — compile it here (nvcc lives in the devel image) and ship the wheel
# into the slim runtime image below. Arch list = the GPUs pods actually rent:
# 8.0 A100, 8.6 3090/A6000, 8.9 4090/L40S, 9.0 H100, 12.0 RTX 5090.
FROM pytorch/pytorch:2.8.0-cuda12.9-cudnn9-devel AS sage-builder

RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir ninja packaging wheel

ARG SAGEATTENTION_REF=v2.2.0
ARG TORCH_CUDA_ARCH_LIST="8.0;8.6;8.9;9.0;12.0"
RUN git clone --depth 1 --branch ${SAGEATTENTION_REF} \
    https://github.com/thu-ml/SageAttention.git /opt/sageattention
WORKDIR /opt/sageattention
ENV TORCH_CUDA_ARCH_LIST=${TORCH_CUDA_ARCH_LIST}
# Parallelism sized for a 4-vCPU/16 GB CI runner — nvcc is memory-hungry.
RUN EXT_PARALLEL=2 NVCC_APPEND_FLAGS="--threads 2" MAX_JOBS=4 \
    python setup.py bdist_wheel

# ---- Runtime image ----------------------------------------------------------
# CUDA runtime image with torch preinstalled. Weights are NOT baked in —
# mount /models (pre-provisioned) or set NIDORA_AUTO_DOWNLOAD=1.
FROM pytorch/pytorch:2.8.0-cuda12.9-cudnn9-runtime

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# cloudflared for optional HTTPS via Cloudflare Tunnel (set
# NIDORA_CF_TUNNEL_TOKEN to activate). "latest" keeps the client current;
# the tunnel protocol is stable.
ADD https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 /usr/local/bin/cloudflared
RUN chmod +x /usr/local/bin/cloudflared

WORKDIR /app
COPY pyproject.toml README.md LICENSE ./
COPY configs ./configs
COPY src ./src
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY --from=sage-builder /opt/sageattention/dist/ /tmp/sage-dist/

RUN uv pip install --system --no-cache ".[accel]" /tmp/sage-dist/*.whl \
    && rm -rf /tmp/sage-dist \
    && chmod +x /usr/local/bin/docker-entrypoint.sh

# NIDORA_OFFLOAD=model is the fail-safe default: fits every 24 GB+ card.
# Override with -e NIDORA_OFFLOAD=none on 48 GB+ GPUs for max speed.
ENV NIDORA_MODELS_DIR=/models \
    NIDORA_OUTPUTS_DIR=/outputs \
    NIDORA_DB_PATH=/outputs/jobs.sqlite3 \
    NIDORA_OFFLOAD=model \
    HF_HUB_ENABLE_HF_TRANSFER=1 \
    PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True

VOLUME ["/models", "/outputs"]
EXPOSE 8000

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["nidora-ai-inference", "serve"]
