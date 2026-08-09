# The gateway

The gateway is a queue and an orchestrator. Clients submit jobs to it; GPU pods
pull work from it. It owns job state, capacity accounting and the generated
media, and it is the only piece of this system with a stable address.

## Why it exists

Before it, each pod ran its own Cloudflare Tunnel and *was* the public endpoint.
That meant one hostname per pod, no cross-pod queue, no visibility into what was
running, and a hostname that died with the pod. Rented GPUs are ephemeral by
nature — the address of the service should not be.

## Shape

```
   client application                             rented GPU pod
        │                                    ┌─────────────────────────┐
        │ POST /v1/videos                    │ sglang serve            │
        │ X-Api-Key + CF-Access              │   127.0.0.1:8000        │
        ▼                                    │        ▲                │
 ┌──────────────────┐                        │        │ http           │
 │ public hostname  │   Cloudflare Tunnel    │  nidora_agent           │
 │ (Access, service │◄───────────────────────┴────────┬────────────────┘
 │  token policy)   │                                 │ POST /v1/agent/poll
 │                  │◄────────────────────────────────┘ (long-poll, ≤25s)
 └────────┬─────────┘
          ▼
 ┌──────────────────────────────┐
 │ inference-gateway :8080      │  Fastify · SQLite (WAL) · /data volume
 │  queue · leases · artifacts  │
 └──────────────────────────────┘
```

Pods are strictly outbound. Nothing connects *to* a pod, which is why they need
no port, no tunnel and no DNS record of their own.

## Job lifecycle

```
        POST /v1/videos
              │
              ▼
        ┌──────────┐   a pod polls and claims it    ┌──────────┐
        │  queued  │ ──────────────────────────────►│ running  │
        └────┬─────┘   (CAS, mints a lease)         └────┬─────┘
             │                                            │
             │ DELETE                    ┌────────────────┼──────────────┐
             │                           │                │              │
             ▼                           ▼                ▼              ▼
        ┌───────────┐              ┌───────────┐   ┌──────────┐   ┌──────────┐
        │ cancelled │              │ completed │   │  failed  │   │  queued  │
        └───────────┘              └───────────┘   └──────────┘   └──────────┘
                                                                   (requeued:
                                                                    lease expired
                                                                    or retryable)
```

