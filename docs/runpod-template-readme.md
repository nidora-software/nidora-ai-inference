# Nidora AI Inference — Wan 2.2 Image-to-Video

Self-hosted async inference API serving **Wan 2.2 I2V A14B** (MoE high/low-noise experts) as **Q6_K GGUF quants** with **Lightning 4-step LoRAs** — fast video generation behind a clean REST API. Built on diffusers + FastAPI.

- Image: `erenck/nidora-ai-inference:latest` (also on GHCR)
- Source: https://github.com/nidora-software/nidora-ai-inference
- License: MIT

## What it does

`POST` a job with an input image + prompt, poll until done, download an H.264 MP4. A single GPU worker processes jobs sequentially from a queue (SQLite-backed, survives restarts, supports cancellation). Pipelines, models, and LoRAs are YAML-configured — the same image can serve other model/LoRA combos.

## Requirements

| Resource | Minimum | Notes |
|---|---|---|
| GPU | 24 GB (RTX 4090) | `NIDORA_OFFLOAD=model` — one Q6_K expert (~12 GB) on GPU at a time |
| System RAM | 48 GB+ | the idle expert parks in RAM |
| Volume | **100 GB** at `/workspace` | ~37 GB of weights + outputs headroom |
| Ports | HTTP 8000 | |

48 GB+ cards can set `NIDORA_OFFLOAD=none` (both experts resident) for max
speed.

## Environment variables (as configured)

```
NIDORA_MODELS_DIR=/workspace/models      # weights on the persistent volume
NIDORA_OUTPUTS_DIR=/workspace/outputs    # generated videos
NIDORA_DB_PATH=/workspace/jobs.sqlite3   # job store
NIDORA_AUTO_DOWNLOAD=1                   # fetch missing weights at startup
NIDORA_WARMUP=wan22-i2v                  # load the model at boot, not on the first job
NIDORA_OFFLOAD=model                     # 24 GB cards; "none" on 48 GB+
NIDORA_ATTENTION=auto                    # SageAttention if available, else SDPA
NIDORA_API_KEY=<your-secret>             # REQUIRED: RunPod proxy URLs are public
```

All `/v1/*` calls must send the key: `-H "X-Api-Key: <your-secret>"`
(or `Authorization: Bearer <your-secret>`). `/health` stays open.

## First boot

The API comes up immediately; missing weights (~37 GB: Q6_K GGUF experts, base components, Lightning LoRAs) download in the background into `/workspace/models` — typically 5–15 min — then the model warms into RAM/VRAM (`NIDORA_WARMUP=wan22-i2v`). Jobs submitted meanwhile just queue behind the bootstrap. Every later boot skips the download and is generating-ready within a few minutes. Track it via `GET /health`: `activity` goes `downloading` → `loading:wan22-i2v` → `idle`; ready when `"loaded_pipeline": "wan22-i2v"`.

## Usage

Health check:

```
curl https://<POD_ID>-8000.proxy.runpod.net/health
```

Submit a job:

```
curl -X POST https://<POD_ID>-8000.proxy.runpod.net/v1/jobs \
  -H 'content-type: application/json' -d '{
  "pipeline": "wan22-i2v",
  "params": {
    "image": "https://example.com/input.jpg",
    "prompt": "the woman smiles and waves at the camera",
    "resolution": "480p",
    "num_frames": 81,
    "frames_per_second": 16,
    "seed": 42
  }
}'
```

Poll status / get the video:

```
curl https://<POD_ID>-8000.proxy.runpod.net/v1/jobs/<JOB_ID>
# when state == "completed", download from artifacts[0].url:
curl -O https://<POD_ID>-8000.proxy.runpod.net/v1/outputs/<JOB_ID>/<JOB_ID>.mp4
```

Cancel: `DELETE /v1/jobs/<JOB_ID>`. List pipelines + full parameter schemas: `GET /v1/pipelines`.

Note: the template sets `NIDORA_WARMUP=wan22-i2v`, so the model **loads at boot** instead of on the first job — watch `GET /health` for `loaded_pipeline`. You can also load/unload explicitly with `POST /v1/pipelines/<NAME>/load` and `POST /v1/pipelines/<NAME>/unload`.

## Key parameters (wan22-i2v)

| Param | Default | Notes |
|---|---|---|
| `image` | — | URL, data URI, or base64 |
| `prompt` | — | motion/scene description |
| `resolution` | `480p` | target pixel budget (480×832 / 720×1280) |
| `fit` | `preserve` | keep input aspect ratio at the largest size fitting the budget; `fixed` = exact 480×832 (`aspect_ratio` 9:16/16:9) |
| `num_frames` | 81 | ~5 s at 16 fps |
| `frames_per_second` | 16 | |
| `num_inference_steps` | 4 | Lightning distilled |
| `scheduler` | `euler` | or `unipc` |
| `guidance_scale` / `_2` | 1.0 | per-expert CFG |
| `sample_shift` | 5.0 | scheduler flow shift |
| `boundary_ratio` | model config | expert handoff point (0–1) |
| `lora_scale_transformer` / `_2` | 0.5 / 1.0 | per-expert LoRA strength (profile defaults) |
| `crf` | 9 | mp4 quality (lower = better) |
| `seed` | random | set for reproducibility |

## Tips

- Keep the volume when stopping the pod — the 126 GB download happens once.
- Use a **Network Volume** if you plan to move between pods/regions.
- Outputs accumulate in `/workspace/outputs`; clean up old job folders periodically.
- Image updates: restart the pod to pull the newest `latest`, or pin a commit-SHA tag for reproducibility.
