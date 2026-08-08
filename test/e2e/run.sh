#!/usr/bin/env bash
# End-to-end check against the stack in deploy/compose.e2e.yml.
#
# Submits a real video through the client API — the same OpenAI-shaped surface
# SGLang exposes — waits for a pod to pick it up and a clip to come back, then
# verifies the bytes match the fixture the mock SGLang server serves. No GPU.
#
#   docker compose -f deploy/compose.e2e.yml up --build -d
#   ./test/e2e/run.sh
set -euo pipefail

GATEWAY="${GATEWAY:-http://127.0.0.1:8080}"
API_KEY="${API_KEY:-e2e-api-key}"
TIMEOUT_S="${TIMEOUT_S:-120}"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$root/tools/mock-sglang/fixtures/tiny.mp4"
workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
fail() { printf '\033[31mFAIL: %s\033[0m\n' "$*" >&2; exit 1; }

curl_api() { curl -fsS -H "X-Api-Key: $API_KEY" "$@"; }

say "waiting for the gateway"
for _ in $(seq 1 60); do
    if curl -fsS "$GATEWAY/health" >/dev/null 2>&1; then break; fi
    sleep 1
done
curl -fsS "$GATEWAY/health" >/dev/null || fail "gateway never became healthy"

say "waiting for a pod to register as ready"
for _ in $(seq 1 60); do
    ready="$(curl -fsS "$GATEWAY/health" | python3 -c 'import json,sys; print(json.load(sys.stdin)["pods"]["ready"])')"
    [ "$ready" -ge 1 ] && break
    sleep 1
done
[ "${ready:-0}" -ge 1 ] || fail "no pod reported itself ready"
say "pod ready"

say "building the request"
# A real 64x64 PNG, since the gateway probes the header to compute the frame size.
python3 - "$workdir/input.png" <<'PY'
import struct, sys, zlib

def chunk(kind, data):
    body = kind + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xffffffff)

w = h = 64
ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
raw = b"".join(b"\x00" + b"\x80\x40\x20" * w for _ in range(h))
png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
       + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))

open(sys.argv[1], "wb").write(png)
PY

say "checking the fleet advertises the model"
curl_api "$GATEWAY/v1/models" | grep -q "Wan2.2-I2V-A14B-Diffusers" \
    || fail "/v1/models does not list the model the pod is serving"

say "submitting the video"
create="$(curl_api -X POST "$GATEWAY/v1/videos" \
    -F "model=Wan-AI/Wan2.2-I2V-A14B-Diffusers" \
    -F "prompt=the woman smiles and waves at the camera" \
    -F "input_reference=@$workdir/input.png;type=image/png")"
video_id="$(printf '%s' "$create" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
status="$(printf '%s' "$create" | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')"
[ "$status" = "queued" ] || fail "expected a queued video, got $status"
case "$video_id" in
    video_*) ;;
    *) fail "expected an OpenAI-shaped id, got $video_id" ;;
esac
say "video $video_id queued"

say "polling for completion"
deadline=$(( $(date +%s) + TIMEOUT_S ))
while :; do
    payload="$(curl_api "$GATEWAY/v1/videos/$video_id")"
    status="$(printf '%s' "$payload" | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')"
    case "$status" in
        completed) break ;;
        failed|cancelled)
            printf '%s\n' "$payload" >&2
            fail "video ended as $status"
            ;;
    esac
    [ "$(date +%s)" -lt "$deadline" ] || fail "video did not finish within ${TIMEOUT_S}s (last status: $status)"
    sleep 2
done
say "video completed"

# The content path is derived from the id — the server hands over no URL, so a
# credential-sending client has nothing to validate before following it.
say "downloading the content"
curl_api "$GATEWAY/v1/videos/$video_id/content" -o "$workdir/out.mp4"
cmp -s "$workdir/out.mp4" "$fixture" || fail "the downloaded clip does not match the fixture"

say "checking the queue drained"
depth="$(curl -fsS "$GATEWAY/health" | python3 -c 'import json,sys; print(json.load(sys.stdin)["queue_depth"])')"
[ "$depth" = "0" ] || fail "queue_depth should be 0 after the job finished, got $depth"

printf '\033[32mPASS\033[0m — video %s generated and downloaded %s bytes\n' \
    "$video_id" "$(wc -c < "$workdir/out.mp4" | tr -d ' ')"
