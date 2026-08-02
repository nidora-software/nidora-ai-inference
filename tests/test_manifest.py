from __future__ import annotations

import pytest

from nidora_ai_inference.core.config import LoraRef, ModelEntry, PipelineProfile
from nidora_ai_inference.models.manifest import (
    ModelMissing,
    models_for_profiles,
    resolve_lora_file,
    resolve_model,
)


def test_resolve_missing_model_is_actionable(settings):
    manifest = {"wan": ModelEntry(source="Wan-AI/Wan2.2-I2V-A14B-Diffusers")}
    with pytest.raises(ModelMissing) as exc:
        resolve_model(settings, "wan", manifest)
    msg = str(exc.value)
    assert "Wan-AI/Wan2.2-I2V-A14B-Diffusers" in msg
    assert "nidora-ai-inference download wan" in msg
    assert str(settings.models_dir / "wan") in msg


def test_resolve_unknown_name(settings):
    with pytest.raises(KeyError):
        resolve_model(settings, "nope", {})


def test_resolve_local_dir(settings):
    d = settings.models_dir / "wan"
    d.mkdir(parents=True)
    (d / "model_index.json").write_text("{}")
    manifest = {"wan": ModelEntry(source="Wan-AI/Wan2.2-I2V-A14B-Diffusers")}
    assert resolve_model(settings, "wan", manifest) == d


def test_resolve_absolute_local_source(settings, tmp_path):
    external = tmp_path / "elsewhere" / "my-model"
    external.mkdir(parents=True)
    (external / "weights.safetensors").write_text("x")
    manifest = {"custom": ModelEntry(source=str(external))}
    assert resolve_model(settings, "custom", manifest) == external


def test_resolve_lora_file(settings):
    d = settings.models_dir / "distill"
    d.mkdir(parents=True)
    (d / "high.safetensors").write_text("x")
    manifest = {"distill": ModelEntry(source="lightx2v/Wan2.2-Distill-Loras")}

    base, weight = resolve_lora_file(settings, "distill", "high.safetensors", manifest)
    assert base == d
    assert weight == "high.safetensors"

    with pytest.raises(ModelMissing):
        resolve_lora_file(settings, "distill", "missing.safetensors", manifest)


def test_models_for_profiles_dedupes():
    profiles = {
        "a": PipelineProfile(
            name="a",
            kind="wan22_i2v",
            model="wan",
            loras={
                "transformer": LoraRef(model="distill", weight_name="hi.safetensors"),
                "transformer_2": LoraRef(model="distill", weight_name="lo.safetensors"),
            },
        ),
        "b": PipelineProfile(name="b", kind="mock", model="wan"),
    }
    assert models_for_profiles(profiles) == ["wan", "distill"]
