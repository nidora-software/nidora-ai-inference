# API reference

The server is SGLang Diffusion's OpenAI-compatible API. Full upstream docs:
https://docs.sglang.io/diffusion/api/openai_api.html — this page covers the
subset the app uses.

## Authentication

The SGLang diffusion server has **no built-in API auth** (verified against
v0.5.16). Deployments run tunnel-only behind **Cloudflare Access** with a
service token; every request must carry the Access headers:

```
CF-Access-Client-Id: <service-token-id>.access
CF-Access-Client-Secret: <service-token-secret>
```

Requests without a valid token are rejected at Cloudflare's edge before
reaching the pod.

## Generate a video (image-to-video)

Async: create → poll → download.

```bash
# 1. Create (multipart; input_reference is the source image)
curl -s https://inference.nidora.ai/v1/videos \
  -H "CF-Access-Client-Id: $CF_ACCESS_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_SECRET" \
  -F input_reference=@input.jpg \
  -F prompt="the woman smiles and waves at the camera" \
  -F size="480x832" \
  -F seconds=5
# -> {"id": "video_...", "status": "queued", ...}
```

A JSON body with `reference_url` works instead of multipart when the input
image is already hosted.

```bash
# 2. Poll until status == "completed"
curl -s https://inference.nidora.ai/v1/videos/video_... \
  -H "CF-Access-Client-Id: $CF_ACCESS_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_SECRET"

# 3. Download the mp4
curl -s https://inference.nidora.ai/v1/videos/video_.../content \
  -H "CF-Access-Client-Id: $CF_ACCESS_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_SECRET" -o out.mp4
```

Generation parameters beyond the OpenAI schema (seed, negative prompt, step
count, guidance, fps) are passed as extra form/body fields — confirm the
exact accepted names against the server's OpenAPI schema at `/openapi.json`
for the pinned SGLang version.

## Recommended defaults (Wan 2.2 A14B + Lightning distill LoRA)

- 81 frames @ 16 fps ≈ 5 s (the model's native pacing)
- 4 inference steps, guidance 1.0 (the distill LoRA is a 4-step distill)
- fixed `seed` for reproducibility

## Client-side sizing (aspect-preserving 480p)

`size` is explicit per request. To keep the input image's aspect ratio at the
largest resolution fitting the 480p pixel budget (480×832), compute:

```python
import math

def fit_480p(img_w: int, img_h: int) -> str:
    scale = math.sqrt((480 * 832) / (img_w * img_h))
    w = max(16, round(img_w * scale) // 16 * 16)
    h = max(16, round(img_h * scale) // 16 * 16)
    return f"{w}x{h}"
```

(720p budget: replace `480 * 832` with `720 * 1280`.)

## Other endpoints

Beyond video generation, the server also exposes (one-liners here; details
in the [upstream API docs](https://docs.sglang.io/docs/sglang-diffusion/api/openai_api)):

| Endpoint | Purpose |
|---|---|
| `GET /models` | served model info (task type, precision) |
| `GET /v1/videos` | list videos with status (also used for polling) |
| `POST /v1/images/generations`, `/v1/images/edits`, `GET /v1/images/{id}/content` | image generation/editing (unused by us; the served model is i2v) |
| `POST /v1/set_lora`, `/v1/merge_lora_weights`, `/v1/unmerge_lora_weights`, `GET /v1/list_loras` | runtime LoRA management (we load the LoRA at launch via `LORA_PATH`) |

Note: the server listens on `PORT` (8000 in our image; upstream's own
default is 30000 — their docs' `30010` examples are just avoiding a
co-located LLM server).

## Health / readiness

`GET /health` (no auth). With server-mode warmup (the default) the model is
loaded and warmed before the server reports ready, so a healthy server is a
fast server — no first-job load penalty.
