"""Wan 2.2 image-to-video (A14B MoE: high-noise + low-noise experts).

Default profile mirrors the production ComfyUI template: Q6_K GGUF-quantized
experts, Lightning 4-step LoRAs (high-noise @ 0.5, low-noise @ 1.0), euler
scheduler, aspect-preserving sizing, cfg 1. The same class also runs the
full-precision diffusers snapshot when a profile omits the `gguf` section.
"""

from __future__ import annotations

import base64
import io
import logging
import math
from typing import ClassVar, Literal

from PIL import Image
from pydantic import BaseModel, Field

from ..core.attention import apply_attention_backend
from ..core.config import load_model_manifest
from ..models.manifest import resolve_lora_file, resolve_model
from ..outputs.video import write_mp4
from .base import Artifact, JobContext, Pipeline, register

log = logging.getLogger("nidora.wan22_i2v")

# Fixed-size mode: (height, width) for portrait 9:16; swapped for 16:9.
FIXED_RESOLUTIONS: dict[str, tuple[int, int]] = {
    "480p": (832, 480),
    "720p": (1280, 720),
}

# Preserve mode: the input image keeps its aspect ratio and is scaled to the
# largest size whose pixel area fits the resolution bucket (same convention as
# the diffusers/Replicate Wan pipelines).
MAX_AREA: dict[str, int] = {"480p": 480 * 832, "720p": 720 * 1280}

DEFAULT_NEGATIVE_PROMPT = (
    "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，"
    "最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，"
    "画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，"
    "杂乱的背景，三条腿，背景人很多，倒着走"
)


class Wan22I2VParams(BaseModel):
    image: str  # URL, data URI, or raw base64
    prompt: str
    negative_prompt: str = DEFAULT_NEGATIVE_PROMPT
    resolution: Literal["480p", "720p"] = "480p"
    # "preserve": keep the input image's aspect ratio at the largest size
    # whose pixel area fits the 480p/720p bucket.
    # "fixed": exact 480×832 / 720×1280 per aspect_ratio.
    fit: Literal["preserve", "fixed"] = "preserve"
    aspect_ratio: Literal["9:16", "16:9"] = "9:16"  # fixed mode only
    num_frames: int = Field(81, ge=17, le=241)
    frames_per_second: int = Field(16, ge=8, le=30)
    num_inference_steps: int = Field(4, ge=1, le=50)
    guidance_scale: float = Field(1.0, ge=0.0, le=20.0)  # high-noise expert CFG
    guidance_scale_2: float = Field(1.0, ge=0.0, le=20.0)  # low-noise expert CFG
    sample_shift: float = Field(5.0, ge=1.0, le=20.0)
    scheduler: Literal["euler", "unipc"] = "euler"
    # Expert handoff point (fraction of the diffusion schedule handled by the
    # high-noise expert). None = the model's own config value.
    boundary_ratio: float | None = Field(None, ge=0.0, le=1.0)
    # None = the profile's per-LoRA strength (template: high 0.5, low 1.0).
    lora_scale_transformer: float | None = Field(None, ge=0.0, le=2.0)
    lora_scale_transformer_2: float | None = Field(None, ge=0.0, le=2.0)
    crf: int = Field(18, ge=1, le=51)
    seed: int | None = None


