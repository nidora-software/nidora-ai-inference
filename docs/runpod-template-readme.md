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
| System RAM | 64 GB+ | |
| Volume | **300 GB** network volume at `/workspace` | ~126 GB model snapshot lives in the volume's HF cache |
| Ports | HTTP 8000 | RunPod's proxy provides HTTPS |

## Template setup

- **Image**: `erenck/nidora-ai-inference:latest` (pin a commit-SHA tag for reproducibility)
- **Expose HTTP Ports**: 8000
- **Volume**: network volume mounted at `/workspace`
- **Environment**:
  ```
  API_KEY=<your-secret>            # REQUIRED: proxy URLs are public
  CF_TUNNEL_TOKEN=<token>          # optional: stable HTTPS hostname instead of the proxy
  SGLANG_EXTRA_ARGS=               # optional tuning (attention backend, torch compile, ...)
  ```

The container's default entrypoint starts the server — nothing to run
manually.

## First boot

The server downloads the model snapshot into `/workspace/hf` (one-time per
volume, ~126 GB), loads and warms it (`--warmup-mode server`), then serves.
Later boots skip the download. Readiness: `GET /health` answers once warmup
is done.

## Usage

See [api.md](api.md). Short version, via RunPod's proxy:

```bash
curl -s https://<POD_ID>-8000.proxy.runpod.net/v1/videos \
  -H "Authorization: Bearer $API_KEY" \
  -F input_reference=@input.jpg \
  -F prompt="the woman smiles and waves" \
  -F size="480x832" -F seconds=5
# poll GET /v1/videos/{id}; download /v1/videos/{id}/content
```

## Tips

- Keep the network volume when stopping the pod — the download happens once.
- `SGLANG_EXTRA_ARGS="--attention-backend fa3 --enable-torch-compile true"`
  is a good Hopper starting point.
- Image updates: restart to pull the newest `latest`, or pin a SHA tag.
