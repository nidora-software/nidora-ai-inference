# Client API reference

The API served at `https://<your-hostname>`. Create a video, poll it, download
the content.

**It is deliberately the same API SGLang Diffusion serves — which is OpenAI's.**
A client that can talk to a single SGLang server can talk to a whole fleet of
pods by changing the base URL and nothing else. The gateway adds a queue,
leases, retries and admission control behind that surface; it does not invent a
vocabulary of its own.

> The SGLang server this fronts is an internal detail of a pod, bound to
> `127.0.0.1` and never reachable from outside — see
> [SGLang underneath](#sglang-underneath).

## Authentication

Two headers, both required:

```
X-Api-Key: <gateway api key>
CF-Access-Client-Id: <service-token-id>.access
CF-Access-Client-Secret: <service-token-secret>
```

The Cloudflare Access service token is checked at Cloudflare's edge; the API key
by the gateway. `Authorization: Bearer <key>` is accepted in place of
`X-Api-Key`.

A missing Access token gives a redirect to a login page, not a 401 — if you see
HTML where JSON should be, that is why.

`GET /health` and `GET /metrics` are the unauthenticated routes at the gateway,
so probes work. Access still covers them unless you add a bypass policy for the
path — see [deploy/README.md](../deploy/README.md).

## Create a video

`multipart/form-data`, with the reference image as a file part. This is how
SGLang takes it, and it avoids inflating every image by a third the way a
base64 JSON body does.

```bash
curl -sX POST https://<your-hostname>/v1/videos \
  -H "X-Api-Key: $KEY" \
  -H "CF-Access-Client-Id: $CF_ACCESS_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_SECRET" \
  -F "model=Wan-AI/Wan2.2-I2V-A14B-Diffusers" \
  -F "prompt=the woman smiles and waves at the camera" \
  -F "input_reference=@frame.jpg;type=image/jpeg"
```

```json
{
  "id": "video_ab12cd34ef56",
  "object": "video",
  "model": "Wan-AI/Wan2.2-I2V-A14B-Diffusers",
  "status": "queued",
  "progress": 0,
  "created_at": 1786553284,
  "completed_at": null,
  "expires_at": null,
  "size": "464x832",
  "seconds": 5,
  "error": null,
  "pod_id": null,
  "attempts": 0,
  "queue_position": 0
}
```

Returns `200`. It does not block on a pod: creation completes in milliseconds
and the video queues.

### Fields

| Field | Required | Notes |
|---|---|---|
| `model` | yes | Must be one of `GET /v1/models`. Unknown values give 404 with the list. |
| `input_reference` | yes | The image, as a **file part**. JPEG, PNG or WebP, sniffed from the content — the declared type is ignored. |
| `prompt` | yes | Up to 2000 characters. |
| `negative_prompt` | no | Defaults to the model's tuned negative prompt. |
| `size` | no | `WxH`, or a resolution label (`480p`/`720p`). Omit and the gateway derives one from the image. |
| `seconds` | no | Clamped to the model's limit. |
| `num_inference_steps` | no | Clamped. The Lightning distill LoRA is a 4-step distill; more steps make output worse, not better. |
| `seed` | no | Integer, for reproducibility. |

Omitting `size` is the recommended path: the gateway reads the image header and
computes an aspect-preserving, 16-pixel-aligned frame that fits the resolution's
pixel budget (480×832, or 720×1280 at 720p), bounded so a pathological aspect
ratio cannot request a frame the model can't render. Supplying `size` is
supported for parity with SGLang, and is validated against the same bounds — a
frame outside them is a 400, not a job that fails twenty minutes later.

Guidance scale and the remaining engine knobs are owned by the gateway and not
client-settable.

## Poll

```bash
curl -s https://<your-hostname>/v1/videos/video_ab12cd34ef56 -H "X-Api-Key: $KEY" ...
```

Poll every few seconds. `status` is one of:

| Status | Meaning |
|---|---|
| `queued` | Waiting for a pod. `queue_position` shows how many are ahead. |
| `in_progress` | A pod is generating it. `progress` climbs 0 → 100. |
| `completed` | Done; the content is ready to download until `expires_at`. |
| `failed` | `error.message` explains why. |
| `cancelled` | Cancelled by a client, or by the gateway after a cancel request. |

These five are the complete set and will not grow without a coordinated client
change — see [gateway.md](gateway.md#the-client-contract).

`created_at`, `completed_at` and `expires_at` are **unix seconds**. `progress`
is an integer percentage.

## Download

```bash
curl -s https://<your-hostname>/v1/videos/video_ab12cd34ef56/content \
  -H "X-Api-Key: $KEY" ... -o out.mp4
```

The path is derived from the id — the API never hands you a URL to follow, so
there is nothing for a credential-sending client to have to validate. Served
with a `200` and a body, never a redirect to object storage.

`410 Gone` means the content was swept by the retention TTL (24 h by default);
`404` means no such video; `409` means it has not finished yet. Download
promptly and store the clip yourself.

## Cancel

```bash
curl -sX DELETE https://<your-hostname>/v1/videos/video_ab12cd34ef56 -H "X-Api-Key: $KEY" ...
```

A queued video becomes `cancelled` immediately and returns `200`. One already
running returns `202` with `status` still `in_progress`; the pod stops on its
next poll and the status becomes `cancelled` then.

There is deliberately no `cancelling` status — a client is entitled to map
exactly the five above.

Whether the GPU actually stops depends on SGLang supporting cancellation of an
in-flight video job; if it does not, the pod abandons the result and the
capacity frees up when generation finishes on its own.

## Other endpoints

| Endpoint | Purpose |
|---|---|
| `GET /v1/models` | Models the fleet is serving **right now**, with defaults and limits |
| `GET /v1/videos?status=&limit=` | List, newest first, in an `{"object":"list","data":[…]}` envelope |
| `GET /v1/videos/:id/events` | Lifecycle trail — why a video took as long as it did |
| `GET /health` | Queue depth and fleet capacity (no gateway auth) |
| `GET /metrics` | Prometheus exposition |
| `GET /v1/pods` | Per-pod state (admin key) |
| `POST /v1/pods/:id/drain` | Stop assigning new work to a pod (admin key). No body needed. |
| `DELETE /v1/pods/:id/drain` | Resume dispatch to a drained pod (admin key) |

`GET /v1/models` answers what the fleet can run at this moment, exactly as
SGLang's `/models` answers it for one server: a model appears only while a pod
serving it is connected. An empty fleet returns an empty list rather than
advertising an indefinite queue.

## Errors

| Status | Meaning |
|---|---|
| 400 | Bad parameters — `detail` says which |
| 401 | Missing or wrong credential. Always `{"detail":"invalid or missing API key"}`, including on the admin routes — a 401 never reveals which credential a route wants. |
| 404 | Unknown video, or unknown `model` (with `available`) |
| 409 | Cancelling a video that already finished, or downloading one that has not |
| 410 | The content expired |
| 413 | `input_reference` past the configured limit |
| 415 | Not `multipart/form-data` |
| 503 | No pod is serving that model, or the queue is full — honour `Retry-After` |

Both 503s are deliberate backpressure. Nothing in the fleet serving your model
means the video could only sit in the queue until its deadline, and past a
certain depth the queue cannot clear inside a caller's timeout — a fast refusal
beats twenty minutes of polling followed by a failure. See
[gateway.md](gateway.md#backpressure-not-false-hope).

A pod that is connected but still loading its model **does** count as capacity:
warmup takes ~10 minutes, and rejecting for that window would be worse than
queueing through it.

## Recommended defaults (Wan 2.2 A14B + Lightning distill LoRA)

- 81 frames @ 16 fps ≈ 5 s — the model's native pacing, and the `seconds: 5` default
- 4 inference steps, guidance 1.0 — the distill LoRA is a 4-step distill
- a fixed `seed` when you need reproducibility

## SGLang underneath

Each pod runs SGLang Diffusion's OpenAI-compatible API
([upstream docs](https://docs.sglang.io/diffusion/api/openai_api.html)) on
`127.0.0.1:8000`. The gateway's agent translates an assignment into a
`POST /v1/videos` multipart request, polls `GET /v1/videos/{id}`, and fetches
`GET /v1/videos/{id}/content` — the same three calls this API exposes, which is
why the two surfaces match.

That server has **no authentication of its own**, which is exactly why it is
bound to localhost in gateway mode. Clients never speak to it.

The exact field names SGLang accepts (`negative_prompt`, `num_inference_steps`,
`guidance_scale`, `seed`) should be confirmed against a pod's `/openapi.json`
for the pinned version. They live in
[`gateway/src/domain/models.ts`](../gateway/src/domain/models.ts) and
[`scheduler/claim.ts`](../gateway/src/scheduler/claim.ts), so correcting them is
a gateway redeploy rather than a pod image rebuild.

### Where the two surfaces differ

The gateway is a fleet, so a few things exist here that cannot exist on a single
server, and one field is typed more strictly:

- `queue_position`, `pod_id` and `attempts` are gateway extras on the video
  object. An OpenAI-shaped client ignores unknown fields.
- `503` with `Retry-After` — a single server has no queue to be full.
- `seconds` is returned as a **number**, where OpenAI returns a string.
- `GET /v1/models` carries `resolutions`, `defaults`, `limits` and `pods_ready`
  alongside the standard `id`/`object`.

A pod can still be run standalone as its own endpoint, speaking the raw SGLang
API — see [deploy-pods.md](deploy-pods.md#standalone-mode).
