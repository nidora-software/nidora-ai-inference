"""CPU-safe tests for the Wan 2.2 pipeline's param model and image decoding."""

from __future__ import annotations

import base64
import io

from PIL import Image

from nidora_ai_inference.pipelines.wan22_i2v import Wan22I2VParams, fetch_image

BASE = {"image": "aGk=", "prompt": "test"}


def test_defaults_match_production_conventions():
    p = Wan22I2VParams(**BASE)
    assert p.num_frames == 81
    assert p.frames_per_second == 16
    assert p.num_inference_steps == 4
    assert p.guidance_scale == 1.0
    assert p.resolution == "480p"
    assert p.aspect_ratio == "9:16"


def test_resolution_mapping():
    assert Wan22I2VParams(**BASE).size() == (832, 480)
    assert Wan22I2VParams(**BASE, resolution="720p").size() == (1280, 720)
    assert Wan22I2VParams(**BASE, aspect_ratio="16:9").size() == (480, 832)
    assert Wan22I2VParams(**BASE, resolution="720p", aspect_ratio="16:9").size() == (720, 1280)


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
    assert "lora_scale_transformer" in schema["properties"]
    assert "lora_scale_transformer_2" in schema["properties"]
