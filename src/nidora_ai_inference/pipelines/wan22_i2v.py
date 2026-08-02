"""Wan 2.2 image-to-video (A14B MoE: high-noise + low-noise experts).

Default profile pairs the base model with Lightx2v distill LoRAs for 4-step
inference: the high-noise LoRA loads into `transformer`, the low-noise one
into `transformer_2`. Param names follow the conventions of popular hosted
wan-2.2 i2v APIs so existing integrations swap in with minimal changes.
"""

from __future__ import annotations

import base64
import io
import logging
from typing import ClassVar, Literal

from PIL import Image
from pydantic import BaseModel, Field

from ..core.attention import apply_attention_backend
from ..core.config import load_model_manifest
from ..models.manifest import resolve_lora_file, resolve_model
from ..outputs.video import write_mp4
from .base import Artifact, JobContext, Pipeline, register

log = logging.getLogger("nidora.wan22_i2v")

# Portrait (9:16); swapped for 16:9.
RESOLUTIONS: dict[str, tuple[int, int]] = {
    "480p": (832, 480),  # (height, width) for 9:16
    "720p": (1280, 720),
}

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
    aspect_ratio: Literal["9:16", "16:9"] = "9:16"
    num_frames: int = Field(81, ge=17, le=161)
    frames_per_second: int = Field(16, ge=8, le=30)
    num_inference_steps: int = Field(4, ge=1, le=50)
    guidance_scale: float = Field(1.0, ge=0.0, le=20.0)  # high-noise expert CFG
    guidance_scale_2: float = Field(1.0, ge=0.0, le=20.0)  # low-noise expert CFG
    sample_shift: float = Field(5.0, ge=1.0, le=20.0)
    lora_scale_transformer: float = Field(1.0, ge=0.0, le=2.0)  # high-noise LoRA
    lora_scale_transformer_2: float = Field(1.0, ge=0.0, le=2.0)  # low-noise LoRA
    seed: int | None = None

    def size(self) -> tuple[int, int]:
        height, width = RESOLUTIONS[self.resolution]
        if self.aspect_ratio == "16:9":
            height, width = width, height
        return height, width


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
        from diffusers import UniPCMultistepScheduler, WanImageToVideoPipeline

        manifest = load_model_manifest(self.settings.models_config)
        model_path = resolve_model(self.settings, self.profile.model, manifest)

        dtype = {
            "bf16": torch.bfloat16,
            "fp16": torch.float16,
            "fp32": torch.float32,
        }[self.settings.dtype]

        log.info("loading %s (%s)", self.profile.model, model_path)
        pipe = WanImageToVideoPipeline.from_pretrained(model_path, torch_dtype=dtype)

        self._flow_shift = float(self.profile.defaults.get("sample_shift", 5.0))
        pipe.scheduler = UniPCMultistepScheduler.from_config(
            pipe.scheduler.config, flow_shift=self._flow_shift
        )

        self._adapter_targets: list[tuple[str, str]] = []  # (adapter_name, target)
        for target, lora in self.profile.loras.items():
            lora_dir, weight_name = resolve_lora_file(
                self.settings, lora.model, lora.weight_name, manifest
            )
            adapter_name = f"lora_{target}"
            log.info("loading LoRA %s -> %s", weight_name or lora.model, target)
            pipe.load_lora_weights(
                lora_dir,
                weight_name=weight_name,
                adapter_name=adapter_name,
                load_into_transformer_2=(target == "transformer_2"),
            )
            self._adapter_targets.append((adapter_name, target))

        device = self.settings.resolve_device()
        offload = self.settings.offload
        log.info("device=%s offload=%s dtype=%s", device, offload, self.settings.dtype)
        if device != "cuda":
            pipe.to(device)
        elif offload == "model":
            pipe.enable_model_cpu_offload()
        elif offload == "sequential":
            pipe.enable_sequential_cpu_offload()
        elif offload == "group":
            from diffusers.hooks import apply_group_offloading

            # Stream the two 14B experts through the GPU in small groups —
            # required on cards where a single expert (~28 GB bf16) exceeds
            # VRAM. Group-offloaded modules must NOT be .to()'d afterwards.
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
                        # front — pinning both 14B experts (~56 GB) gets the
                        # container OOM-killed on 64-96 GB hosts.
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

    def generate(self, params: Wan22I2VParams, ctx: JobContext) -> list[Artifact]:
        import torch

        pipe = self._pipe
        image = fetch_image(params.image)
        height, width = params.size()

        # Per-module (not pipeline-level) so each expert only ever sees its own
        # adapter — pipeline set_adapters pushes every name into every component.
        for adapter_name, target in self._adapter_targets:
            module = getattr(pipe, target, None)
            if module is not None:
                scale = (
                    params.lora_scale_transformer
                    if target == "transformer"
                    else params.lora_scale_transformer_2
                )
                module.set_adapters([adapter_name], [scale])

        if params.sample_shift != self._flow_shift:
            from diffusers import UniPCMultistepScheduler

            pipe.scheduler = UniPCMultistepScheduler.from_config(
                pipe.scheduler.config, flow_shift=params.sample_shift
            )
            self._flow_shift = params.sample_shift

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
        path = write_mp4(frames, ctx.output_dir / "output.mp4", fps=params.frames_per_second)
        return [Artifact(path=path, media_type="video/mp4")]
