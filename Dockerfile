# CUDA runtime image with torch preinstalled. Weights are NOT baked in —
# mount /models (pre-provisioned) or set NIDORA_AUTO_DOWNLOAD=1.
FROM pytorch/pytorch:2.8.0-cuda12.9-cudnn9-runtime

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# curl: used by the entrypoint (SageAttention tarball, API self-calls).
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

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

# SageAttention: prebuilt once via scripts/build-sage-wheel.sh (CI runners
# can't compile it — nvcc OOMs), published on a GitHub release. If the wheel
# is missing the image still builds; NIDORA_ATTENTION=auto falls back to sdpa
# and logs why.
ARG SAGE_WHEEL_URL="https://github.com/nidora-software/nidora-ai-inference/releases/download/sage-v2.2.0-torch2.8-cu129/sageattention-2.2.0-cp311-cp311-linux_x86_64.whl"
RUN uv pip install --system --no-cache ".[accel]" \
    && (uv pip install --system --no-cache "${SAGE_WHEEL_URL}" \
        || echo "WARNING: SageAttention wheel not found at ${SAGE_WHEEL_URL} — sdpa fallback") \
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