def _floor16(value: float) -> int:
    return max(16, round(value) // 16 * 16)


def compute_size(
    image_size: tuple[int, int],
    resolution: str,
    fit: str,
    aspect_ratio: str,
) -> tuple[int, int]:
    """Return (height, width), both multiples of 16."""
    if fit == "fixed":
        height, width = FIXED_RESOLUTIONS[resolution]
        if aspect_ratio == "16:9":
            height, width = width, height
        return height, width
    img_w, img_h = image_size
    scale = math.sqrt(MAX_AREA[resolution] / (img_w * img_h))
    return _floor16(img_h * scale), _floor16(img_w * scale)


def fetch_image(source: str) -> Image.Image:
    if source.startswith(("http://", "https://")):
        import httpx

        res = httpx.get(source, timeout=60, follow_redirects=True)
        res.raise_for_status()
        data = res.content
    else:
        payload = source.split(",", 1)[1] if source.startswith("data:") else source
        data = base64.b64decode(payload)
    return Image.open(io.BytesIO(data)).convert("RGB")


@register
class Wan22I2VPipeline(Pipeline):
    kind: ClassVar[str] = "wan22_i2v"
    Params: ClassVar[type[BaseModel]] = Wan22I2VParams

    _pipe = None

    def load(self) -> None:
        import torch
        from diffusers import WanImageToVideoPipeline

        manifest = load_model_manifest(self.settings.models_config)
        model_path = resolve_model(self.settings, self.profile.model, manifest)

        dtype = {
            "bf16": torch.bfloat16,
            "fp16": torch.float16,
            "fp32": torch.float32,
        }[self.settings.dtype]

        device = self.settings.resolve_device()
        offload = self.settings.offload
        log.info("device=%s offload=%s dtype=%s", device, offload, self.settings.dtype)

        # GGUF-quantized experts replace the snapshot's transformers.
        extra_components = {}
        if self.profile.gguf:
            from diffusers import GGUFQuantizationConfig, WanTransformer3DModel

            for target, ref in self.profile.gguf.items():
                gguf_dir, weight_name = resolve_lora_file(
                    self.settings, ref.model, ref.weight_name, manifest
                )
                log.info("loading GGUF %s -> %s", weight_name, target)
                extra_components[target] = WanTransformer3DModel.from_single_file(
                    gguf_dir / weight_name,
                    quantization_config=GGUFQuantizationConfig(compute_dtype=dtype),
                    config=str(model_path),
                    subfolder=target,
                    torch_dtype=dtype,
                )

        log.info("loading %s (%s)", self.profile.model, model_path)
        pipe = WanImageToVideoPipeline.from_pretrained(
            model_path, torch_dtype=dtype, **extra_components
        )

        self._scheduler_config = dict(pipe.scheduler.config)
        self._scheduler_key: tuple[str, float] | None = None
        self._default_boundary = pipe.config.get("boundary_ratio", None)

        self._adapters: list[tuple[str, str, float]] = []  # (adapter, target, strength)
        for target, lora in self.profile.loras.items():
            lora_dir, weight_name = resolve_lora_file(
                self.settings, lora.model, lora.weight_name, manifest
            )
            adapter_name = f"lora_{target}"
            log.info("loading LoRA %s -> %s (strength %s)", weight_name, target, lora.strength)
            pipe.load_lora_weights(
                lora_dir,
                weight_name=weight_name,
                adapter_name=adapter_name,
                load_into_transformer_2=(target == "transformer_2"),
            )
            self._adapters.append((adapter_name, target, lora.strength))

        if device != "cuda":
            pipe.to(device)
        elif offload == "model":
            pipe.enable_model_cpu_offload()
        elif offload == "sequential":
            pipe.enable_sequential_cpu_offload()
        elif offload == "group":
            from diffusers.hooks import apply_group_offloading

            # Stream the two experts through the GPU in small groups —
            # required on cards where a single expert exceeds VRAM.
            # Group-offloaded modules must NOT be .to()'d afterwards.
            for name in ("transformer", "transformer_2"):
                module = getattr(pipe, name, None)
                if module is not None:
                    apply_group_offloading(
                        module,
                        onload_device=torch.device("cuda"),
                        offload_device=torch.device("cpu"),
                        offload_type="leaf_level",
                        use_stream=True,
                        # Pin per-group at transfer time, not all weights up
                        # front — pinning both experts gets the container
                        # OOM-killed on RAM-tight hosts.
                        low_cpu_mem_usage=True,
                    )
            for name, module in pipe.components.items():
                if name not in ("transformer", "transformer_2") and isinstance(
                    module, torch.nn.Module
                ):
                    module.to("cuda")
        else:
            pipe.to("cuda")

        apply_attention_backend(
            self.settings.attention,
            [getattr(pipe, "transformer", None), getattr(pipe, "transformer_2", None)],
            device,
        )
        self._pipe = pipe

    def _set_scheduler(self, name: str, shift: float) -> None:
        if self._scheduler_key == (name, shift):
            return
        if name == "euler":
            from diffusers import FlowMatchEulerDiscreteScheduler

            self._pipe.scheduler = FlowMatchEulerDiscreteScheduler.from_config(
                self._scheduler_config, shift=shift
            )
        else:
            from diffusers import UniPCMultistepScheduler

            self._pipe.scheduler = UniPCMultistepScheduler.from_config(
                self._scheduler_config, flow_shift=shift
            )
        self._scheduler_key = (name, shift)

    def generate(self, params: Wan22I2VParams, ctx: JobContext) -> list[Artifact]:
        import torch

        pipe = self._pipe
        image = fetch_image(params.image)
        height, width = compute_size(image.size, params.resolution, params.fit, params.aspect_ratio)
        log.info("generating %dx%d, %d frames", width, height, params.num_frames)

        # Per-module (not pipeline-level) so each expert only ever sees its own
        # adapter — pipeline set_adapters pushes every name into every component.
        for adapter_name, target, strength in self._adapters:
            module = getattr(pipe, target, None)
            if module is not None:
                override = (
                    params.lora_scale_transformer
                    if target == "transformer"
                    else params.lora_scale_transformer_2
                )
                module.set_adapters([adapter_name], [strength if override is None else override])

        self._set_scheduler(params.scheduler, params.sample_shift)

        boundary = (
            params.boundary_ratio if params.boundary_ratio is not None else self._default_boundary
        )
        if pipe.config.get("boundary_ratio", None) != boundary:
            pipe.register_to_config(boundary_ratio=boundary)

        generator = None
        if params.seed is not None:
            generator = torch.Generator(device="cpu").manual_seed(params.seed)

        def on_step_end(pipeline, step, timestep, callback_kwargs):
            ctx.check_cancelled()
            ctx.report_progress(step + 1, params.num_inference_steps)
            return callback_kwargs

        result = pipe(
            image=image,
            prompt=params.prompt,
            negative_prompt=params.negative_prompt,
            height=height,
            width=width,
            num_frames=params.num_frames,
            num_inference_steps=params.num_inference_steps,
            guidance_scale=params.guidance_scale,
            guidance_scale_2=params.guidance_scale_2,
            generator=generator,
            callback_on_step_end=on_step_end,
        )

        frames = result.frames[0]
        path = write_mp4(
            frames,
            ctx.output_dir / f"{ctx.job_id}.mp4",
            fps=params.frames_per_second,
            crf=params.crf,
        )
        return [Artifact(path=path, media_type="video/mp4")]
