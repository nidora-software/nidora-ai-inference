# Deploying the gateway

The gateway runs as a container behind a Cloudflare Tunnel. It can share a host
with an existing Docker Compose stack or run on its own. Nothing is published on
the host — the tunnel connects outbound and reaches the gateway over the compose
network.

```
clients ──► <your-hostname> ──► Cloudflare Tunnel ──► inference-gateway:8080
pods    ──► <your-hostname> ──┘                        (compose network only)
```

## 1. Secrets

Generate them once and put them in the compose stack's `.env`:

```bash
echo "INFERENCE_API_KEYS=$(openssl rand -hex 32)"     >> .env   # clients
echo "INFERENCE_AGENT_SECRET=$(openssl rand -hex 32)" >> .env   # pods
```

| Variable | Who holds it | Notes |
|---|---|---|
| `INFERENCE_API_KEYS` | the client application | Comma-separated. Add a second value, migrate clients, then drop the first — that is the whole rotation procedure. |
| `INFERENCE_AGENT_SECRET` | every pod, as `GATEWAY_AGENT_SECRET` | Enrollment-grade only — see the warning below. |
| `INFERENCE_ADMIN_KEYS` | operators | Optional; falls back to the client keys for `/v1/pods`. |
| `INFERENCE_CF_TUNNEL_TOKEN` | this box | From the Cloudflare tunnel you repoint in step 2. |

> **The agent secret lives on rented hardware.** It sits in a Vast.ai/RunPod
> template env var: stored in the provider's database, visible to `docker
> inspect`, on a machine someone else rented last week. Treat it as
> compromise-prone — anyone holding it can enroll a pod, pull jobs, and see
> input images and prompts. There is no attestation possible on rented GPUs.
> Rotate it whenever you retire a provider account.

## 2. Repoint the tunnel

`<your-hostname>` currently points at a pod. Move it to the gateway:

1. Cloudflare Zero Trust → **Networks → Tunnels** → the tunnel serving
   `<your-hostname>`.
2. Edit its public hostname: service becomes `HTTP` → `inference-gateway:8080`.
   Docker's embedded DNS resolves the compose service name.
3. Copy the tunnel token into `INFERENCE_CF_TUNNEL_TOKEN`.

The old per-pod tunnels can be deleted once the pods are switched to gateway
mode — in gateway mode a pod needs no tunnel, no hostname and no open port.

## 3. Cloudflare Access

Keep the single Access application covering the whole hostname with a **Service
Auth** policy. Both principals present the same service token:

- **clients** — send `CF-Access-Client-Id` / `CF-Access-Client-Secret` *plus*
  `X-Api-Key`, so the client API has two independent gates.
- **pods** — the agent sends the same Access headers plus `X-Agent-Secret`.

If the token is missing, requests are rejected at Cloudflare's edge and never
reach the gateway — the symptom is a 302 to the login page rather than a 401.

> Access service tokens expire (default: one year) and the token is baked into
> every pod template. Set the expiry notification when you create it and put the
> date in a calendar; a silent expiry takes the whole fleet offline at once.

## 4. Bring it up

Standalone:

```bash
docker compose -f deploy/compose.gateway.yml up -d
```

Or as an overlay on an existing stack, so both share a network:

```bash
docker compose \
  -f /path/to/your/docker-compose.yml \
  -f deploy/compose.gateway.yml \
  up -d inference-gateway inference-cloudflared
```

Then check it:

```bash
curl https://<your-hostname>/health \
  -H "CF-Access-Client-Id: $CF_ACCESS_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_SECRET"
```

## 5. Point the pods at it

On each pod template, set `GATEWAY_URL`, `GATEWAY_AGENT_SECRET` and the Access
pair, drop `CF_TUNNEL_TOKEN`, and set `SGLANG_HOST=127.0.0.1`. See
[../docs/deploy-pods.md](../docs/deploy-pods.md).

Watch them arrive:

```bash
curl -s https://<your-hostname>/v1/pods -H "X-Api-Key: $KEY" ... | jq
```

## 6. Configure the client

Point the client application at `https://<your-hostname>`, give it one of
`INFERENCE_API_KEYS`, and supply the Cloudflare Access service-token pair. The
API and the properties a client must respect are in
[../docs/api.md](../docs/api.md) and
[../docs/gateway.md](../docs/gateway.md#the-client-contract).

## Operations

| Task | Command |
|---|---|
| Queue and fleet state | `curl -s $GW/health \| jq` |
| Per-pod detail | `curl -s $GW/v1/pods -H "X-Api-Key: $KEY" \| jq` |
| Retire a pod politely | `curl -X POST $GW/v1/pods/<id>/drain -H "X-Api-Key: $KEY"` |
| Put it back in service | `curl -X DELETE $GW/v1/pods/<id>/drain -H "X-Api-Key: $KEY"` |
| Why was a video slow | `curl -s $GW/v1/videos/<id>/events -H "X-Api-Key: $KEY" \| jq` |

Draining stops new dispatch but leaves in-flight work alone — wait for
`in_flight: 0` before destroying the pod.

### Disk

Everything lives on the `inference-data` volume. If it fills — and especially if
the gateway shares a host with anything stateful — other services start failing
too, so expiry is an availability control rather than housekeeping: artifacts are
swept after `ARTIFACT_TTL_HOURS` (24) and job rows after `JOB_RETENTION_DAYS`
(7). Clients are expected to download each clip promptly and keep their own copy,
so the retention window is slack. Alarm at 80% used.
