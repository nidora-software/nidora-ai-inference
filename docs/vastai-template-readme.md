# Nidora AI Inference — Wan 2.2 Image-to-Video (SGLang Diffusion)

Self-hosted **Wan 2.2 I2V A14B** with **Lightning 4-step distill LoRAs**,
served by SGLang Diffusion's OpenAI-compatible async video API.

- Image: `erenck/nidora-ai-inference:latest` (also on GHCR)
- Source: https://github.com/nidora-software/nidora-ai-inference
- License: MIT

## Requirements

| Resource | Minimum | Notes |
|---|---|---|
| GPU | **H100 / A100 80 GB** | bf16 A14B needs ~70 GB resident for full speed |
| System RAM | 64 GB+ | filter offers by CPU RAM |
| Disk | 20 GB container + **300 GB volume** at `/workspace` | ~126 GB model snapshot lives in the volume's HF cache |
| Ports | 8000/tcp | optional with a Cloudflare Tunnel |
| Host CUDA | ≥ 12.9 | set Min CUDA in the offer filter |

## Template setup

- **Image**: `erenck/nidora-ai-inference:latest`
- **Launch mode**: Docker ENTRYPOINT, args empty
- **Volume**: 300 GB at `/workspace`
- **Ports**: 8000/tcp (omit if tunnel-only)
- **Environment**:
  ```
  -e MODEL_PATH=Wan-AI/Wan2.2-I2V-A14B-Diffusers   # REQUIRED
  -e CF_TUNNEL_TOKEN=<token>      # stable HTTPS hostname (strongly recommended)
  -e SGLANG_EXTRA_ARGS=...        # optional tuning, see below
  ```

**Security**: the SGLang diffusion server has **no built-in API auth**. Run
tunnel-only (omit the 8000 port mapping) and protect the hostname with
**Cloudflare Access** (service token) — see
[deploy-pods.md](deploy-pods.md). Only map port 8000 for trusted-network or
debugging use.

## First boot

The server downloads the model snapshot into `/workspace/hf` (one-time per
volume, ~126 GB — pick offers with high `inet_down`), loads and warms it
(`--warmup-mode server`), then serves. Later boots skip the download and are
ready in minutes. Readiness: `GET /health` answers once warmup is done.

## Usage

See [api.md](api.md). Short version:

```bash
curl -s http://<IP>:<PORT>/v1/videos \
  -H "CF-Access-Client-Id: $CF_ACCESS_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_SECRET" \
  -F input_reference=@input.jpg \
  -F prompt="the woman smiles and waves" \
  -F size="480x832" -F seconds=5
# poll GET /v1/videos/{id}; download /v1/videos/{id}/content
```

## Tuning (SGLANG_EXTRA_ARGS)

- `--attention-backend fa3` — FlashAttention-3 on Hopper
- `--enable-torch-compile true` — slower warmup, faster steps
- `--text-encoder-cpu-offload` — only if VRAM is tight
- Multi-GPU: `--num-gpus N --enable-cfg-parallel`

## Tips

- The volume outlives the instance — destroy/recreate pods freely, the
  download happens once.
- Never expose port 8000 publicly — the API has no built-in auth; use the
  tunnel + Cloudflare Access.
- Pin a commit-SHA image tag for reproducibility; `:latest` tracks main.
