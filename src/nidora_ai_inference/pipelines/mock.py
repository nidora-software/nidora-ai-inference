"""GPU-free pipeline for development and tests.

Renders animated gradient frames and writes a real mp4, exercising the whole
stack (queue, worker, progress, cancellation, encoding, artifact serving)
without torch/CUDA.
"""

from __future__ import annotations

import time
from typing import ClassVar

import numpy as np
from pydantic import BaseModel, Field

from ..outputs.video import write_mp4
from .base import Artifact, JobContext, Pipeline, register


class MockParams(BaseModel):
    prompt: str = "mock"
    num_frames: int = Field(16, ge=1, le=240)
    frames_per_second: int = Field(16, ge=1, le=60)
    width: int = Field(64, ge=16, le=512)
    height: int = Field(64, ge=16, le=512)
    delay_s: float = Field(0.0, ge=0.0, le=60.0)  # per-frame delay, for cancel tests
    fail: bool = False


@register
class MockPipeline(Pipeline):
    kind: ClassVar[str] = "mock"
    Params: ClassVar[type[BaseModel]] = MockParams

    def load(self) -> None:
        pass

    def generate(self, params: MockParams, ctx: JobContext) -> list[Artifact]:
        if params.fail:
            raise RuntimeError("mock failure requested")

        frames = []
        for i in range(params.num_frames):
            ctx.check_cancelled()
            if params.delay_s:
                time.sleep(params.delay_s)
            x = np.linspace(0, 255, params.width, dtype=np.uint8)
            y = np.linspace(0, 255, params.height, dtype=np.uint8)
            xx, yy = np.meshgrid(x, y)
            phase = np.uint8((i * 255) // max(params.num_frames - 1, 1))
            frame = np.stack([xx, yy, np.full_like(xx, phase)], axis=-1)
            frames.append(frame)
            ctx.report_progress(i + 1, params.num_frames)

        path = write_mp4(frames, ctx.output_dir / f"{ctx.job_id}.mp4", fps=params.frames_per_second)
        return [Artifact(path=path, media_type="video/mp4")]
