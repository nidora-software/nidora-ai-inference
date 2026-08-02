# Running on rented GPU pods

Straightforward recipes for RunPod and Vast.ai. Both converge on the same
thing: a Linux + CUDA box where `scripts/provision.sh` (or the Docker image)
downloads the weights once onto persistent storage and starts `serve` on
port 8000.

## Before you start

- **GPU**: 48 GB+ (A6000/L40S/A40) is the comfortable floor for Wan 2.2 A14B
  with `NIDORA_OFFLOAD=model`; 80 GB (A100/H100) runs with `OFFLOAD=none`;
  24 GB (4090) requires `OFFLOAD=group` (streams weights through VRAM) and
  runs noticeably slower.
- **Disk**: ≥ 200 GB persistent volume. The Wan 2.2 A14B diffusers snapshot
  is **126 GB** (the experts are stored in fp32: 57 GB each + 11 GB text
  encoder), the Lightx2v LoRAs ~1.4 GB, plus download staging overhead —
  plus FLUX (~35 GB) if you enable it.
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

1. Create an instance from the **PyTorch (CUDA 12.x)** template. Pick an
   offer with ≥ 200 GB disk. Under **Docker options**, add `-p 8000:8000`
   and env vars:
   ```
   -e NIDORA_REPO=https://github.com/nidora-software/nidora-ai-inference.git
   -e HF_TOKEN=hf_...
   ```
2. Set the **On-start script** to:
   ```bash
   export NIDORA_APP_DIR=/workspace/nidora-ai-inference
   export NIDORA_MODELS_DIR=/workspace/models
   curl -LsSf https://raw.githubusercontent.com/nidora-software/nidora-ai-inference/main/scripts/provision.sh | bash
   ```
   (On templates without a `/workspace` volume, point both vars at whatever
   persistent path the offer provides.)
3. Find the mapped public port on the instance card (Vast maps container
   port 8000 to a random host port) and verify:
   ```bash
   curl http://<PUBLIC_IP>:<MAPPED_PORT>/health
   ```

Vast also accepts custom Docker images directly — paste the
`ghcr.io/...` image name into the template's image field, expose 8000, set
`NIDORA_AUTO_DOWNLOAD=1`, and skip the on-start script entirely.

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

| GPU | Settings |
|---|---|
| H100/A100 80 GB | `NIDORA_OFFLOAD=none` |
| A6000/L40S/A40 48 GB | `NIDORA_OFFLOAD=model` |
| 4090/3090 24 GB | `NIDORA_OFFLOAD=group` (required — `model` OOMs: one 14B expert is ~28 GB bf16 > 24 GB), stick to 480p |

`NIDORA_ATTENTION=auto` uses SageAttention automatically when the `accel`
extra is installed (provision.sh installs it whenever `nvidia-smi` is
present).
