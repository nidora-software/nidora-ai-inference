# Model weights

This folder is intentionally empty in git — weights are provisioned, not
committed. Each manifest entry in `configs/models.yaml` resolves to a
subfolder here named after the entry.

## Expected layout for the default `wan22-i2v` profile (~37 GB total)

```
models/
├── wan22-i2v-a14b/          # Wan-AI/Wan2.2-I2V-A14B-Diffusers WITHOUT the
│   ├── model_index.json     # fp32 transformer weights (manifest skips them —
│   ├── transformer/         # only config.json needed here)
│   ├── transformer_2/       # (same)
│   ├── text_encoder/  tokenizer/  vae/  scheduler/     # ~12 GB
├── wan22-i2v-gguf/          # QuantStack/Wan2.2-I2V-A14B-GGUF
│   ├── HighNoise/Wan2.2-I2V-A14B-HighNoise-Q6_K.gguf   # 12 GB
│   └── LowNoise/Wan2.2-I2V-A14B-LowNoise-Q6_K.gguf     # 12 GB
├── wan22-lightning/         # lightx2v/Wan2.2-Lightning (Seko V1)
│   └── Wan2.2-I2V-A14B-4steps-lora-rank64-Seko-V1/
│       ├── high_noise_model.safetensors                # 1.2 GB
│       └── low_noise_model.safetensors                 # 1.2 GB
└── flux-dev/                # optional, for the flux-t2i profile (gated)
```

The optional `wan22-i2v-bf16` profile additionally needs the full-precision
transformer weights (2×57 GB) inside `wan22-i2v-a14b/transformer*/` — remove
the `ignore_patterns` from that manifest entry before downloading.

Fill this folder either by:

- **Manual**: download/copy the files into the folders above, or point
  `configs/models.yaml` `source:` at an existing local path (absolute paths
  work, including other drives on Windows).
- **CLI**: `nidora-ai-inference download --all` (uses HF_TOKEN if set).
