# Model weights

This folder is intentionally empty in git — weights are provisioned, not
committed. Each manifest entry in `configs/models.yaml` resolves to a
subfolder here named after the entry.

## Expected layout for the default profiles

```
models/
├── wan22-i2v-a14b/          # full diffusers snapshot of Wan-AI/Wan2.2-I2V-A14B-Diffusers
│   ├── model_index.json
│   ├── transformer/         # high-noise expert
│   ├── transformer_2/       # low-noise expert
│   ├── text_encoder/  tokenizer/  vae/  scheduler/  image_processor/
├── lightx2v-distill/        # from lightx2v/Wan2.2-Distill-Loras
│   ├── wan2.2_i2v_A14b_high_noise_lora_rank64_lightx2v_4step_1022.safetensors
│   └── wan2.2_i2v_A14b_low_noise_lora_rank64_lightx2v_4step_1022.safetensors
└── flux-dev/                # optional, for the flux-t2i profile
```

Fill it either by:

- **Manual**: download/copy the files into the folders above, or point
  `configs/models.yaml` `source:` at an existing local path (absolute paths
  work, including other drives on Windows).
- **CLI**: `nidora-ai-inference download --all` (uses HF_TOKEN if set).
