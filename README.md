# nidora-ai-inference

Self-hosted media generation on rented GPU pods, served by
[SGLang Diffusion](https://docs.sglang.io/diffusion/) behind a queue-tracking
gateway.

Two pieces:

| | What it is |
|---|---|
| **[gateway/](gateway/)** | Node 22 + Fastify service at `https://<your-hostname>`. Owns the job queue, tracks pod capacity, and exposes one stable API to clients. |
| **[Dockerfile](Dockerfile) + [agent/](agent/)** | The GPU pod image: pinned SGLang Diffusion, plus a small Python agent that dials **out** to the gateway and pulls work. |

Any model family SGLang Diffusion supports can be served by pointing
`MODEL_PATH` at its HuggingFace repo id (browse the
[cookbook](https://docs.sglang.io/cookbook/diffusion/) for the catalog).

```
 client ──► <your-hostname> ──► Cloudflare Tunnel ──► gateway ◄── pods pull jobs
            (X-Api-Key + CF Access)                       (queue,      (outbound only:
                                                           artifacts)   no port, no DNS)
```

The pods have no inbound reachability at all — no published port, no tunnel of
their own, no DNS record. They connect out, ask for work, and hand results
back. Adding or destroying a pod is an env-var change, not a DNS change.

- Gateway image: `ghcr.io/nidora-software/nidora-ai-inference/gateway`
- Pod image: `erenck/nidora-ai-inference:latest` (also on GHCR), built on
  `lmsysorg/sglang:v0.5.16-cu129` + `sglang[diffusion]`
- Experimental pod image: `erenck/nidora-ai-inference:experimental` — same
  layout on a date-pinned SGLang **nightly**
  ([Dockerfile.nightly](Dockerfile.nightly)), for models merged upstream but not
  yet released. Trial pods only, never production.

## Documentation

| Doc | For |
|---|---|
| [docs/gateway.md](docs/gateway.md) | How the gateway works: queue, leases, failure handling, tuning |
| [docs/api.md](docs/api.md) | The client API — submit a job, poll, download |
| [docs/agent-protocol.md](docs/agent-protocol.md) | The pod↔gateway protocol |
| [docs/deploy-pods.md](docs/deploy-pods.md) | Running pods on Vast.ai / RunPod |
| [deploy/README.md](deploy/README.md) | Deploying the gateway and its tunnel |

## The client API

Submit, poll, download — the gateway assigns the job to a warm pod, or queues
it until one is free.

```bash
curl -X POST https://<your-hostname>/v1/videos \
  -H "X-Api-Key: $KEY" \
  -H "CF-Access-Client-Id: $CF_ACCESS_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_SECRET" \
  -F "model=Wan-AI/Wan2.2-I2V-A14B-Diffusers" \
  -F "prompt=the woman smiles and waves at the camera" \
  -F "input_reference=@frame.jpg;type=image/jpeg"

# -> {"id":"video_ab12cd34ef56","object":"video","status":"queued", ...}
```

Full reference, including the artifact download and what each state means, in
[docs/api.md](docs/api.md).

## Configuration

### Pod

Everything is env-driven — no code changes to switch models or tune:

| Env | Required | Purpose |
|---|---|---|
| `MODEL_PATH` | **yes** | HF repo id or local path of the served model |
| `LORA_PATH` | no | LoRA repo id/path; unset = no LoRA |
| `PORT` | no | SGLang HTTP port (default 8000) |
| `SGLANG_HOST` | no | Bind address (default `0.0.0.0`; use `127.0.0.1` in gateway mode) |
| `SGLANG_EXTRA_ARGS` | no | extra `sglang serve` flags (attention backend, offload, torch compile, parallelism) |
| `GATEWAY_URL` | gateway mode | Enables the pull agent, e.g. `https://<your-hostname>` |
| `GATEWAY_AGENT_SECRET` | gateway mode | Shared secret for the agent control plane |
| `CF_ACCESS_CLIENT_ID` / `_SECRET` | gateway mode | Cloudflare Access service token |
| `POD_ID` | no | Stable pod identity; auto-detected from the provider |
| `AGENT_MAX_IN_FLIGHT` | no | Concurrent jobs (default 1 — SGLang serialises on the GPU) |
| `CF_TUNNEL_TOKEN` | standalone mode | Cloudflare Tunnel, for running a pod as its own endpoint |

A pod with `GATEWAY_URL` unset behaves exactly as it did before the gateway
existed: cloudflared plus a public SGLang port. Existing templates keep working
untouched.

Model weights are never baked into the image; they download once into the
volume-backed HF cache (`HF_HOME=/workspace/hf`).

### Gateway

See [deploy/README.md](deploy/README.md) for secrets and
[docs/gateway.md](docs/gateway.md#tuning) for the timing knobs.

## Run a pod

Gateway mode — the pod is invisible from the internet:

```bash
docker run --gpus all \
  -v /path/to/volume:/workspace \
  -e MODEL_PATH=<org/model-repo> \
  -e LORA_PATH=<org/lora-repo> \
  -e SGLANG_HOST=127.0.0.1 \
  -e GATEWAY_URL=https://<your-hostname> \
  -e GATEWAY_AGENT_SECRET=<secret> \
  -e CF_ACCESS_CLIENT_ID=<id>.access \
  -e CF_ACCESS_CLIENT_SECRET=<secret> \
  erenck/nidora-ai-inference:latest
```

Hardware requirements depend on the served model (check its cookbook page). As
a reference point, a bf16 14B-class video model wants an 80 GB GPU (H100/A100),
128 GB+ system RAM (fp32 snapshots stage through RAM at load), and a 300 GB
volume; smaller cards can work via SGLang offload/quantization flags at a
latency cost.

**Security note**: the SGLang diffusion server has **no built-in API auth** —
never expose its port publicly. In gateway mode bind it to `127.0.0.1`; in
standalone mode run tunnel-only with Cloudflare Access in front (see
[docs/deploy-pods.md](docs/deploy-pods.md)).

## Develop

```bash
# Gateway
cd gateway && npm ci && npm test && npm run typecheck

# Agent
cd agent && pip install -e ".[dev]" && python -m pytest
```

Neither suite needs a GPU. The gateway's tests drive its real HTTP surface
in-process; the agent's pytest suite drives the real agent against fake gateway
and SGLang servers over real sockets. What no longer has automated coverage is
the two of them talking to *each other* — that path is exercised by deploying
to a pod.

## Layout

```
gateway/                     # the queue/orchestrator service (Node + Fastify + SQLite)
agent/                       # the pod-side pull agent (Python), installed into the GPU image
Dockerfile                   # GPU pod image: pinned SGLang + diffusion extra + cloudflared + agent
Dockerfile.nightly           # same, on a date-pinned SGLang nightly
scripts/docker-entrypoint.sh # supervises cloudflared / sglang serve / the agent
deploy/                      # compose overlay, droplet provisioning, deployment guide
docs/                        # see the documentation table above
```
