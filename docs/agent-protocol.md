# Pod ↔ gateway protocol

Four HTTP endpoints under `/agent/v1`. Pods dial out to them; nothing ever
connects to a pod.

Every request carries:

```
X-Agent-Secret: <GATEWAY_AGENT_SECRET>
CF-Access-Client-Id: <service-token-id>.access
CF-Access-Client-Secret: <service-token-secret>
```

The Access headers are checked at Cloudflare's edge, the agent secret by the
gateway. A missing Access token shows up as a 302 to a login page rather than a
401 — that is the usual cause of an agent that "can't reach the gateway".

## Why long-poll and not a WebSocket

The correctness requirements are identical either way: a job handed to a pod
needs a lease, an expired lease needs to return the job to the queue, and a late
result from a superseded pod must be rejected. A socket would only shave the
dispatch latency.

What a socket *would* add is a reconnect state machine, per-connection send
buffers in the gateway's heap, and a hard dependency on Cloudflare's WebSocket
idle timeout — a value Cloudflare explicitly declines to publish. A 25-second
poll sits comfortably inside the documented 125-second proxy read timeout and
needs none of that. Dispatch latency is bounded by the poll window, and the
gateway wakes parked pollers the instant a job arrives, so in practice a job
reaches an idle pod in milliseconds.

## `POST /agent/v1/poll`

Registration, heartbeat, lease renewal, progress and dispatch in one round trip.
An idle pod costs exactly one in-flight request; a busy pod renews its leases
for free.

**Request**

```json
{
  "pod_id": "runpod-abc123",
  "agent_version": "0.1.0",
  "pipelines": ["wan22-i2v"],
  "max_in_flight": 1,
  "model_path": "Wan-AI/Wan2.2-I2V-A14B-Diffusers",
  "lora_path": "lightx2v/Wan2.2-Distill-Loras",
  "gpu": "H100 80GB",
  "sglang_ready": true,
  "wait_s": 25,
  "in_flight": [
    { "job_id": "j_ab12cd34ef56", "lease_id": "…", "progress": 0.4,
      "phase": "generating", "upstream_id": "video_…" }
  ]
}
```

`sglang_ready` is the agent's own `GET /health` result against its local SGLang
server, re-checked every cycle. While it is false the gateway assigns nothing —
see [gateway.md](gateway.md#readiness-is-not-liveness).

`pod_id` **must be stable across restarts**, or a pod orphans its own in-flight
work instead of reclaiming it. The agent derives it from `POD_ID`,
`RUNPOD_POD_ID`, `VAST_CONTAINER_ID`, `CONTAINER_ID`, then the hostname.

**Response**

```json
{
  "session_id": "…",
  "lease_ttl_s": 120,
  "poll_wait_s": 25,
  "assign": [ /* see below */ ],
  "cancel": ["j_…"],
  "orphan": ["j_…"],
  "drain": false
}
```

| Field | Meaning |
|---|---|
| `assign` | Jobs now owned by this pod. Start them. |
| `cancel` | A client cancelled these. Stop, cancel upstream if possible, report `cancelled`. |
| `orphan` | The gateway no longer recognises the pod's lease. **Abandon locally without uploading** — the job may already have been completed elsewhere. |
| `drain` | No new work will be assigned. Finish what is in flight; the pod is being retired. |

The gateway parks the request for up to `min(wait_s, MAX_POLL_WAIT_S)` when
there is nothing to do, and returns immediately when a job arrives.

### An assignment

```json
{
  "job_id": "j_ab12cd34ef56",
  "lease_id": "6f1c…",
  "pipeline": "wan22-i2v",
  "deadline_at": 1786182051349,
  "input": { "url": "/agent/v1/jobs/j_ab12cd34ef56/input",
             "sha256": "…", "bytes": 184320 },
  "sglang": {
    "endpoint": "/v1/videos",
    "fields": {
      "prompt": "the woman smiles and waves at the camera",
      "negative_prompt": "…",
      "size": "464x832",
      "seconds": 5,
      "num_inference_steps": 4,
      "guidance_scale": 1.0
    }
  }
}
```

`fields` is passed to SGLang as multipart form fields **verbatim**. The agent is
a dumb executor and invents nothing: frame sizing, defaults, the negative prompt
and clamping all happen gateway-side. That is deliberate — retuning generation
is a gateway redeploy, not a 30-minute CUDA image rebuild. It also means a field
name that drifts between SGLang versions is fixed by editing
[`pipelines.ts`](../gateway/src/domain/pipelines.ts), not by rebuilding pods.

## `GET /agent/v1/jobs/:id/input?lease_id=…`

The source image bytes. Verify them against the assignment's `sha256`.

`409 stale_lease` — you no longer own this job. `410` — the input has expired.

## `POST /agent/v1/jobs/:id/artifact?lease_id=…&filename=output.mp4`

The generated media as a **raw body** (`Content-Type: video/mp4`), not
multipart — there is nothing for an envelope to carry. Send
`X-Content-SHA256` so the gateway can detect a truncated upload.

The gateway streams it straight to a part file and renames it into place, so a
50 MB clip never lands in the heap and a retried upload is idempotent. Retry on
5xx; a 4xx is final.

`409 stale_lease` is returned before a single byte is written.

## `POST /agent/v1/jobs/:id/result?lease_id=…`

The terminal outcome. **Only send `completed` after the artifact upload returned
2xx** — a completed job whose bytes never arrived would 404 on download.

```json
{ "state": "completed", "filename": "output.mp4", "bytes": 2411008,
  "sha256": "…", "upstream_id": "video_…" }
```

```json
{ "state": "failed", "error": "sglang rejected the request (422): …",
  "retryable": false }
```

```json
{ "state": "cancelled" }
```

`retryable` decides whether the gateway hands the job to another pod or fails it
outright. The rule: **5xx and connection errors are retryable, 4xx is not.** A
different pod will reject a malformed request identically, and trying costs the
client a chunk of its twenty-minute budget.

A `409 stale_lease` here means a superseded pod tried to report. Drop the job
silently; the gateway already has the real result.

If reporting fails entirely — the gateway is down, the tunnel is broken — give
up after a few attempts. The lease expires and the job is requeued. Nothing is
lost except the GPU time.

## Lease fencing

Every call above carries `lease_id`, and the gateway honours it only when it
matches the job's current lease. This is what makes at-least-once delivery safe:
a pod that comes back from a partition cannot overwrite the result of the pod
that actually finished the job. See
[gateway.md](gateway.md#leases-the-one-rule-that-makes-this-correct).

## Phases

Reported in `in_flight[].phase`, purely for operator visibility:

```
downloading_input → submitting → generating → downloading_output → uploading
```

SGLang does not expose diffusion step progress, so `progress` is a coarse
"still working" signal rather than a true percentage. Its real function is
renewing the lease, which any poll does anyway.

## Implementations

- Agent: [`agent/src/nidora_agent/client.py`](../agent/src/nidora_agent/client.py)
  (poll loop) and [`runner.py`](../agent/src/nidora_agent/runner.py) (one job).
- Gateway: [`gateway/src/routes/agent.ts`](../gateway/src/routes/agent.ts).

Both sides are covered without a GPU by
[`deploy/compose.e2e.yml`](../deploy/compose.e2e.yml) and the agent's pytest
suite, which drives the real agent against fake gateway and SGLang servers over
real sockets.
