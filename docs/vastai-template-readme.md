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
| System RAM | **128 GB+** | fp32 snapshot stages through RAM at load; Vast enforces the allocation as a hard limit — less gets OOM-killed (exit -9). Filter offers by CPU RAM. |
| Disk | 20 GB container + **300 GB volume** at `/workspace` | ~126 GB model snapshot lives in the volume's HF cache |
| Ports | none | the pod is outbound-only |
| Host CUDA | ≥ 12.9 | set Min CUDA in the offer filter |

Also filter for high `inet_down` — the one-time snapshot download dominates
first-boot time.

## Template setup

- **Image**: `erenck/nidora-ai-inference:latest`
- **Launch mode**: Docker ENTRYPOINT, args empty
- **Volume**: 300 GB at `/workspace`
- **Ports**: none — do not map 8000
- **Environment**:
  ```
  -e MODEL_PATH=Wan-AI/Wan2.2-I2V-A14B-Diffusers   # REQUIRED
  -e LORA_PATH=lightx2v/Wan2.2-Distill-Loras       # needed for 4-step generation
  -e GATEWAY_URL=https://<your-hostname>
  -e GATEWAY_AGENT_SECRET=<fleet agent secret>
  -e CF_ACCESS_CLIENT_ID=<service-token-id>.access
  -e CF_ACCESS_CLIENT_SECRET=<service-token-secret>
  -e SGLANG_EXTRA_ARGS=...                         # optional tuning, see below
  ```

**Security**: the SGLang diffusion server has **no built-in API auth**. It binds
to `127.0.0.1` and nothing outside the container can reach it. Do not map port
8000; there is no reason to.

`POD_ID` is auto-detected from Vast's container id, which is stable across
restarts — leave it unset.

## First boot

The server downloads the model snapshot into `/workspace/hf` (one-time per
volume, ~126 GB), loads and warms it (`--warmup-mode server`), then serves.
Later boots skip the download and are ready in minutes.

During the whole load the agent reports the pod as not-ready and the gateway
sends it no work — jobs wait in the queue rather than failing against a cold
pod. Watch it arrive:

```bash
curl -s https://<your-hostname>/v1/pods -H "X-Api-Key: $KEY" \
  -H "CF-Access-Client-Id: $CF_ACCESS_ID" -H "CF-Access-Client-Secret: $CF_ACCESS_SECRET" | jq
```

If `sglang_ready` never turns true, check the container logs for an exit code
of -9 — that is the RAM limit, not a configuration problem.

## Usage

Clients talk to the gateway, never to the pod. See [api.md](api.md).

## Tuning (SGLANG_EXTRA_ARGS)

- `--attention-backend fa3` — FlashAttention-3 on Hopper
- `--enable-torch-compile true` — slower warmup, faster steps
- `--text-encoder-cpu-offload` — only if VRAM is tight
- Multi-GPU: `--num-gpus N --enable-cfg-parallel`

## Tips

- The volume outlives the instance — destroy and recreate pods freely, the
  download happens once.
- Drain before destroying (`POST /v1/pods/<id>/drain`) so in-flight clips
  finish; a hard destroy is safe too, it just costs a retry.
- Pin a commit-SHA image tag for reproducibility; `:latest` tracks main.
