"""FLUX text-to-image — the proof that adding a modality is one small class
plus a YAML profile."""

from __future__ import annotations

import logging
from typing import ClassVar

from pydantic import BaseModel, Field

from ..core.attention import apply_attention_backend
from ..core.config import load_model_manifest
from ..models.manifest import resolve_lora_file, resolve_model
from ..outputs.video import write_image
from .base import Artifact, JobContext, Pipeline, register

log = logging.getLogger("nidora.flux_t2i")


class FluxT2IParams(BaseModel):
    prompt: str
    width: int = Field(1024, ge=256, le=2048, multiple_of=16)
    height: int = Field(1024, ge=256, le=2048, multiple_of=16)
    num_inference_steps: int = Field(20, ge=1, le=50)
    guidance_scale: float = Field(3.5, ge=0.0, le=20.0)
    seed: int | None = None


@register
class FluxT2IPipeline(Pipeline):
    kind: ClassVar[str] = "flux_t2i"
    Params: ClassVar[type[BaseModel]] = FluxT2IParams

    _pipe = None

    def load(self) -> None:
        import torch
        from diffusers import FluxPipeline

        manifest = load_model_manifest(self.settings.models_config)
        model_path = resolve_model(self.settings, self.profile.model, manifest)

        dtype = {
            "bf16": torch.bfloat16,
            "fp16": torch.float16,
            "fp32": torch.float32,
        }[self.settings.dtype]

        log.info("loading %s (%s)", self.profile.model, model_path)
        pipe = FluxPipeline.from_pretrained(model_path, torch_dtype=dtype)

        for target, lora in self.profile.loras.items():
            lora_dir, weight_name = resolve_lora_file(
                self.settings, lora.model, lora.weight_name, manifest
            )
            pipe.load_lora_weights(lora_dir, weight_name=weight_name, adapter_name=target)

        device = self.settings.resolve_device()
        if device != "cuda":
            pipe.to(device)
        elif self.settings.offload == "model":
            pipe.enable_model_cpu_offload()
        elif self.settings.offload == "sequential":
            pipe.enable_sequential_cpu_offload()
        else:
            pipe.to("cuda")

        apply_attention_backend(
            self.settings.attention, [getattr(pipe, "transformer", None)], device
        )
        self._pipe = pipe

    def generate(self, params: FluxT2IParams, ctx: JobContext) -> list[Artifact]:
        import torch

        generator = None
        if params.seed is not None:
            generator = torch.Generator(device="cpu").manual_seed(params.seed)

        def on_step_end(pipeline, step, timestep, callback_kwargs):
            ctx.check_cancelled()
            ctx.report_progress(step + 1, params.num_inference_steps)
            return callback_kwargs

        result = self._pipe(
            prompt=params.prompt,
            width=params.width,
            height=params.height,
            num_inference_steps=params.num_inference_steps,
            guidance_scale=params.guidance_scale,
            generator=generator,
            callback_on_step_end=on_step_end,
        )
        path = write_image(result.images[0], ctx.output_dir / "output.png")
        return [Artifact(path=path, media_type="image/png")]
