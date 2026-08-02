"""Frame sequence → browser-friendly H.264 mp4 (yuv420p)."""

from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path

import imageio.v2 as imageio
import numpy as np
from PIL import Image


def write_mp4(
    frames: Iterable[Image.Image | np.ndarray],
    path: Path,
    fps: int,
    crf: int = 18,
) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    writer = imageio.get_writer(
        str(path),
        fps=fps,
        codec="libx264",
        pixelformat="yuv420p",
        macro_block_size=1,
        output_params=["-crf", str(crf)],
    )
    try:
        for frame in frames:
            if isinstance(frame, Image.Image):
                frame = np.asarray(frame.convert("RGB"))
            elif frame.dtype != np.uint8:
                # diffusers returns float frames in [0, 1]
                frame = (np.clip(frame, 0.0, 1.0) * 255).round().astype(np.uint8)
            writer.append_data(frame)
    finally:
        writer.close()
    return path


def write_image(image: Image.Image, path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path)
    return path
