# nidora-ai-inference

Self-hosted AI inference API. Default pipeline: **image-to-video with Wan 2.2
I2V A14B** (MoE high-noise + low-noise experts) running **Q6_K GGUF-quantized
experts** (~12 GB each) with **Lightning 4-step LoRAs** — built on
[diffusers], with a small pipeline abstraction so other models, LoRAs, and
modalities (text-to-image, …) are one class + one YAML profile away.

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
    "seed": 42
  }
}'
# -> {"id": "j_ab12cd34ef56", "state": "queued", ...}

curl localhost:8000/v1/jobs/j_ab12cd34ef56
# -> {"state": "completed", "artifacts": [{"url": "/v1/outputs/j_ab12cd34ef56/j_ab12cd34ef56.mp4", ...}]}
```

Default generation settings (from the `wan22-i2v` profile): aspect-preserving
sizing (largest size fitting the 480p/720p pixel budget, `fit: "fixed"` for
exact 480×832), 81 frames @ 16 fps ≈ 5 s, 4 euler steps, cfg 1, Lightning
LoRA strengths 0.5 (high-noise) / 1.0 (low-noise). Every value is overridable per job — see
`GET /v1/pipelines` for the full schema, including `scheduler`,
`boundary_ratio` (expert handoff), `crf`, and per-expert LoRA scales.

Explore pipelines and their parameter schemas: `GET /v1/pipelines`.

## Models

Weights are **never downloaded implicitly**. The default profile needs ~37 GB:
Q6_K GGUF experts (2×12 GB), Lightning LoRAs (~2.5 GB), and the base snapshot's
non-transformer components (~12 GB: text encoder, VAE, tokenizer, configs).
See [models/README.md](models/README.md) for the expected layout. Either place
files manually, or:

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
| `NIDORA_WARMUP` | unset | pipeline profile to load at startup (e.g. `wan22-i2v`); unset = load on first job |
| `NIDORA_API_KEY` | unset | when set, `/v1/*` requires `X-Api-Key: <key>` (or `Authorization: Bearer`); `/health` stays open. **Set this on any public deployment.** |
| `NIDORA_CF_TUNNEL_TOKEN` | unset | Docker image only: starts `cloudflared` next to the server for a stable HTTPS hostname (Cloudflare Tunnel token) |

### VRAM guidance (Wan 2.2 A14B i2v)

Default profile (Q6_K GGUF experts, ~12 GB each):

| GPU | Setting |
|---|---|
| 48 GB+ | `NIDORA_OFFLOAD=none` — both experts resident |
| 24 GB (4090/3090) | `NIDORA_OFFLOAD=model` — one expert on GPU at a time |

Full-precision `wan22-i2v-bf16` profile (~28 GB per expert): 80 GB cards run
`none`, 48 GB cards run `model`, and 24 GB cards require `group` (streams
weights through VRAM in pieces; needs 64 GB+ system RAM).

### SageAttention / Triton (optional acceleration)

`NIDORA_ATTENTION=auto` uses SageAttention when a usable version is installed
and falls back to PyTorch SDPA otherwise (also at runtime, if the backend
errors). Explicit `sage`/`flash` fail loudly if missing.

diffusers' sage backend requires **sageattention ≥ 2.1.1**, which is not on
PyPI (the 1.x PyPI package is too old and won't be used), plus an sm80+ GPU
(A100/3090 or newer).

- **Docker image**: SageAttention v2.2.0 is **prebuilt into the image** for
  sm 8.0 / 8.6 / 8.9 / 9.0 / 12.0 (A100, 3090/A6000, 4090/L40S, H100,
  RTX 5090) — nothing to do; `auto` uses it. Look for
  `attention backend: sage` in the logs at model load.
- **provision.sh pods**: set `NIDORA_BUILD_SAGE=1` to compile it at first
  boot (needs nvcc on the host image; takes 10–30 min once).
- **Manual**: on a machine with nvcc:
  ```bash
  uv sync --extra accel   # triton
  uv pip install --no-build-isolation "git+https://github.com/thu-ml/SageAttention.git@v2.2.0"
  ```

On Windows, install `triton-windows` first; community-built SageAttention
wheels matching your torch/CUDA version can save the source build.

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
