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

Two random strings, generated once. They live in the `.env` beside the compose
file — the step 4 snippet creates both, so this section is what they are, not a
command to run twice:

```bash
openssl rand -hex 32   # INFERENCE_API_KEYS      — held by clients
openssl rand -hex 32   # INFERENCE_AGENT_SECRET  — held by every pod
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

The old per-pod tunnels can be deleted once the pods are switched over — a pod
now needs no tunnel, no hostname and no open port.

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

The whole deployment is two files in one directory: `compose.yml` and `.env`.
The compose file runs a published image (CI pushes one per merge) and builds
nothing, so the host needs Docker and neither the repository nor a toolchain.
There is no service manager in front of it — `restart: unless-stopped` plus
dockerd starting at boot is what survives a reboot, and every operation below is
a `docker compose` command run from that directory.

### On any host with Docker

Six commands, no clone:

```bash
sudo install -d -m 0755 /opt/nidora
cd /opt/nidora

# The stack. Swap `main` for a tag or commit SHA to pin what you deploy.
sudo curl -fsSLo compose.yml \
  https://raw.githubusercontent.com/nidora-software/nidora-ai-inference/main/gateway/compose.yml

# Its configuration: the two secrets from step 1 and the tunnel token from step 2.
sudo tee .env >/dev/null <<EOF
INFERENCE_API_KEYS=$(openssl rand -hex 32)
INFERENCE_AGENT_SECRET=$(openssl rand -hex 32)
INFERENCE_CF_TUNNEL_TOKEN=<token from Cloudflare>
EOF
sudo chmod 600 .env

sudo docker compose up -d
```

`docker compose` reads `.env` from the working directory, which is why both
files live together and why every later command starts with `cd /opt/nidora`.
Keep that `.env` at mode 600 and off every backup that leaves the box: it holds
the key to the whole fleet.

Print the two generated secrets — the clients and the pods need them:

```bash
sudo grep -E 'INFERENCE_(API_KEYS|AGENT_SECRET)' /opt/nidora/.env
```

### On a bare droplet

[droplet-user-data.sh](droplet-user-data.sh) does the above plus the box itself:
Docker from the official repository, a firewall that allows only SSH, swap,
container log caps, unattended security upgrades, generated secrets, and an
hourly disk-fill warning. Paste it into DigitalOcean's **User data** field when
creating the droplet, or run it as root on an existing one.

```bash
# on the box, pinned to a release
INFERENCE_COMPOSE_REF=v0.7.0 sudo -E bash droplet-user-data.sh
```

It downloads the same `gateway/compose.yml`, or uses the sibling file if you
happen to run it from a checkout. Re-running is safe and is how a box is
upgraded: packages, compose file and containers are refreshed, and the secrets
in `/opt/nidora/.env` are never regenerated. Recommended size is 1 vCPU / 2 GB /
50 GB — the gateway container is capped at 1 GB, so a 1 GB droplet leaves
nothing for the kernel, dockerd and cloudflared.

| Variable | Default | What it does |
|---|---|---|
| `INFERENCE_COMPOSE_REF` | `main` | Git ref the compose file is fetched from. A tag or SHA makes the deploy reproducible. |
| `INFERENCE_COMPOSE_URL` | GitHub raw URL for that ref | Override wholesale, e.g. for a fork or an internal mirror. |
| `INFERENCE_IMAGE` | `ghcr.io/…/gateway:latest` | Written into `.env`. Pin a commit-SHA tag to make a redeploy a decision rather than a side effect of the next merge. Passing it on a re-run rewrites the pin; leaving it unset never unpins a box someone pinned by hand. |
| `INFERENCE_CF_TUNNEL_TOKEN` | empty | Better left empty and filled into `/opt/nidora/.env` after boot — user data stays readable at the droplet's metadata endpoint. |

Without a tunnel token the script provisions everything and stops short of
starting the stack; add the token to `/opt/nidora/.env`, then `cd /opt/nidora &&
sudo docker compose up -d`.

### Alongside an existing stack

Pass the other compose file first; its `name:` (or `COMPOSE_PROJECT_NAME`)
decides the project, and these two services join it and share its network:

```bash
docker compose \
  -f /path/to/your/docker-compose.yml \
  -f compose.yml \
  up -d inference-gateway inference-cloudflared
```

### Running an unreleased build

The compose file never builds. Build and tag the image yourself, then point
`INFERENCE_IMAGE` at it:

```bash
docker build -t nidora-gateway:dev gateway/     # from a checkout
INFERENCE_IMAGE=nidora-gateway:dev docker compose up -d
```

Then check it:

```bash
curl https://<your-hostname>/health \
  -H "CF-Access-Client-Id: $CF_ACCESS_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_SECRET"
```

## 5. Point the pods at it

On each pod template, set `GATEWAY_URL`, `GATEWAY_AGENT_SECRET` and the Access
pair, and publish no ports. See
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

All of the host-side commands run from `/opt/nidora`, where `compose.yml` and
`.env` live.

| Task | Command |
|---|---|
| Is it up | `docker compose ps` |
| Logs | `docker compose logs -f inference-gateway` |
| Restart | `docker compose restart inference-gateway` |
| Stop / start | `docker compose down` / `docker compose up -d` |
| Upgrade to the latest image | `docker compose pull && docker compose up -d` |
| Pin or roll back a version | set `INFERENCE_IMAGE=…/gateway:<sha>` in `.env`, then `docker compose up -d` |
| What is it running | `grep INFERENCE_IMAGE .env` (unset means `:latest`) |
| Take a compose change | re-download `compose.yml`, then `docker compose up -d` |
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
