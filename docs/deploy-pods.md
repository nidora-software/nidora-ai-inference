# Running on rented GPU pods

Straightforward recipes for RunPod and Vast.ai. Both converge on the same
thing: a Linux + CUDA box where `scripts/provision.sh` (or the Docker image)
downloads the weights once onto persistent storage and starts `serve` on
port 8000.

## Before you start

- **GPU**: the default profile runs Q6_K GGUF experts (~12 GB each), so a
  24 GB card (4090) works well with `NIDORA_OFFLOAD=model` (one expert on GPU
  at a time); 48 GB+ cards run `OFFLOAD=none`. Only the optional
  full-precision `wan22-i2v-bf16` profile needs `group` offload on 24 GB.
- **Disk**: ≥ 100 GB persistent volume. The default profile downloads ~37 GB
  (2×12 GB GGUF experts + ~12 GB base components + ~2.5 GB LoRAs). The
  optional bf16 profile adds the fp32 transformers (2×57 GB → plan 200 GB+),
  and FLUX (~35 GB) if you enable it.
- **HF_TOKEN**: only needed for gated repos (FLUX.1-dev is gated; the Wan and
  Lightx2v repos are not).
- Put weights on the **persistent/network volume**, never the container disk —
  you pay the ~70 GB download once, not on every restart.

## RunPod

### Option A — stock PyTorch template + provision.sh (fastest to try)

1. Deploy a **GPU Pod** with the official PyTorch template (any recent
   CUDA 12.x variant), a **Volume** of 100+ GB mounted at `/workspace`, and
   **Expose HTTP Ports: 8000**.
2. Set pod environment variables:
   ```
   NIDORA_REPO=https://github.com/nidora-software/nidora-ai-inference.git
   HF_TOKEN=hf_...            # only if you enable gated models
   ```
3. Open the web terminal (or SSH) and run:
   ```bash
   curl -LsSf https://raw.githubusercontent.com/nidora-software/nidora-ai-inference/main/scripts/provision.sh | bash
   ```
   First boot: clones the repo into `/workspace`, installs deps, downloads all
   weights referenced by the enabled profiles, then serves. Later boots: pulls,
   sees the weights already present, serves within seconds.
4. Call the API through RunPod's proxy:
   ```bash
   curl https://<POD_ID>-8000.proxy.runpod.net/health
   ```

To start it automatically on every boot, set the pod's **Container Start
Command** (Docker command override) to:
```
bash -c "sleep 2; bash /workspace/nidora-ai-inference/scripts/provision.sh"
```

### Option B — custom Docker image (production-ish)

1. The image is built and pushed automatically by GitHub Actions on every
   push to `main` (`.github/workflows/docker.yml`):
   `ghcr.io/nidora-software/nidora-ai-inference:latest`, plus a commit-SHA tag
   for pinning and `vX.Y.Z` tags on releases.
2. Create a RunPod **Template**: that image, expose port 8000, attach a
   network volume mounted at `/models`, env `NIDORA_AUTO_DOWNLOAD=1`
   (first boot fills the volume; subsequent boots skip straight to serving).
3. Deploy pods from the template. The container's default command *is*
   `serve` — nothing to run manually.

## Vast.ai

### Option A — custom Docker image (recommended)

Create a Vast template from the prebuilt image — full walkthrough (env vars,
API key, first boot, usage) in
[vastai-template-readme.md](vastai-template-readme.md). In short:

1. **Image**: `erenck/nidora-ai-inference:latest` (Docker Hub) or
   `ghcr.io/nidora-software/nidora-ai-inference:latest`. Launch mode: run the
   image's entrypoint — the default command *is* `serve`.
2. **Disk**: 100 GB+. **Docker options**:
   ```
   -p 8000:8000
   -e NIDORA_AUTO_DOWNLOAD=1
   -e NIDORA_WARMUP=wan22-i2v
   -e NIDORA_OFFLOAD=model        # 24 GB cards; "none" on 48 GB+
   -e NIDORA_API_KEY=<secret>     # REQUIRED — Vast instances are public
   -e NIDORA_CF_TUNNEL_TOKEN=eyJ… # optional: stable HTTPS hostname via Cloudflare Tunnel
   ```
3. Find the mapped public port on the instance card (Vast maps container
   port 8000 to a random host port) and verify:
   ```bash
   curl http://<PUBLIC_IP>:<MAPPED_PORT>/health
   # ready when "loaded_pipeline": "wan22-i2v"
   ```

Weights land on the instance disk (`/models`) — **stop** instances instead of
destroying them to keep the download.

### Option B — stock PyTorch template + provision.sh

1. Create an instance from the **PyTorch (CUDA 12.x)** template. Pick an
   offer with ≥ 100 GB disk. Under **Docker options**, add `-p 8000:8000`
   and env vars:
   ```
   -e NIDORA_REPO=https://github.com/nidora-software/nidora-ai-inference.git
   -e NIDORA_WARMUP=wan22-i2v
   -e NIDORA_API_KEY=<secret>
   -e HF_TOKEN=hf_...             # only if you enable gated models
   ```
2. Set the **On-start script** to:
   ```bash
   export NIDORA_APP_DIR=/workspace/nidora-ai-inference
   export NIDORA_MODELS_DIR=/workspace/models
   curl -LsSf https://raw.githubusercontent.com/nidora-software/nidora-ai-inference/main/scripts/provision.sh | bash
   ```
   (On templates without a `/workspace` volume, point both vars at whatever
   persistent path the offer provides.)
3. Verify via the mapped public port as above.

## Any other provider (Lambda, Paperspace, a bare server…)

The requirements are only: NVIDIA driver + CUDA-capable GPU, Python 3.11+ or
Docker, ~100 GB of persistent disk, and one open port. Then either:

```bash
NIDORA_REPO=https://github.com/nidora-software/nidora-ai-inference.git \
NIDORA_MODELS_DIR=/path/to/persistent/models \
bash scripts/provision.sh
```

or the `docker run` from the README with `/models` mounted from persistent
storage.

## Verify + first job

```bash
curl http://<host>/health
# {"status":"ok","device":"cuda","loaded_pipeline":null,"queue_depth":0}

curl -X POST http://<host>/v1/jobs -H 'content-type: application/json' -d '{
  "pipeline": "wan22-i2v",
  "params": {
    "image": "https://example.com/input.jpg",
    "prompt": "the woman smiles and waves at the camera",
    "resolution": "480p"
  }
}'
# poll GET /v1/jobs/{id}; the first job also loads the model (~minutes),
# subsequent jobs skip straight to inference.
```

Tuning per GPU class (env vars, set before `serve`):

| GPU | Settings (default GGUF profile) |
|---|---|
| 48 GB+ (A6000/L40S/A100/H100) | `NIDORA_OFFLOAD=none` |
| 32 GB (RTX 5090) | `NIDORA_OFFLOAD=model` — the full set (~35 GB) doesn't fit |
| 4090/3090 24 GB | `NIDORA_OFFLOAD=model`, stick to 480p |

For the optional full-precision `wan22-i2v-bf16` profile: 80 GB → `none`,
48 GB → `model`, 24 GB → `group` (one 14B expert is ~28 GB bf16 > 24 GB).

`NIDORA_ATTENTION=auto` uses SageAttention automatically when it's available
and the GPU is sm80+ (A100/3090 or newer). The Docker image ships it
prebuilt; provision.sh pods can set `NIDORA_BUILD_SAGE=1` to compile it at
first boot (~10–30 min once, needs nvcc). Check the model-load logs for
`attention backend: sage`.
