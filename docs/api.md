# Client API reference

The API served at `https://<your-hostname>`. Submit a job, poll it, download
the result. The gateway assigns the work to a warm pod or queues it until one is
free.

> This is the **gateway** API. The SGLang Diffusion API it wraps is an internal
> detail of a pod, bound to `127.0.0.1` and never reachable from outside —
> see [SGLang underneath](#sglang-underneath).

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

`GET /health` is the one unauthenticated route, so probes and the tunnel work.

## Submit a job

```bash
curl -sX POST https://<your-hostname>/v1/jobs \
  -H "X-Api-Key: $KEY" \
  -H "CF-Access-Client-Id: $CF_ACCESS_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_SECRET" \
  -H 'content-type: application/json' \
  -d '{
    "pipeline": "wan22-i2v",
    "params": {
      "image": "data:image/jpeg;base64,/9j/4AAQ...",
      "prompt": "the woman smiles and waves at the camera",
      "negative_prompt": "",
      "resolution": "480p"
    }
  }'
```

```json
{ "id": "j_ab12cd34ef56", "state": "queued", "progress": 0, "error": null,
  "artifacts": [], "queue_position": 0,
  "params": { "size": "464x832", "seconds": 5, "num_inference_steps": 4, ... },
  "created_at": "2026-08-08T09:41:24.837Z" }
```

Returns `202`. It never blocks on a pod — a submission completes in
milliseconds whether or not any capacity exists.

### Parameters

| Field | Required | Notes |
|---|---|---|
| `pipeline` | yes | Must be one of `GET /v1/pipelines`. Unknown values give 404. |
| `params.image` | yes | Image **bytes** as a base64 data URI (or bare base64). JPEG, PNG or WebP, sniffed from the content — the declared mime type is ignored. URLs are refused. |
| `params.prompt` | yes | Up to 2000 characters. |
| `params.negative_prompt` | no | Defaults to the pipeline's tuned negative prompt. |
| `params.resolution` | no | `480p` (default) or `720p`. |
| `params.seconds` | no | Clamped to the pipeline's limit. |
| `params.num_inference_steps` | no | Clamped. The Lightning distill LoRA is a 4-step distill; more steps make output worse, not better. |
| `params.seed` | no | Integer, for reproducibility. |

`size` is **not** a parameter. The gateway reads the input image's header and
computes an aspect-preserving, 16-pixel-aligned frame that fits the resolution's
pixel budget (480×832, or 720×1280 at 720p), bounded so a pathological aspect
ratio cannot request a frame the model can't render. `params.size` in the
response tells you what it chose.

Guidance scale and other engine knobs are owned by the gateway and not client-settable.

## Poll

```bash
curl -s https://<your-hostname>/v1/jobs/j_ab12cd34ef56 -H "X-Api-Key: $KEY" ...
```

Poll every few seconds. `state` is one of:

| State | Meaning |
|---|---|
| `queued` | Waiting for a pod. `queue_position` shows how many jobs are ahead. |
| `running` | A pod is generating it. |
| `completed` | Done; `artifacts[0].url` is ready to download. |
| `failed` | `error` explains why. |
| `cancelled` | Cancelled by a client, or by the gateway after a cancel request. |

These five are the complete set and will not grow without a coordinated client
change — see [gateway.md](gateway.md#the-client-contract).

## Download

```bash
curl -s "https://<your-hostname>$(…artifacts[0].url)" \
  -H "X-Api-Key: $KEY" ... -o out.mp4
```

`artifacts[0].url` is **relative** (`/v1/outputs/<job_id>/output.mp4`) and served
by the gateway with a `200` and a body — never a redirect to object storage.
Send the same API key.

`410 Gone` means the artifact was swept by the retention TTL (24 h by default);
`404` means it never existed. Download promptly and store the clip yourself.

## Cancel

```bash
curl -sX DELETE https://<your-hostname>/v1/jobs/j_ab12cd34ef56 -H "X-Api-Key: $KEY" ...
```

A queued job becomes `cancelled` immediately. A running one returns
`{"id": "...", "state": "cancelling"}` and the pod stops on its next poll.

Note that `cancelling` appears **only in this response body**. The job's own
`state` stays `running` until the cancellation lands, then becomes `cancelled`.

Whether the GPU actually stops depends on SGLang supporting cancellation of an
in-flight video job; if it does not, the pod abandons the result and the
capacity frees up when generation finishes on its own.

## Other endpoints

| Endpoint | Purpose |
|---|---|
| `GET /v1/jobs?state=&limit=` | List jobs, newest first |
| `GET /v1/jobs/:id/events` | Lifecycle trail — why a job took as long as it did |
| `GET /v1/pipelines` | What this deployment can run, with defaults |
| `GET /health` | Queue depth and fleet capacity (no auth) |
| `GET /metrics` | Prometheus exposition |
| `GET /v1/pods` | Per-pod state (admin key) |
| `POST /v1/pods/:id/drain` | Stop assigning new work to a pod (admin key) |

## Errors

| Status | Meaning |
|---|---|
| 400 | Bad parameters — `detail` says which |
| 401 | Missing or wrong API key |
| 404 | Unknown job, or unknown `pipeline` (with `available`) |
| 409 | Cancelling a job that already finished |
| 410 | The artifact expired |
| 413 | Payload past the configured limit |
| 503 | Queue is full — honour `Retry-After` and consider another provider |

A 503 is deliberate backpressure: past a certain depth the queue cannot clear
inside a caller's timeout, so a fast refusal beats twenty minutes of polling
followed by a failure. See [gateway.md](gateway.md#backpressure-not-false-hope).

## Recommended defaults (Wan 2.2 A14B + Lightning distill LoRA)

- 81 frames @ 16 fps ≈ 5 s — the model's native pacing, and the `seconds: 5` default
- 4 inference steps, guidance 1.0 — the distill LoRA is a 4-step distill
- a fixed `seed` when you need reproducibility

## SGLang underneath

Each pod runs SGLang Diffusion's OpenAI-compatible API
([upstream docs](https://docs.sglang.io/diffusion/api/openai_api.html)) on
`127.0.0.1:8000`. The gateway's agent translates a job into a
`POST /v1/videos` multipart request, polls `GET /v1/videos/{id}`, and fetches
`GET /v1/videos/{id}/content`.

That server has **no authentication of its own**, which is exactly why it is
bound to localhost in gateway mode. Clients never speak to it.

The exact field names SGLang accepts (`negative_prompt`, `num_inference_steps`,
`guidance_scale`, `seed`) should be confirmed against a pod's `/openapi.json`
for the pinned version. They live in
[`gateway/src/domain/pipelines.ts`](../gateway/src/domain/pipelines.ts) and
[`scheduler/claim.ts`](../gateway/src/scheduler/claim.ts), so correcting them is
a gateway redeploy rather than a pod image rebuild.

A pod can still be run standalone as its own endpoint, speaking the raw SGLang
API — see [deploy-pods.md](deploy-pods.md#standalone-mode).
