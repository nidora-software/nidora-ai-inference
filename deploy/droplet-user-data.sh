#!/usr/bin/env bash
# Provisions a bare Ubuntu 24.04 droplet into a gateway host.
#
# Paste into DigitalOcean's "User data" field when creating the droplet, or
# scp it onto an existing box and run it as root. Idempotent: re-running
# upgrades the packages and redeploys the stack without regenerating secrets.
#
# It is a convenience, not a requirement: the stack is a compose file and an
# .env, and deploy/README.md sets both up by hand in about six commands.
#
#   Recommended droplet: 1 vCPU / 2 GB / 50 GB. The gateway container is
#   capped at 1 GB (see mem_limit below), so a 1 GB droplet has no room left
#   for the kernel, dockerd and cloudflared.
#
# Nothing here opens an inbound port. cloudflared dials out to Cloudflare and
# reaches the gateway over the compose network, so the only inbound rule on the
# box is SSH.
#
# The stack definition is gateway/compose.yml, installed verbatim — this script
# holds no second copy to drift out of step with it.
#
# The stack is plain `docker compose` in /opt/nidora, with no systemd unit in
# front of it: `restart: unless-stopped` plus dockerd starting at boot already
# survives a reboot, and a wrapper unit only adds a second way to describe the
# same thing. Every operation is a compose command — see deploy/README.md.
set -euo pipefail

# Everything from here lands in the log rather than the void cloud-init
# usually swallows it into.
exec > >(tee -a /var/log/nidora-provision.log) 2>&1
echo "[provision] starting $(date -Is)"

# ---------------------------------------------------------------------------
# Configuration. The tunnel token is the one secret this script cannot invent.
# ---------------------------------------------------------------------------

# Where the stack definition comes from. If this script is run from a checkout
# (scp'd tree, `bash deploy/droplet-user-data.sh`), the sibling file wins and
# nothing is downloaded; pasted into user data, it is fetched from the repo.
#
# COMPOSE_REF pins which revision of the compose file the box runs — a tag or
# commit SHA makes a redeploy reproducible, `main` makes it whatever landed
# last.
COMPOSE_REF="${INFERENCE_COMPOSE_REF:-main}"
COMPOSE_URL="${INFERENCE_COMPOSE_URL:-https://raw.githubusercontent.com/nidora-software/nidora-ai-inference/${COMPOSE_REF}/gateway/compose.yml}"

# Guarded, because the script may be running from a path that no longer exists
# (cloud-init's temp dir) or from a pipe, where there is no directory to resolve.
LOCAL_COMPOSE=""
if script_dir=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd); then
    LOCAL_COMPOSE="${script_dir}/../gateway/compose.yml"
fi

# Published by .github/workflows/gateway.yml to GHCR and Docker Hub, both
# public — no registry login. Pin the commit-SHA tag instead of `latest` if you
# want a redeploy to be a decision rather than a side effect of the next merge.
#
# Remembered separately: an image passed on a re-run is an upgrade instruction
# and overwrites the one in .env, whereas the default must not silently unpin a
# box someone pinned by hand.
IMAGE_PINNED_BY_CALLER=$([ -n "${INFERENCE_IMAGE:-}" ] && echo 1 || echo 0)
INFERENCE_IMAGE="${INFERENCE_IMAGE:-ghcr.io/nidora-software/nidora-ai-inference/gateway:latest}"

# Leave empty and fill in /opt/nidora/.env after boot. Anything pasted into
# user data stays readable at the droplet's metadata endpoint for the life of
# the droplet — which is a poor home for a credential you cannot rotate
# silently.
INFERENCE_CF_TUNNEL_TOKEN="${INFERENCE_CF_TUNNEL_TOKEN:-}"

INSTALL_DIR=/opt/nidora

# ---------------------------------------------------------------------------
# Base system
# ---------------------------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y
apt-get install -y ca-certificates cron curl gnupg jq ufw unattended-upgrades

# Security updates apply themselves. This box holds the fleet's agent secret
# and is reachable from the internet through the tunnel.
dpkg-reconfigure -f noninteractive unattended-upgrades

# 2 GB of swap on a 2 GB droplet. Never the plan, but it turns a memory spike
# during a burst of concurrent uploads into a slow minute instead of the OOM
# killer choosing a process for you.
if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
    # The gateway is I/O-bound, not memory-hungry; prefer the page cache.
    sysctl -w vm.swappiness=10
    echo 'vm.swappiness=10' > /etc/sysctl.d/99-nidora.conf
fi

# Deny inbound by default. The gateway publishes no ports and cloudflared only
# needs egress, so SSH is the entire inbound surface.
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw --force enable

# ---------------------------------------------------------------------------
# Docker, from the official repository
# ---------------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
        | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
    # shellcheck disable=SC1091  # /etc/os-release exists on the droplet, not on the linter's box
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
        > /etc/apt/sources.list.d/docker.list
    apt-get update -y
    apt-get install -y docker-ce docker-ce-cli containerd.io \
        docker-buildx-plugin docker-compose-plugin
fi

# Unbounded container logs are the most boring way to fill a 50 GB disk, and
# this gateway logs a line per dispatch.
cat > /etc/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
EOF
systemctl enable --now docker
systemctl restart docker

# ---------------------------------------------------------------------------
# The stack
# ---------------------------------------------------------------------------
mkdir -p "$INSTALL_DIR"

