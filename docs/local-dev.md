# Local development — the fleet on one machine

[compose.local.yml](../compose.local.yml) runs the whole stack in Docker on a
single workstation GPU: the gateway on `127.0.0.1:8080` and one pod beside it
on the compose network. A pod is only ever a member of a gateway fleet — there
is no standalone mode — so local serving means running a local fleet, not a
special code path. The pieces are the same ones production runs; only the
wiring (loopback instead of a Cloudflare Tunnel) and the tuning differ.

Defaults target **MiniMax-H3 (`fl2va`) on a 1×RTX 4090 24 GB** using the
[cookbook's consumer-GPU recipe](https://docs.sglang.io/cookbook/diffusion/MiniMax/MiniMax-H3):

```
--quantization kitchen_int8 --attention-backend fa --performance-mode memory
--layerwise-offload-components dit,text_encoder
--dit-offload-prefetch-size 1 --dit-layerwise-resident-layers 0
--enable-torch-compile false
```

int8 weights (via `comfy-kitchen`, baked into the experimental image), exact
flash attention, and every DiT/text-encoder layer offloaded to host RAM with a
prefetch depth of 1. Zero resident layers is what makes 24 GB enough; the cost
is wall-clock — expect tens of minutes per clip, which is why the local
gateway allows jobs a full hour (`JOB_TTL_S=3600`).

> **Why not SageAttention?** The image ships the `sageattention` kernels, but
> MiniMax-H3's pipeline rejects `--attention-backend sage_attn` at startup:
> *"MiniMax-H3 does not support SageAttention: the current packed varlen path
> does not preserve model output."* Use it (via `LOCAL_SGLANG_ARGS`) only with
> models that support it.

## Prerequisites

- Docker Desktop with the WSL2 backend and GPU support
  (`docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi`
  must show the card).
- **WSL2 memory ceiling.** The offloaded weights live in *host* RAM inside
  the WSL2 VM — which defaults to only half the machine's memory. For
  MiniMax-H3 that means the bf16 text encoder (~63 GB) **plus** DiT staging:
  64 GB is not enough (the loader gets OOM-killed with exit code -9). Give
  the VM everything the machine can spare and a large swap to absorb the
  load-time peak, in `%UserProfile%\.wslconfig`:

  ```ini
  [wsl2]
  memory=84GB   # on a 94 GB machine; leave ~10 GB for Windows
  swap=100GB    # swap file lives on C: — the space must be free
  ```

  then `wsl --shutdown` and restart Docker Desktop.
- Disk: the MiniMax-H3 weights are a one-time ~40 GB download into the
  `pod-workspace` volume.

## Run it

```bash
docker compose -f compose.local.yml up
```

First boot pulls the experimental pod image (SGLang nightly — the MiniMax-H3
pipeline is not in a stable release yet), downloads the weights, quantizes and
warms up. The agent reports the pod not-ready until SGLang's health check
passes, so the gateway simply holds work until then; watch progress with
`docker compose -f compose.local.yml logs -f inference-pod`.

Then talk to it exactly like production, minus the Cloudflare headers:

```bash
curl http://127.0.0.1:8080/v1/models -H "X-Api-Key: local-dev-key"
```

```bash
curl -X POST http://127.0.0.1:8080/v1/videos \
  -H "X-Api-Key: local-dev-key" \
  -F "model=MiniMaxAI/MiniMax-H3" \
  -F "prompt=A cat walking on a sunny beach, gentle waves." \
  -F "input_reference=@first-frame.jpg;type=image/jpeg"
```

`fl2va` is first/last-frame-to-video: the uploaded `input_reference` is the
first keyframe. Poll `GET /v1/videos/{id}` and download
`/v1/videos/{id}/content` as in [docs/api.md](api.md).

## One-shot generation, no gateway

For pure SGLang experiments (prompt tuning, flag tuning) skip the fleet and
run `sglang generate` in the same image and volume:

```bash
docker compose -f compose.local.yml run --rm --entrypoint sglang inference-pod \
  generate \
  --model-path MiniMaxAI/MiniMax-H3 \
  --model-variant fl2va \
  --quantization kitchen_int8 \
  --attention-backend fa \
  --performance-mode memory \
  --layerwise-offload-components dit,text_encoder \
  --dit-offload-prefetch-size 1 \
  --dit-layerwise-resident-layers 0 \
  --enable-torch-compile false \
  --prompt "A cat walking on a sunny beach, gentle waves." \
  --save-output
```

The output lands under `/workspace/sgl_diffusion` inside the `pod-workspace`
volume (`docker compose -f compose.local.yml cp inference-pod:/workspace/sgl_diffusion ./out`
while the pod is running, or mount a host directory instead).

## Overrides

Everything is `.env`-driven ([.env.sample](../.env.sample)):

| Var | Default | Purpose |
|---|---|---|
| `LOCAL_MODEL_PATH` | `MiniMaxAI/MiniMax-H3` | Any model in the gateway registry |
| `LOCAL_MODEL_VARIANT` | `fl2va` | Checkpoint partition (`fl2va` \| `ref2va`); empty for single-variant models |
| `LOCAL_SGLANG_ARGS` | the 4090 recipe above | Replaces the whole flag set |
| `LOCAL_POD_IMAGE` | `erenck/nidora-ai-inference:experimental` | Pod image; `--build` rebuilds from [Dockerfile.nightly](../Dockerfile.nightly) |
| `LOCAL_API_KEY` / `LOCAL_AGENT_SECRET` | `local-dev-key` / `local-dev-agent-secret` | Dev credentials |
| `HF_TOKEN` | — | Only for gated repos |

After editing the agent, rebuild the pod in place:

```bash
docker compose -f compose.local.yml up --build inference-pod
```

## Why local ComfyUI checkpoints don't plug in

Single-file ComfyUI checkpoints (e.g.
`minimax_h3_fl2va_pruned_int8_convrot.safetensors`) are a different packaging
of the weights than SGLang loads: SGLang's diffusion engine wants the
HuggingFace repo layout (config + sharded weights per component), and
`--quantization kitchen_int8` quantizes at load from that layout. Point
`MODEL_PATH` at the HF repo id and let the cache volume absorb the one-time
download — the ComfyUI files can't be substituted for it.

## Debugging SGLang directly

The diffusion server has **no auth**, so it stays on `127.0.0.1` inside the
container. To reach it from the host, uncomment `SGLANG_HOST: 0.0.0.0` and the
loopback-only `ports:` block in [compose.local.yml](../compose.local.yml) —
never publish it beyond `127.0.0.1`.
