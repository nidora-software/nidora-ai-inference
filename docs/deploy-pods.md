# Running on rented GPU pods

The image is self-contained: SGLang Diffusion + pinned model config +
optional Cloudflare Tunnel. A pod needs an 80 GB GPU, a persistent volume,
and env vars — nothing else.

## Before you start

- **GPU**: H100 or A100 **80 GB** (bf16 A14B). Smaller cards require SGLang
  offload flags via `SGLANG_EXTRA_ARGS` and are unbenchmarked.
- **Disk**: ≥ 300 GB persistent volume — the model snapshot (~126 GB)
  downloads once into the volume's HF cache (`HF_HOME=/workspace/hf`).
- **HF_TOKEN**: not needed (Wan and lightx2v repos are public).

## Vast.ai

Template walkthrough: [vastai-template-readme.md](vastai-template-readme.md).
Summary: image `erenck/nidora-ai-inference:latest`, Docker ENTRYPOINT mode,
300 GB volume at `/workspace`, env `CF_TUNNEL_TOKEN` (+ optional
`SGLANG_EXTRA_ARGS`), no port mapping needed (tunnel-only). Filter offers:
H100/A100 80 GB, CPU RAM ≥ 64 GB, Min CUDA 12.9, high `inet_down`.

## RunPod

Create a template with the same image, expose 8000, attach a network volume
at `/workspace`, same env vars. RunPod's proxy provides HTTPS
(`https://<POD_ID>-8000.proxy.runpod.net`) if you skip the tunnel.

## Stable HTTPS hostname (Cloudflare Tunnel)

Direct pod IP:port is plain HTTP and changes per instance. With a Cloudflare
Tunnel the API lives at a fixed hostname (e.g.
`https://inference.nidora.ai`) regardless of provider networking:

1. Cloudflare Zero Trust → Networks → Tunnels → create a `cloudflared`
   tunnel, copy the token.
2. Public hostname: `inference.<your-domain>` → `HTTP://localhost:8000`.
3. Set `-e CF_TUNNEL_TOKEN=<token>` on the template. The tunnel is
   outbound-only — no port mapping needed at all.

**Auth (required)** — the SGLang diffusion server has no built-in API auth,
so protect the hostname with Cloudflare Access:

1. Zero Trust → Access → **Service Auth** → create a **Service Token**; note
   the Client ID and Client Secret.
2. Zero Trust → Access → **Applications** → add a self-hosted application
   for `inference.<your-domain>`, session duration irrelevant.
3. Add a policy with action **Service Auth** requiring that service token.

Clients then send `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers
(see [api.md](api.md)); anything without them is rejected at Cloudflare's
edge before reaching the pod.

## Verify

```bash
curl https://inference.nidora.ai/health   # ready once warmup completes
```

Then generate a clip per [api.md](api.md). Startup phases on first boot:
model download (~126 GB, one-time per volume) → load + warmup → serving.
Watch the container logs for progress.
