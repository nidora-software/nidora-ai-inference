# SGLang Diffusion serving Wan 2.2 I2V (A14B) with Lightning distill LoRAs.
# Weights are NOT baked in — HF_HOME points at the persistent volume and
# SGLang/huggingface_hub downloads (and resumes) on first boot.
FROM lmsysorg/sglang:v0.5.16-cu129

# The base image ships the LLM stack; add the diffusion engine (FastVideo).
RUN pip install --no-cache-dir "sglang[diffusion]==0.5.16"

# cloudflared for optional stable HTTPS via Cloudflare Tunnel (CF_TUNNEL_TOKEN).
ADD https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 /usr/local/bin/cloudflared
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/cloudflared /usr/local/bin/docker-entrypoint.sh

ENV HF_HOME=/workspace/hf \
    HF_HUB_ENABLE_HF_TRANSFER=1

VOLUME ["/workspace"]
EXPOSE 8000

ENTRYPOINT ["docker-entrypoint.sh"]
