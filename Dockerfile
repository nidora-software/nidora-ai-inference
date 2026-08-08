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

# The pull agent for gateway mode (GATEWAY_URL). Installed last so editing it
# never busts the expensive sglang[diffusion] layer above. Its only dependency
# is httpx, which the base image already ships.
COPY agent /opt/nidora-agent
RUN pip install --no-cache-dir /opt/nidora-agent

# No HF_HUB_ENABLE_HF_TRANSFER: sglang doesn't ship hf_transfer, and setting
# it without the package makes huggingface_hub error out. Fast downloads come
# from hf-xet (huggingface_hub's default backend) instead.
# SGLANG_DIFFUSION_CACHE_ROOT holds generated outputs/caches — keep it on the
# persistent volume rather than the container disk.
ENV HF_HOME=/workspace/hf \
    SGLANG_DIFFUSION_CACHE_ROOT=/workspace/sgl_diffusion

VOLUME ["/workspace"]
EXPOSE 8000

ENTRYPOINT ["docker-entrypoint.sh"]
