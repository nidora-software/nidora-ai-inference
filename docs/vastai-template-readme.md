# Nidora AI Inference — Wan 2.2 Image-to-Video

Self-hosted async inference API serving **Wan 2.2 I2V A14B** (MoE high/low-noise experts) as **Q6_K GGUF quants** with **Lightning 4-step LoRAs** — fast video generation behind a clean REST API. Built on diffusers + FastAPI.

- Image: `erenck/nidora-ai-inference:latest` (Docker Hub; also on GHCR as `ghcr.io/nidora-software/nidora-ai-inference`)
- Source: https://github.com/nidora-software/nidora-ai-inference
- License: MIT

## What it does

`POST` a job with an input image + prompt, poll until done, download an H.264 MP4. A single GPU worker processes jobs sequentially from a queue (SQLite-backed, survives restarts, supports cancellation). Pipelines, models, and LoRAs are YAML-configured — the same image can serve other model/LoRA combos.

## Requirements

| Resource | Minimum | Notes |
|---|---|---|
| GPU | 24 GB (RTX 4090) | `NIDORA_OFFLOAD=model` — one Q6_K expert (~12 GB) on GPU at a time |
| System RAM | **48 GB minimum, 64 GB recommended** | both experts + text encoder park in RAM (~40–50 GB peak at load). Vast enforces the offer's RAM allocation as a hard docker memory limit — less RAM = OOM kill (exit 137) during model load. Filter offers by CPU RAM ≥ 48 GB. |
| Disk | **100 GB** | ~37 GB of weights + outputs headroom |
| Ports | HTTP 8000 | Vast maps it to a random public port |

48 GB+ cards can set `NIDORA_OFFLOAD=none` (both experts resident) for max
speed.

## Template setup

- **Image**: `erenck/nidora-ai-inference:latest` (or pin a commit-SHA tag)
- **Launch mode**: run the image's entrypoint (the default command *is* `serve`) — no on-start script needed
- **Disk**: 100 GB+
- **Docker options**:

```
-p 8000:8000
-e NIDORA_AUTO_DOWNLOAD=1
-e NIDORA_WARMUP=wan22-i2v
-e NIDORA_OFFLOAD=model
-e NIDORA_ATTENTION=auto
-e NIDORA_API_KEY=<your-secret>
```

`NIDORA_API_KEY` is **required** — Vast instances get a public IP. All
`/v1/*` calls must send the key: `-H "X-Api-Key: <your-secret>"`
(or `Authorization: Bearer <your-secret>`). `/health` stays open.

Weights, outputs, and the job store live at the image defaults `/models` and
`/outputs` on the instance disk. The disk survives **stop/start**; destroying
the instance deletes it (and re-triggers the ~37 GB download on the next one).

## HTTPS via Cloudflare Tunnel (recommended)

Vast's direct port mappings are plain HTTP to a random `IP:port` that changes
with every instance. The image ships `cloudflared`: give it a tunnel token and
the API gets a stable HTTPS hostname (e.g. `https://inference.nidora.ai`)
independent of the pod's IP/port.

One-time setup (Cloudflare dashboard, domain must be on Cloudflare):

1. **Zero Trust → Networks → Tunnels → Create a tunnel** (type: Cloudflared),
   name it e.g. `nidora-inference`, and copy the token from the install
   command (`eyJ...`).
2. On the tunnel's **Public Hostname** tab add: hostname
   `inference.nidora.ai` → service `HTTP://localhost:8000`.
3. Add to the template's Docker options:
   ```
   -e NIDORA_CF_TUNNEL_TOKEN=eyJ...
   ```

The tunnel is outbound-only — with it in place you can remove the `8000/tcp`
port mapping entirely (nothing needs to reach the pod directly), and clients
call `https://inference.nidora.ai/...` with the same `X-Api-Key` header.
Keep `NIDORA_API_KEY` set: the hostname is public.

## First boot

The API comes up immediately; missing weights (~37 GB: Q6_K GGUF experts,
base components, Lightning LoRAs) download in the background into `/models`
— typically 5–15 min — then the model warms into RAM/VRAM
(`NIDORA_WARMUP=wan22-i2v`). Jobs submitted meanwhile just queue behind the
bootstrap. Every later boot skips the download and is generating-ready
within a few minutes. Track it via `GET /health`: `activity` goes
`downloading` → `loading:wan22-i2v` → `idle`; ready when
`"loaded_pipeline": "wan22-i2v"`.

## Usage

Find the mapped public port on the instance card (the IP/port button —
container port 8000 maps to a random host port), then:

```
curl http://<PUBLIC_IP>:<MAPPED_PORT>/health
```

Submit a job:

```
curl -X POST http://<PUBLIC_IP>:<MAPPED_PORT>/v1/jobs \
  -H "X-Api-Key: <your-secret>" \
  -H 'content-type: application/json' -d '{
  "pipeline": "wan22-i2v",
  "params": {
    "image": "https://example.com/input.jpg",
    "prompt": "the woman smiles and waves at the camera",
    "resolution": "480p",
    "seed": 42
  }
}'
```

Poll status / get the video:

```
curl -H "X-Api-Key: <your-secret>" http://<PUBLIC_IP>:<MAPPED_PORT>/v1/jobs/<JOB_ID>
# when state == "completed", download from artifacts[0].url:
curl -H "X-Api-Key: <your-secret>" -O http://<PUBLIC_IP>:<MAPPED_PORT>/v1/outputs/<JOB_ID>/<JOB_ID>.mp4
```

Cancel: `DELETE /v1/jobs/<JOB_ID>`. List pipelines + full parameter schemas: `GET /v1/pipelines`. Load/unload the model explicitly: `POST /v1/pipelines/<NAME>/load` / `POST /v1/pipelines/<NAME>/unload`.

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

- **Stop, don't destroy** — stopped instances keep their disk, so the weights
  download happens once. (A stopped instance's GPU can be rented to someone
  else; restart may briefly wait for a free GPU on that host.)
- Prefer offers with high `inet_down` — the first boot pulls ~37 GB from
  HuggingFace.
- Outputs accumulate in `/outputs`; clean up old job folders periodically.
- Image updates: destroy + recreate to pull the newest `latest`, or pin a
  commit-SHA tag for reproducibility.
