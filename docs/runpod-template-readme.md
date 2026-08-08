# Nidora AI Inference — Wan 2.2 Image-to-Video (SGLang Diffusion)

Self-hosted **Wan 2.2 I2V A14B** with **Lightning 4-step distill LoRAs**,
served by SGLang Diffusion. Pods join a fleet behind the Nidora inference
gateway and pull work from it — no inbound networking required.

- Image: `erenck/nidora-ai-inference:latest` (also on GHCR)
- Source: https://github.com/nidora-software/nidora-ai-inference
- License: MIT

## Requirements

| Resource | Minimum | Notes |
|---|---|---|
| GPU | **H100 / A100 80 GB** | bf16 A14B needs ~70 GB resident for full speed |
| System RAM | **128 GB+** | fp32 snapshot stages through RAM at load — less gets OOM-killed (exit -9) |
| Volume | **300 GB** network volume at `/workspace` | ~126 GB model snapshot lives in the volume's HF cache |
| Ports | none | gateway mode is outbound-only |

## Template setup (gateway mode)

- **Image**: `erenck/nidora-ai-inference:latest` (pin a commit-SHA tag for reproducibility)
- **Expose HTTP Ports**: none
- **Volume**: network volume mounted at `/workspace`
- **Environment**:
  ```
  MODEL_PATH=Wan-AI/Wan2.2-I2V-A14B-Diffusers   # REQUIRED
  LORA_PATH=lightx2v/Wan2.2-Distill-Loras       # needed for 4-step generation
  SGLANG_HOST=127.0.0.1                         # keep sglang off the network
  GATEWAY_URL=https://<your-hostname>
  GATEWAY_AGENT_SECRET=<fleet agent secret>
  CF_ACCESS_CLIENT_ID=<service-token-id>.access
  CF_ACCESS_CLIENT_SECRET=<service-token-secret>
  AGENT_PIPELINES=wan22-i2v
  SGLANG_EXTRA_ARGS=                            # optional tuning
  ```

**Security**: the SGLang diffusion server has **no built-in API auth**, and
RunPod's `*.proxy.runpod.net` URLs are publicly reachable. In gateway mode
SGLang binds to `127.0.0.1` and no port is exposed, so the proxy has nothing to
reach — leave it that way.

`POD_ID` is auto-detected from `RUNPOD_POD_ID`, which is stable across restarts
— leave it unset.

The container's default entrypoint starts everything; nothing to run manually.

## First boot

The server downloads the model snapshot into `/workspace/hf` (one-time per
volume, ~126 GB), loads and warms it (`--warmup-mode server`), then serves.
Later boots skip the download.

During the load the agent reports the pod as not-ready and the gateway sends it
no work — jobs wait in the queue instead of failing against a cold pod. Confirm
it joined:

```bash
curl -s https://<your-hostname>/v1/pods -H "X-Api-Key: $KEY" \
  -H "CF-Access-Client-Id: $CF_ACCESS_ID" -H "CF-Access-Client-Secret: $CF_ACCESS_SECRET" | jq
```

## Usage

Clients talk to the gateway, never to the pod. See [api.md](api.md).

## Tips

- Keep the network volume when stopping the pod — the download happens once.
- `SGLANG_EXTRA_ARGS="--attention-backend fa3 --enable-torch-compile true"` is
  a good Hopper starting point.
- Drain before destroying (`POST /v1/pods/<id>/drain`) so in-flight clips
  finish; a hard destroy is safe too, it just costs a retry.
- Image updates: restart to pull the newest `latest`, or pin a SHA tag.

## Standalone mode

To run a pod as its own public endpoint instead of joining the fleet, set
`CF_TUNNEL_TOKEN`, expose port 8000, and leave `GATEWAY_URL` unset — see
[deploy-pods.md](deploy-pods.md#standalone-mode). Cloudflare Access is
mandatory in that mode; do not rely on the RunPod proxy for auth.
