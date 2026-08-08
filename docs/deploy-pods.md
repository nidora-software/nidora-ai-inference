# Running pods on rented GPUs

The image is self-contained: SGLang Diffusion, the gateway pull agent, and
cloudflared. A pod needs a suitable GPU, a persistent volume, and env vars —
nothing else.

## Two modes

**Gateway mode (recommended).** Set `GATEWAY_URL`. The agent dials out to
`<your-hostname>`, pulls jobs, and hands results back. The pod publishes no
port, runs no tunnel, and needs no DNS record — nothing on it is reachable from
the internet. Adding or destroying a pod changes nothing outside the pod.

**Standalone mode (the original).** Set `CF_TUNNEL_TOKEN` and leave
`GATEWAY_URL` unset. The pod is its own public endpoint speaking the raw SGLang
API. Still supported and unchanged; useful for one-off experiments.

An image with neither set serves SGLang on `0.0.0.0:8000` with no authentication
whatsoever — only ever do that on a trusted network.

## Before you start

- **GPU**: sized by the served model — a bf16 14B-class video model wants
  **80 GB** (H100/A100); smaller cards require SGLang offload flags via
  `SGLANG_EXTRA_ARGS` at a latency cost. Check the model's
  [cookbook page](https://docs.sglang.io/cookbook/diffusion/).
- **System RAM**: **128 GB+**. fp32 snapshots stage through RAM at load; a
  64 GB pod is OOM-killed mid-load and then restarts forever. In gateway mode
  such a pod reports itself as never-ready and is correctly given no work, but
  you are still paying for it — check the logs if a pod never turns ready.
- **Disk**: a persistent volume sized for the model snapshot (e.g. ≥ 300 GB for
  a ~126 GB snapshot). It downloads once into `HF_HOME=/workspace/hf`.
- **HF_TOKEN**: only for gated repos.

First boot runs: model download (one-time per volume) → load + warmup →
serving. That is roughly 10 minutes on a warm volume and considerably longer on
a fresh one. The gateway withholds work for the whole period.

## Gateway mode

Env for a pod joining the fleet:

| Env | Value |
|---|---|
| `MODEL_PATH` | e.g. `Wan-AI/Wan2.2-I2V-A14B-Diffusers` |
| `LORA_PATH` | e.g. `lightx2v/Wan2.2-Distill-Loras` (needed for 4-step generation) |
| `SGLANG_HOST` | `127.0.0.1` — nothing outside the pod should reach SGLang |
| `GATEWAY_URL` | `https://<your-hostname>` |
| `GATEWAY_AGENT_SECRET` | the fleet's agent secret |
| `CF_ACCESS_CLIENT_ID` | `<service-token-id>.access` |
| `CF_ACCESS_CLIENT_SECRET` | the service token secret |
| `AGENT_MAX_IN_FLIGHT` | `1` — SGLang serialises on the GPU anyway |
| `POD_ID` | optional; auto-detected from `RUNPOD_POD_ID` / `VAST_CONTAINER_ID` / hostname |

Leave `CF_TUNNEL_TOKEN` unset and publish no ports.

> What the pod serves is derived from `MODEL_PATH`: the gateway looks the
> model up in its registry and dispatches only work for that model. A pod
> loading a model the gateway doesn't know takes no work at all — check
> `/v1/pods` if a pod stays idle.

> `POD_ID` must be **stable across restarts**. A value that changes every boot
> makes a restarting pod orphan its own in-flight work instead of reclaiming it.

Verify from the gateway side:

```bash
curl -s https://<your-hostname>/health ...          # pods.ready should rise
curl -s https://<your-hostname>/v1/pods -H "X-Api-Key: $KEY" ... | jq
```

Then submit a clip per [api.md](api.md).

### Retiring a pod

```bash
curl -sX POST https://<your-hostname>/v1/pods/<pod_id>/drain -H "X-Api-Key: $KEY" ...
```

New work stops immediately; in-flight jobs finish. Wait for `in_flight: 0` in
`/v1/pods`, then destroy it. Destroying a pod without draining is safe too —
its jobs are requeued once their leases expire — it just costs a retry.

## Vast.ai

Template walkthrough: [vastai-template-readme.md](vastai-template-readme.md).
Summary: image `erenck/nidora-ai-inference:latest`, Docker ENTRYPOINT mode,
300 GB volume at `/workspace`, the gateway-mode env above, **no port mapping**.
Filter offers: H100/A100 80 GB, CPU RAM ≥ 128 GB, Min CUDA 12.9, high
`inet_down`.

## RunPod

Template walkthrough: [runpod-template-readme.md](runpod-template-readme.md).
Same image and env, network volume at `/workspace`. In gateway mode do **not**
expose an HTTP port — RunPod's `*.proxy.runpod.net` is publicly reachable and
SGLang has no authentication.

## Standalone mode

For a pod acting as its own endpoint, without the gateway:

1. Cloudflare Zero Trust → Networks → Tunnels → create a `cloudflared` tunnel,
   copy the token.
2. Public hostname: `<name>.<your-domain>` → `HTTP://localhost:8000`.
3. Set `CF_TUNNEL_TOKEN` on the template; leave `GATEWAY_URL` unset. The tunnel
   is outbound-only — no port mapping needed.

**Auth is required** — SGLang's diffusion server has no built-in API auth, so
protect the hostname with Cloudflare Access:

1. Zero Trust → Access → **Service Auth** → create a **Service Token**.
2. Zero Trust → Access → **Applications** → add a self-hosted application for
   the hostname.
3. Add a policy with action **Service Auth** requiring that token.

Clients then send `CF-Access-Client-Id` / `CF-Access-Client-Secret`, and speak
the raw SGLang API (`POST /v1/videos` → poll → `/content`) rather than the
gateway's job API.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Pod never appears in `/v1/pods` | Agent can't reach the gateway. Usually a missing Access service token — the edge returns a login redirect, not a 401. Check the container logs for the agent's poll errors. |
| Pod appears but `sglang_ready` stays false | Model still loading (normal for ~10 min), or the server is OOM-looping at load. Check `docker logs` for exit code -9 and confirm ≥ 128 GB system RAM. |
| Videos stay `queued` with a ready pod | Model mismatch: the video's `model` is not what the pod's `MODEL_PATH` loaded. `/v1/pods` shows each pod's resolved `model` — `null` means the gateway does not recognise that model. |
| Jobs fail with `pod lost during generation` | The pod stopped polling for longer than the lease TTL — it was destroyed, lost network, or its agent died. |
| Container exits right after start | A supervised process failed. The entrypoint logs which one before stopping the rest. |
