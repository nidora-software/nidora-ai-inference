# nidora-ai-inference

Self-hosted AI inference API. Default pipeline: **image-to-video with Wan 2.2
I2V A14B** (MoE high-noise + low-noise experts) accelerated by **Lightx2v
distill LoRAs** (4-step inference) — built on [diffusers], with a small
pipeline abstraction so other models, LoRAs, and modalities (text-to-image,
…) are one class + one YAML profile away.

- **Async job API** — `POST /v1/jobs` returns immediately; a single in-process
  GPU worker runs jobs sequentially; poll with `GET /v1/jobs/{id}`; cancel
  with `DELETE`. SQLite job store, no external broker.
- **Config-driven** — models, LoRAs, and default params live in
  `configs/pipelines.yaml` + `configs/models.yaml`; hardware knobs (dtype,
  offloading, attention backend) are env vars.
- **OS-agnostic** — Linux, Windows, macOS (CPU/mock for development).

[diffusers]: https://github.com/huggingface/diffusers

## Quickstart

```bash
uv sync                        # install (CPU-only works for dev)
uv run nidora-ai-inference serve
```

Submit a job:

```bash
curl -X POST localhost:8000/v1/jobs -H 'content-type: application/json' -d '{
  "pipeline": "wan22-i2v",
  "params": {
    "image": "https://example.com/input.jpg",
    "prompt": "the woman smiles and waves at the camera",
    "resolution": "480p",
    "num_frames": 81,
    "frames_per_second": 16
  }
}'
# -> {"id": "j_ab12cd34ef56", "state": "queued", ...}

curl localhost:8000/v1/jobs/j_ab12cd34ef56
# -> {"state": "completed", "artifacts": [{"url": "/v1/outputs/j_ab12cd34ef56/output.mp4", ...}]}
```

Explore pipelines and their parameter schemas: `GET /v1/pipelines`.

## Models

Weights are **never downloaded implicitly**. See [models/README.md](models/README.md)
for the expected layout. Either place files manually, or:

```bash
uv run nidora-ai-inference download --all   # fetch everything the profiles need
```

Cloud pods can set `NIDORA_AUTO_DOWNLOAD=1` to provision at startup, or use
`scripts/provision.sh` — see [docs/deploy-pods.md](docs/deploy-pods.md) for
step-by-step RunPod / Vast.ai recipes.

## Configuration

All env vars are optional (prefix `NIDORA_`, see `.env.sample`):

| Variable | Default | Notes |
|---|---|---|
| `NIDORA_MODELS_DIR` | `./models` | manifest entries resolve to `{dir}/{name}` |
| `NIDORA_OUTPUTS_DIR` | `./outputs` | job artifacts |
| `NIDORA_DB_PATH` | `./jobs.sqlite3` | job store |
| `NIDORA_DEVICE` | auto | `cuda` / `cpu` |
| `NIDORA_DTYPE` | `bf16` | `bf16` / `fp16` / `fp32` |
| `NIDORA_OFFLOAD` | `none` | `none` / `model` / `sequential` / `group` |
| `NIDORA_ATTENTION` | `auto` | `auto` / `sdpa` / `sage` / `flash` |
| `NIDORA_AUTO_DOWNLOAD` | `0` | `1` = download missing models at startup |

### VRAM guidance (Wan 2.2 A14B i2v, bf16)

| GPU | Suggested settings |
|---|---|
| 80 GB (A100/H100) | `NIDORA_OFFLOAD=none` |
| 48 GB (A6000/L40S) | `NIDORA_OFFLOAD=model` |
| 24 GB (4090/3090) | `NIDORA_OFFLOAD=model` or `group` — the two 14B experts cannot co-reside; expect offload swaps between the high/low-noise phases |

### SageAttention / Triton (optional acceleration)

`NIDORA_ATTENTION=auto` uses SageAttention when installed and silently falls
back to PyTorch SDPA otherwise. Explicit `sage`/`flash` fail loudly if missing.

- **Linux**: `uv sync --extra accel` (installs `sageattention` + `triton`).
- **Windows**: `uv pip install triton-windows sageattention` (Triton wheels
  for Windows ship separately; check your CUDA/torch version compatibility).

## Docker

The image contains code + dependencies only — weights come from the `/models`
volume, artifacts land in `/outputs`, and the container's main process is
`nidora-ai-inference serve`. Running it locally mirrors the rental-pod flow
exactly:

```bash
docker compose up --build
```

This builds the image and mounts `./models` and `./outputs` from the repo, so
the same weight folders you use for the bare `serve` command work unchanged.
To imitate the cloud-pod provisioning path instead, uncomment
`NIDORA_AUTO_DOWNLOAD: "1"` in `docker-compose.yml`.

Requirements for GPU inference in Docker: an NVIDIA GPU + driver and the
NVIDIA Container Toolkit (on Windows: Docker Desktop with the WSL2 backend —
GPU passthrough is built in). On machines without an NVIDIA GPU (e.g. macOS),
remove the `deploy:` block and set `NIDORA_DEVICE=cpu` — that's only useful
for exercising the API with the mock pipeline.

## Development

```bash
uv run pytest            # full suite runs on CPU (mock pipeline), no weights needed
uv run ruff check .
uv run pytest -m gpu     # GPU smoke tests — needs CUDA + provisioned weights
```

The `mock` pipeline profile exercises the entire stack (queue → worker →
progress → cancellation → mp4 encoding → artifact serving) without torch/CUDA.

## Adding a pipeline

1. Write a class in `src/nidora_ai_inference/pipelines/` with `kind`, a
   pydantic `Params` model, `load()`, and `generate()` (~80 lines — see
   `flux_t2i.py`).
2. Register it: `@register`, plus a lazy-import entry in `pipelines/__init__.py`
   if it needs torch.
3. Add a profile to `configs/pipelines.yaml` (model, LoRAs, defaults) and any
   new weights to `configs/models.yaml`.

## License

[MIT](LICENSE). Model weights keep their own licenses.
