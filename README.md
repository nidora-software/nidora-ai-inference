# nidora-ai-inference

Deployment layer for self-hosted media generation on rented GPU pods,
served by [SGLang Diffusion](https://docs.sglang.io/diffusion/) — the
OpenAI-compatible async API, model loading/warmup, LoRA support, and
performance tuning come from SGLang; this repo contributes the pinned
Docker image, the env-driven launch configuration, and the deployment docs.
Any model family SGLang Diffusion supports can be served by pointing
`MODEL_PATH` at its HuggingFace repo id (browse the
[cookbook](https://docs.sglang.io/cookbook/diffusion/) for the catalog).

- Image: `erenck/nidora-ai-inference:latest` (also on GHCR), built on
  `lmsysorg/sglang:v0.5.16-cu129` + `sglang[diffusion]`
- API: `POST /v1/videos` → poll → download (and the image endpoints);
  see [docs/api.md](docs/api.md)

## Configuration

Everything is env-driven — no code changes to switch models or tune:

| Env | Required | Purpose |
|---|---|---|
| `MODEL_PATH` | **yes** | HF repo id or local path of the served model |
| `LORA_PATH` | no | LoRA repo id/path; unset = no LoRA |
| `PORT` | no | HTTP port (default 8000) |
| `CF_TUNNEL_TOKEN` | no | Cloudflare Tunnel for a stable HTTPS hostname |
| `SGLANG_EXTRA_ARGS` | no | extra `sglang serve` flags (attention backend, offload, torch compile, parallelism) |

Model weights are never baked into the image; they download once into the
volume-backed HF cache (`HF_HOME=/workspace/hf`).

## Run

```bash
docker run --gpus all -p 127.0.0.1:8000:8000 \
  -v /path/to/volume:/workspace \
  -e MODEL_PATH=<org/model-repo> \
  -e LORA_PATH=<org/lora-repo> \
  erenck/nidora-ai-inference:latest
```

Hardware requirements depend on the served model (check its cookbook page).
As a reference point, a bf16 14B-class video model wants an 80 GB GPU
(H100/A100), 128 GB+ system RAM (fp32 snapshots stage through RAM at
load), and a 300 GB volume; smaller cards can work via
SGLang offload/quantization flags at a latency cost.

**Security note**: the SGLang diffusion server has **no built-in API auth**
— never expose the port publicly. Production deployments run tunnel-only
with Cloudflare Access in front (see
[docs/deploy-pods.md](docs/deploy-pods.md)).

Cloud pods: [docs/deploy-pods.md](docs/deploy-pods.md) (Vast.ai / RunPod
recipes, Cloudflare Tunnel + Access setup).

## Layout

```
Dockerfile                   # pinned SGLang + diffusion extra + cloudflared
scripts/docker-entrypoint.sh # tunnel + `sglang serve` with env-driven flags
docs/api.md                  # API usage for clients
docs/deploy-pods.md          # pod deployment recipes
docs/vastai-template-readme.md
docs/runpod-template-readme.md
```
