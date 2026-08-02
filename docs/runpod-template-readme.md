# Nidora AI Inference — Wan 2.2 Image-to-Video

Self-hosted async inference API serving **Wan 2.2 I2V A14B** (MoE high/low-noise experts) accelerated with **Lightx2v distill LoRAs** — 4-step video generation behind a clean REST API. Built on diffusers + FastAPI.

- Image: `erenck/nidora-ai-inference:latest` (also on GHCR)
- Source: https://github.com/nidora-software/nidora-ai-inference
- License: MIT

## What it does

`POST` a job with an input image + prompt, poll until done, download an H.264 MP4. A single GPU worker processes jobs sequentially from a queue (SQLite-backed, survives restarts, supports cancellation). Pipelines, models, and LoRAs are YAML-configured — the same image can serve other model/LoRA combos.

## Requirements

| Resource | Minimum | Notes |
|---|---|---|
| GPU | 24 GB (RTX 4090) | 480p; requires `NIDORA_OFFLOAD=group` |
| System RAM | 64 GB+ | both 14B experts park in RAM when offloading |
| Volume | **200 GB** at `/workspace` | model snapshot alone is 126 GB |
| Ports | HTTP 8000 | |

On 24 GB cards only `NIDORA_OFFLOAD=group` works — one 14B expert (~28 GB bf16)
exceeds VRAM, so it must be streamed in pieces. 48 GB cards (A6000/L40S) use
`NIDORA_OFFLOAD=model` and run 720p comfortably; 80 GB cards set
`NIDORA_OFFLOAD=none` for max speed.

## Environment variables (as configured)

```
NIDORA_MODELS_DIR=/workspace/models      # weights on the persistent volume
NIDORA_OUTPUTS_DIR=/workspace/outputs    # generated videos
NIDORA_DB_PATH=/workspace/jobs.sqlite3   # job store
NIDORA_AUTO_DOWNLOAD=1                   # fetch missing weights at startup
NIDORA_OFFLOAD=group                     # required on 24 GB; "model" on 48 GB, "none" on 80 GB
NIDORA_ATTENTION=auto                    # SageAttention if available, else SDPA
NIDORA_API_KEY=<your-secret>             # REQUIRED: RunPod proxy URLs are public
```

All `/v1/*` calls must send the key: `-H "X-Api-Key: <your-secret>"`
(or `Authorization: Bearer <your-secret>`). `/health` stays open.

## First boot

The container starts, sees the empty volume, and downloads the Wan 2.2 snapshot (126 GB) + Lightx2v LoRAs from HuggingFace into `/workspace/models` — typically 15–30 min — then starts serving. Every later boot skips the download and serves in seconds. Watch progress in the container logs.

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
# when state == "completed":
curl -O https://<POD_ID>-8000.proxy.runpod.net/v1/outputs/<JOB_ID>/output.mp4
```

Cancel: `DELETE /v1/jobs/<JOB_ID>`. List pipelines + full parameter schemas: `GET /v1/pipelines`.

Note: the **first job after a boot** also loads the model into RAM/VRAM (a few minutes); subsequent jobs go straight to inference.

## Key parameters (wan22-i2v)

| Param | Default | Notes |
|---|---|---|
| `image` | — | URL, data URI, or base64 |
| `prompt` | — | motion/scene description |
| `resolution` | `480p` | `480p` (480×832) or `720p` (720×1280) |
| `aspect_ratio` | `9:16` | or `16:9` |
| `num_frames` | 81 | ~5 s at 16 fps |
| `frames_per_second` | 16 | |
| `num_inference_steps` | 4 | Lightx2v distilled |
| `guidance_scale` / `_2` | 1.0 | per-expert CFG |
| `sample_shift` | 5.0 | scheduler flow shift |
| `lora_scale_transformer` / `_2` | 1.0 | per-expert LoRA strength |
| `seed` | random | set for reproducibility |

## Tips

- Keep the volume when stopping the pod — the 126 GB download happens once.
- Use a **Network Volume** if you plan to move between pods/regions.
- Outputs accumulate in `/workspace/outputs`; clean up old job folders periodically.
- Image updates: restart the pod to pull the newest `latest`, or pin a commit-SHA tag for reproducibility.