# Install gateway/compose.yml as-is. Staged through a temp file so a failed
# download or a truncated body leaves the running stack's compose file intact
# rather than replacing it with half a document.
staged=$(mktemp)
if [ -f "$LOCAL_COMPOSE" ]; then
    echo "[provision] compose from checkout: $LOCAL_COMPOSE"
    cp "$LOCAL_COMPOSE" "$staged"
else
    echo "[provision] compose from ${COMPOSE_URL}"
    if ! curl -fsSL --retry 3 --retry-delay 2 "$COMPOSE_URL" -o "$staged"; then
        rm -f "$staged"
        echo "[provision] FATAL: could not download the compose file" >&2
        exit 1
    fi
fi

# A 404 page or an empty body is still a file; only a document naming the
# services we are about to run is one.
if ! grep -q '^  inference-gateway:' "$staged"; then
    rm -f "$staged"
    echo "[provision] FATAL: compose file does not define inference-gateway" >&2
    exit 1
fi
install -m 0644 "$staged" "$INSTALL_DIR/compose.yml"
rm -f "$staged"

# Secrets are generated once and never regenerated: rewriting them on a re-run
# would lock out every pod and client at the same moment.
if [ ! -f "$INSTALL_DIR/.env" ]; then
    umask 077
    cat > "$INSTALL_DIR/.env" <<EOF
# Client API keys. Comma-separated — add the new one, migrate clients, drop the
# old one. That is the whole rotation procedure.
INFERENCE_API_KEYS=$(openssl rand -hex 32)

# Every pod holds this as GATEWAY_AGENT_SECRET. It lives on rented hardware, so
# treat it as compromise-prone and rotate it when you retire a provider account.
INFERENCE_AGENT_SECRET=$(openssl rand -hex 32)

# Optional; /v1/pods falls back to the client keys when unset.
INFERENCE_ADMIN_KEYS=

# From Cloudflare Zero Trust → Networks → Tunnels. Point the tunnel's public
# hostname at HTTP → inference-gateway:8080.
INFERENCE_CF_TUNNEL_TOKEN=${INFERENCE_CF_TUNNEL_TOKEN}

# The image the stack runs. Swap the tag for a commit SHA to pin a release,
# then: cd /opt/nidora && docker compose pull && docker compose up -d
INFERENCE_IMAGE=${INFERENCE_IMAGE}
EOF
    chmod 600 "$INSTALL_DIR/.env"
elif [ "$IMAGE_PINNED_BY_CALLER" = 1 ]; then
    # .env survives a re-run, so this is the one line an upgrade may rewrite.
    # Rebuilt beside the original rather than edited in place: the secrets in
    # this file are the fleet's, and a half-written .env is worse than a stale
    # one. The umask keeps the replacement at 600 for its whole life.
    umask 077
    grep -v '^INFERENCE_IMAGE=' "$INSTALL_DIR/.env" > "$INSTALL_DIR/.env.new" || true
    printf 'INFERENCE_IMAGE=%s\n' "$INFERENCE_IMAGE" >> "$INSTALL_DIR/.env.new"
    mv "$INSTALL_DIR/.env.new" "$INSTALL_DIR/.env"
    echo "[provision] image set to ${INFERENCE_IMAGE}"
fi

# Boxes provisioned before the stack became plain compose have a
# nidora-gateway unit and a disk-check timer. Left enabled, they would run
# their own `docker compose up` at the next boot and double-report the disk, so
# a re-run retires them.
for unit in nidora-gateway.service nidora-disk-check.timer nidora-disk-check.service; do
    if [ -f "/etc/systemd/system/$unit" ]; then
        echo "[provision] removing legacy unit $unit"
        systemctl disable --now "$unit" >/dev/null 2>&1 || true
        rm -f "/etc/systemd/system/$unit"
        legacy_units=1
    fi
done
if [ -n "${legacy_units:-}" ]; then
    systemctl daemon-reload
fi

# The data volume is the only copy of in-flight job state, and a full disk on a
# co-located box takes its neighbours down too. Warn while there is still time
# to act rather than discovering it from failed uploads. cron rather than a
# timer, for the same reason the stack has no unit: one mechanism is enough.
cat > /etc/cron.hourly/nidora-disk-check <<'EOF'
#!/usr/bin/env bash
used=$(df --output=pcent /var/lib/docker | tail -1 | tr -dc '0-9')
if [ "$used" -ge 80 ]; then
    logger -t nidora-disk -p user.warning "docker filesystem ${used}% used"
fi
EOF
chmod +x /etc/cron.hourly/nidora-disk-check
rm -f /usr/local/bin/nidora-disk-check

# ---------------------------------------------------------------------------
# Start, if we have everything we need
# ---------------------------------------------------------------------------
if grep -q '^INFERENCE_CF_TUNNEL_TOKEN=.\+' "$INSTALL_DIR/.env"; then
    cd "$INSTALL_DIR"
    # Interpolate the whole file against the real .env first: a missing variable
    # fails here, with its name in the log, rather than as a container that
    # never appears.
    docker compose config --quiet
    docker compose pull --quiet
    docker compose up -d --remove-orphans
    echo "[provision] stack started"
else
    echo "[provision] no tunnel token yet — stack NOT started."
    echo "[provision] set INFERENCE_CF_TUNNEL_TOKEN in ${INSTALL_DIR}/.env, then:"
    echo "[provision]   cd ${INSTALL_DIR} && docker compose up -d"
fi

echo
echo "[provision] secrets (also in ${INSTALL_DIR}/.env, mode 600):"
grep -E '^INFERENCE_(API_KEYS|AGENT_SECRET)=' "$INSTALL_DIR/.env"
echo "[provision] done $(date -Is)"