There are exactly five states, and no more may be added without a coordinated
client change — see [the client contract](#the-client-contract).

## Leases: the one rule that makes this correct

When a pod claims a job, the gateway mints a `lease_id` and records it on the
row. Every subsequent call the pod makes about that job — reading the input,
uploading the clip, reporting the result — must present the same lease, and
every terminal write is a compare-and-swap on `(id, state, lease_id)`.

That single rule removes the entire duplicate-delivery hazard class:

> A pod is partitioned mid-generation. Its lease expires, the job is requeued,
> and a second pod generates and uploads the clip. The first pod's network
> comes back and it tries to report *its* result.

Without fencing, the late result overwrites the real one. With it, the write is
rejected with `409 stale_lease` and the pod drops the job. The agent's poll also
returns the job in `orphan[]`, so it stops working on it rather than burning GPU
time on output nobody will collect.

Leases renew on every poll that lists the job as in-flight, so a working pod
holds its lease indefinitely and a silent one loses it after `LEASE_TTL_S`.

## Readiness is not liveness

The single most important scheduling rule: **a pod that is reachable is not
necessarily a pod that can work.**

The agent starts the instant the container does, but `sglang serve` needs
around ten minutes to load a 14B model — and a pod with too little system RAM
is OOM-killed at load and restarts forever. Such a pod presents a perfectly
healthy agent indefinitely.

So the agent polls its own `GET /health` every cycle and reports `sglang_ready`,
and the gateway assigns nothing to a pod that is not ready. Jobs wait in the
queue instead of being dispatched to a pod that can never finish them.

## Failure handling

| What happened | What the gateway does |
|---|---|
| Pod stops polling mid-job | Lease expires after `LEASE_TTL_S` → requeue (`attempts++`), or fail at `MAX_ATTEMPTS` with `pod lost during generation`. |
| Pod reports a 5xx from SGLang | `retryable: true` → requeued for another pod. |
| Pod reports a 4xx from SGLang | `retryable: false` → failed immediately. Retrying a bad request elsewhere fails identically and burns the client's deadline. |
| Job exceeds its budget | Failed at `JOB_TTL_S` with `exceeded its 18m deadline (queued Ns, running Ms)` — a legible error instead of an opaque client timeout. |
| **Gateway restarts** | Running jobs are **not** failed. The work is on a pod that neither knows nor cares that the control plane bounced; leases are extended by one poll window, agents re-claim within ~25 s, and the reaper requeues whatever nobody claims. This is why `/data` must be a volume. |
| Client cancels a running job | `cancel_requested` is set; the pod picks it up on its next poll and acknowledges. If it never does, the reaper forces the transition after `CANCEL_GRACE_S`. |
| Two pods race for one job | The CAS means exactly one wins; the loser simply tries the next queued job. |

## Backpressure, not false hope

A client polls with a deadline and then gives up. Queueing beyond the point where
the backlog can clear inside that window converts "no capacity" into "a long
wait followed by a timeout" — slower, more confusing, and you paid for the GPU
time either way.

So `POST /v1/videos` returns `503` with `Retry-After` once the queue passes
`MAX_QUEUE_DEPTH`, letting the caller fall back to another provider immediately.
Set it high enough that it never fires in normal operation: clients generally treat
any non-2xx as a hard failure for that shot.

## What the client cannot control

`model` is matched against a closed registry ([models.ts]) and never
reaches a model path, a LoRA path, or SGLang's runtime LoRA endpoints — an
attacker-chosen HuggingFace repo loaded onto the GPU is `trust_remote_code`
remote code execution. Duration, step count and guidance are gateway-owned and
clamped, because `seconds=600, steps=500` is a queue-starvation lever. The input
must be image *bytes*; URLs are refused, so there is no path by which a
client-supplied address becomes a fetch from the gateway or a pod.

[models.ts]: ../gateway/src/domain/models.ts

## Storage

SQLite in WAL mode on the `/data` volume, alongside the inputs and generated
media. Deliberately not a shared external database, for three reasons: the
gateway is already stateful on local disk (artifacts must be served from here —
see [the client contract](#the-client-contract)), an inference control plane
should keep draining while unrelated services are restarted, and
`better-sqlite3` is synchronous, which makes every compare-and-swap an atomic
operation with no await points to reason about.

The cost is that the gateway is a single replica. All SQL is confined to
[`db/jobs.ts`](../gateway/src/db/jobs.ts) and [`db/pods.ts`](../gateway/src/db/pods.ts)
behind an interface, so moving to Postgres later is a one-file change.

```
/data/db/gateway.sqlite          jobs, pods, job_events
/data/inputs/<job_id>/input.jpg  deleted the moment the job reaches a terminal state
/data/artifacts/<job_id>/output.mp4
```

Artifacts expire after `ARTIFACT_TTL_HOURS` and job rows after
`JOB_RETENTION_DAYS`. This is an availability control, not housekeeping: when
the gateway is co-located with other services, a full volume takes them down
with it. Clients are expected to download each clip promptly and keep their own
copy, so the retention window is slack rather than storage.

## The client contract

The job API is a stable contract, and three of its properties are load-bearing
for any client. They are enforced by
[`contract.test.ts`](../gateway/test/contract.test.ts), which models a strict
client parser and runs it against real gateway responses — so a refactor that
breaks one of them fails the build rather than the integration:

1. **Five statuses only** — `queued`, `in_progress`, `completed`, `failed`,
   `cancelled`. A client is entitled to treat an unknown state as an error, so
   the set must not grow without a coordinated change. There is deliberately no
   `cancelling` status: a cancel in flight is an `in_progress` video with a
   flag. They are SGLang's statuses, which are OpenAI's.
   (`DELETE` may *report* `"state":"cancelling"` in its own response body; that
   is not the job's state.)
2. **No server-supplied URLs** — the content lives at
   `/v1/videos/<id>/content`, derived from the id the client already holds. The
   API hands over no URL to follow, so a credential-sending client has nothing
   to validate and a pod-controlled filename has nothing to steer.
3. **Creation does not block** — `POST /v1/videos` writes the record and returns
   `202` without touching a pod, so it stays fast enough for a short client
   timeout even when no capacity exists.

## Tuning

| Env | Default | Why that value |
|---|---|---|
| `LEASE_TTL_S` | 120 | Tolerance for a slow or briefly-partitioned pod before its work is reclaimed. |
| `MAX_POLL_WAIT_S` | 25 | Comfortably inside Cloudflare's documented 125 s proxy read timeout. |
| `JOB_TTL_S` | 1080 (18 min) | Inside a typical client's polling deadline, so the gateway fails first and says why. |
| `MAX_ATTEMPTS` | 2 | One retry on another pod; more just spends the deadline. |
| `CANCEL_GRACE_S` | 60 | How long to wait for a pod to acknowledge a cancel before forcing it. |
| `POD_STALE_S` | 90 | A few poll cycles, so one dropped request doesn't drop the pod off the dashboard. |
| `MAX_QUEUE_DEPTH` | 200 | Admission-control ceiling. Raise it rather than let it fire in normal operation. |
| `BODY_LIMIT_BYTES` | 32 MiB | The image arrives as base64, ≈4/3 its size. Fastify's 1 MB default rejects every real request. |
| `ARTIFACT_TTL_HOURS` | 24 | Slack over the seconds a client actually needs. |

## Endpoints

Client (`X-Api-Key`):

| Route | Purpose |
|---|---|
| `POST /v1/videos` | Create (multipart); returns 200 |
| `GET /v1/videos/:id` | Poll |
| `GET /v1/videos` | List (`?status=`, `?limit=`) |
| `DELETE /v1/videos/:id` | Cancel |
| `GET /v1/videos/:id/events` | Lifecycle audit trail |
| `GET /v1/videos/:id/content` | Download the clip |
| `GET /v1/models` | What the fleet is serving right now |

Operator (`X-Admin-Key`, falling back to a client key):
`GET /v1/pods`, `POST /v1/pods/:id/drain`.

Unauthenticated: `GET /health`, `GET /metrics`.

Pod agent (`X-Agent-Secret`): see [agent-protocol.md](agent-protocol.md).

## Observability

`/health` gives queue depth, the age of the oldest queued job, and fleet
capacity. `/metrics` exports the same in Prometheus format — deliberately the
exact set of series an autoscaler would need:

```
nidora_queue_depth              nidora_pods_connected
nidora_jobs_queued              nidora_pods_ready
nidora_jobs_running             nidora_pod_slots_total
nidora_oldest_queued_seconds    nidora_pod_slots_busy
```

Adding automatic pod provisioning later is a matter of reading these and driving
the Vast/RunPod APIs; nothing new needs instrumenting.

`GET /v1/videos/:id/events` answers "why did this take fourteen minutes" with
a timestamped trail: `created → assigned → uploaded → completed`, including any
`requeued` or `lease_expired` in between.
