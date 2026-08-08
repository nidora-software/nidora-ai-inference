#!/usr/bin/env bash
# Tests the entrypoint's process supervision with stubbed children.
#
# The supervisor is the one piece that only runs inside the GPU image, where
# nothing else is easy to exercise: it decides whether a pod that has lost its
# agent (or its model server) stays up pretending to be healthy. Stubbing
# sglang/cloudflared/python lets it be checked anywhere.
#
#   ./test/entrypoint/run.sh
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
entrypoint="$root/scripts/docker-entrypoint.sh"
workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

pass=0
fail=0
ok()  { printf '  \033[32mok\033[0m   %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail + 1)); }

started="$workdir/started.log"
signals="$workdir/signals.log"
output="$workdir/out.log"

assert_status() {
    local expected="$1" actual="$2" msg="$3"
    if [ "$actual" -eq "$expected" ]; then ok "$msg"; else bad "$msg (got status $actual)"; fi
}

assert_grep() {
    local pattern="$1" file="$2" msg="$3"
    if grep -q -- "$pattern" "$file"; then ok "$msg"; else bad "$msg"; fi
}

refute_grep() {
    local pattern="$1" file="$2" msg="$3"
    if grep -q -- "$pattern" "$file"; then bad "$msg"; else ok "$msg"; fi
}

# --- stubs -------------------------------------------------------------------
# Each records the argv it was invoked with, then behaves as the test dictates.
mkdir -p "$workdir/bin"
make_stub() {
    local name="$1" behaviour="$2"
    cat > "$workdir/bin/$name" <<EOF
#!/usr/bin/env bash
echo "\$(basename "\$0") \$*" >> "$started"
trap 'echo "$name terminated" >> "$signals"; exit 0' TERM INT
$behaviour
EOF
    chmod +x "$workdir/bin/$name"
}

reset() { : > "$started"; : > "$signals"; : > "$output"; }

# Runs to completion; returns the entrypoint's exit status.
run_entrypoint() {
    env PATH="$workdir/bin:$PATH" SUPERVISE_INTERVAL=0.2 "$@" \
        bash "$entrypoint" > "$output" 2>&1
}

# Runs in the background, lets it settle, then stops it.
run_entrypoint_briefly() {
    env PATH="$workdir/bin:$PATH" SUPERVISE_INTERVAL=0.2 "$@" \
        bash "$entrypoint" > "$output" 2>&1 &
    local pid=$!
    sleep 1.2
    kill "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
}

longsleep='while :; do sleep 0.2; done'

echo "entrypoint supervision"

make_stub sglang "$longsleep"
make_stub cloudflared "$longsleep"
make_stub python "$longsleep"

# --- required configuration --------------------------------------------------
reset
run_entrypoint
assert_status 1 $? "refuses to start without MODEL_PATH"
assert_grep "MODEL_PATH is required" "$output" "explains why MODEL_PATH is needed"

reset
run_entrypoint MODEL_PATH=m GATEWAY_URL=https://example.invalid
assert_status 1 $? "refuses gateway mode without an agent secret"
assert_grep "GATEWAY_AGENT_SECRET is required" "$output" "explains the missing secret"

# --- standalone mode: sglang + cloudflared, no agent -------------------------
reset
run_entrypoint_briefly MODEL_PATH=m CF_TUNNEL_TOKEN=tok
assert_grep "^sglang serve" "$started" "standalone: starts sglang"
assert_grep "^cloudflared tunnel" "$started" "standalone: starts the tunnel"
refute_grep "^python -m nidora_agent" "$started" "standalone: no agent without GATEWAY_URL"

# --- gateway mode: sglang + agent, no tunnel ---------------------------------
reset
run_entrypoint_briefly MODEL_PATH=m GATEWAY_URL=https://example.invalid \
    GATEWAY_AGENT_SECRET=s SGLANG_HOST=127.0.0.1
assert_grep "^python -m nidora_agent" "$started" "gateway: starts the agent"
refute_grep "^cloudflared" "$started" "gateway: no tunnel without CF_TUNNEL_TOKEN"
assert_grep "--host 127.0.0.1" "$started" "gateway: binds sglang to SGLANG_HOST"

# --- a dying child takes the container down ----------------------------------
# The point of supervising at all: a pod that has lost its agent cannot receive
# work, so it must exit and let the provider restart it rather than sit there
# looking healthy.
reset
make_stub python 'sleep 0.5; exit 7'
run_entrypoint MODEL_PATH=m GATEWAY_URL=https://example.invalid GATEWAY_AGENT_SECRET=s
assert_status 7 $? "exits with the dead child's status"
assert_grep "agent exited (status=7)" "$output" "names the process that died"
assert_grep "sglang terminated" "$signals" "terminates the surviving children"
make_stub python "$longsleep"

# --- optional flags ----------------------------------------------------------
reset
run_entrypoint_briefly MODEL_PATH=m LORA_PATH=lora/repo
assert_grep "--lora-path lora/repo" "$started" "passes LORA_PATH when set"

reset
run_entrypoint_briefly MODEL_PATH=m
refute_grep "--lora-path" "$started" "omits --lora-path when unset"

reset
run_entrypoint_briefly MODEL_PATH=m SGLANG_EXTRA_ARGS="--attention-backend fa3 --num-gpus 2"
assert_grep "--attention-backend fa3 --num-gpus 2" "$started" \
    "splits SGLANG_EXTRA_ARGS into separate flags"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
