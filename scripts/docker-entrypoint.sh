#!/usr/bin/env bash
# Container entrypoint: optionally starts a Cloudflare Tunnel next to the
# server, giving the pod a stable HTTPS hostname (e.g. inference.nidora.ai)
# no matter which IP/port the provider hands out.
#
# NIDORA_CF_TUNNEL_TOKEN  token of a remotely-managed tunnel whose public
#                         hostname points at http://localhost:8000.
set -euo pipefail

if [ -n "${NIDORA_CF_TUNNEL_TOKEN:-}" ]; then
    echo "starting cloudflared tunnel (public hostname -> localhost:8000)"
    cloudflared tunnel --no-autoupdate run --token "$NIDORA_CF_TUNNEL_TOKEN" &
fi

exec "$@"
