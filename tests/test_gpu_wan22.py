"""GPU smoke test — needs CUDA + provisioned weights. Run with: pytest -m gpu"""

from __future__ import annotations

import base64
import io

import pytest

from nidora_ai_inference.core.config import (
    Settings,
    load_model_manifest,
    load_pipeline_profiles,
)
from nidora_ai_inference.models.manifest import ModelMissing, resolve_model

pytestmark = pytest.mark.gpu


@pytest.fixture(scope="module")
def real_settings() -> Settings:
    settings = Settings()
    try:
        import torch

        if not torch.cuda.is_available():
            pytest.skip("no CUDA device")
    except ImportError:
        pytest.skip("torch not installed")
    manifest = load_model_manifest(settings.models_config)
    try:
        resolve_model(settings, "wan22-i2v-a14b", manifest)
        resolve_model(settings, "lightx2v-distill", manifest)
    except (ModelMissing, KeyError) as exc:
        pytest.skip(str(exc))
    return settings


def _input_image_b64(width: int = 480, height: int = 832) -> str:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (width, height), (120, 80, 200)).save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


def test_wan22_i2v_end_to_end(real_settings, tmp_path):
    import threading

    from nidora_ai_inference.pipelines import JobContext, resolve_pipeline_class

    profiles = load_pipeline_profiles(real_settings.pipelines_config)
    profile = profiles["wan22-i2v"]
    cls = resolve_pipeline_class(profile.kind)
    pipeline = cls(profile, real_settings)
    pipeline.load()
    try:
        params = pipeline.validate_params(
            {
                "image": _input_image_b64(),
                "prompt": "the camera slowly zooms in",
                "resolution": "480p",
                "num_frames": 81,
                "seed": 42,
            }
        )
        progress: list[tuple[int, int]] = []
        ctx = JobContext(
            job_id="gpu-smoke",
            cancel_event=threading.Event(),
            report_progress=lambda s, t: progress.append((s, t)),
            output_dir=tmp_path,
        )
        artifacts = pipeline.generate(params, ctx)
        assert len(artifacts) == 1
        out = artifacts[0].path
        assert out.is_file() and out.stat().st_size > 0
        assert progress and progress[-1] == (4, 4)
    finally:
        pipeline.unload()
