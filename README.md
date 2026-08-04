# nidora-ai-inference

Deployment layer for self-hosted **Wan 2.2 image-to-video** on rented GPU
pods, served by [SGLang Diffusion](https://docs.sglang.io/diffusion/) —
OpenAI-compatible async video API, LoRA loading, warmup, and performance
tuning come from SGLang; this repo contributes the pinned Docker image, the
launch configuration, and the deployment docs.

- Image: `erenck/nidora-ai-inference:latest` (also on GHCR), built on
  `lmsysorg/sglang:v0.5.16-cu129` + `sglang[diffusion]`
- Default model: `Wan-AI/Wan2.2-I2V-A14B-Diffusers` with
  `lightx2v/Wan2.2-Distill-Loras` (4-step Lightning distill)
- API: `POST /v1/videos` → poll → download; see [docs/api.md](docs/api.md)

## Requirements

| Resource | Minimum | Notes |
|---|---|---|
| GPU | **80 GB (H100/A100)** | bf16 A14B: 2×28 GB experts + ~11 GB text encoder resident |
| System RAM | 64 GB+ | |
| Disk | **300 GB** persistent volume | ~126 GB model snapshot in the HF cache + headroom |
| Ports | HTTP 8000 | or a Cloudflare Tunnel (no open port needed) |

Smaller cards are possible via SGLang offload/quantization flags
(`SGLANG_EXTRA_ARGS="--dit-layerwise-offload ..."`) at a latency cost —
unbenchmarked, the 80 GB path is the supported one.

## Run

```bash
docker run --gpus all -p 127.0.0.1:8000:8000 \
  -v /path/to/volume:/workspace \
  erenck/nidora-ai-inference:latest
```

**Security note**: the SGLang diffusion server has **no built-in API auth**
— never expose the port publicly. Production deployments run tunnel-only
with Cloudflare Access in front (see
[docs/deploy-pods.md](docs/deploy-pods.md)).

First boot downloads the model into `/workspace/hf` (one-time per volume),
warms it up (`--warmup-mode server`), then serves. Configuration is
env-driven — see [.env.sample](.env.sample); anything else goes through
`SGLANG_EXTRA_ARGS` (attention backend, torch compile, offload,
parallelism).

Cloud pods: [docs/deploy-pods.md](docs/deploy-pods.md) (Vast.ai / RunPod
recipes, Cloudflare Tunnel for a stable HTTPS hostname).

## Layout

```
Dockerfile                   # pinned SGLang + diffusion extra + cloudflared
scripts/docker-entrypoint.sh # tunnel + `sglang serve` with env-driven flags
docs/api.md                  # API usage for clients
docs/deploy-pods.md          # pod deployment recipes
docs/vastai-template-readme.md
```

## History

Before 2026-08, this repo was a hand-rolled inference server (FastAPI job
queue + diffusers pipeline with GGUF-quantized experts, 24 GB-card
friendly). It was replaced wholesale by SGLang Diffusion; the old stack
lives in git history if ever needed.
