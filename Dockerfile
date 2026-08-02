# CUDA runtime image with torch preinstalled. Weights are NOT baked in —
# mount /models (pre-provisioned) or set NIDORA_AUTO_DOWNLOAD=1.
FROM pytorch/pytorch:2.8.0-cuda12.9-cudnn9-runtime

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app
COPY pyproject.toml README.md LICENSE ./
COPY configs ./configs
COPY src ./src

RUN uv pip install --system --no-cache ".[accel]"

ENV NIDORA_MODELS_DIR=/models \
    NIDORA_OUTPUTS_DIR=/outputs \
    NIDORA_DB_PATH=/outputs/jobs.sqlite3 \
    HF_HUB_ENABLE_HF_TRANSFER=1 \
    PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True

VOLUME ["/models", "/outputs"]
EXPOSE 8000

CMD ["nidora-ai-inference", "serve"]
