"""CPU-safe tests for the Wan 2.2 pipeline's param model, sizing, and image
decoding."""

from __future__ import annotations

import base64
import io

from PIL import Image

from nidora_ai_inference.pipelines.wan22_i2v import (
    Wan22I2VParams,
    compute_size,
    fetch_image,
)

BASE = {"image": "aGk=", "prompt": "test"}


def test_defaults():
    p = Wan22I2VParams(**BASE)
    assert p.num_frames == 81
    assert p.frames_per_second == 16
    assert p.num_inference_steps == 4
    assert p.guidance_scale == 1.0
    assert p.resolution == "480p"
    assert p.fit == "preserve"
    assert p.scheduler == "euler"
    assert p.lora_scale_transformer is None  # None -> profile strength
    assert p.boundary_ratio is None


def test_fixed_size_mapping():
    assert compute_size((100, 100), "480p", "fixed", "9:16") == (832, 480)
    assert compute_size((100, 100), "720p", "fixed", "9:16") == (1280, 720)
    assert compute_size((100, 100), "480p", "fixed", "16:9") == (480, 832)
    assert compute_size((100, 100), "720p", "fixed", "16:9") == (720, 1280)


def test_preserve_size_fits_bucket_area():
    # Portrait 9:16 input: largest /16 size whose area fits 480*832.
    h, w = compute_size((1080, 1920), "480p", "preserve", "9:16")
    assert (h, w) == (832, 464)
    assert h * w <= 480 * 832
    # Landscape input: dimensions swap.
    h, w = compute_size((1920, 1080), "480p", "preserve", "9:16")
    assert (h, w) == (464, 832)
    # 720p target: 9:16 fits the bucket exactly.
    h, w = compute_size((1080, 1920), "720p", "preserve", "9:16")
    assert (h, w) == (1280, 720)


def test_preserve_size_multiples_of_16():
    for size in [(123, 457), (999, 501), (33, 1001)]:
        h, w = compute_size(size, "480p", "preserve", "9:16")
        assert h % 16 == 0 and w % 16 == 0
        assert h >= 16 and w >= 16


def _png_b64() -> str:
    buf = io.BytesIO()
    Image.new("RGB", (8, 8), (255, 0, 0)).save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


def test_fetch_image_raw_base64():
    img = fetch_image(_png_b64())
    assert img.size == (8, 8)
    assert img.mode == "RGB"


def test_fetch_image_data_uri():
    img = fetch_image(f"data:image/png;base64,{_png_b64()}")
    assert img.size == (8, 8)


def test_pipeline_registers_lazily():
    from nidora_ai_inference.pipelines import resolve_pipeline_class

    cls = resolve_pipeline_class("wan22_i2v")
    assert cls.kind == "wan22_i2v"
    schema = cls.params_schema()
    for key in (
        "lora_scale_transformer",
        "lora_scale_transformer_2",
        "scheduler",
        "boundary_ratio",
        "fit",
        "crf",
    ):
        assert key in schema["properties"]
