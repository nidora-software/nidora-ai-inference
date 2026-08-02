from __future__ import annotations

import pytest

from nidora_ai_inference.core.config import FileRef, LoraRef, ModelEntry, PipelineProfile
from nidora_ai_inference.models.manifest import (
    ModelMissing,
    download_for_profiles,
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


def test_dir_with_only_hidden_files_counts_as_missing(settings):
    # An interrupted snapshot_download leaves only .cache/ behind — the model
    # must still resolve as missing so auto-download re-fetches it.
    d = settings.models_dir / "wan" / ".cache" / "huggingface"
    d.mkdir(parents=True)
    (d / "download.lock").write_text("")
    manifest = {"wan": ModelEntry(source="Wan-AI/Wan2.2-I2V-A14B-Diffusers")}
    with pytest.raises(ModelMissing):
        resolve_model(settings, "wan", manifest)


def test_auto_download_refetches_partial_model(settings, monkeypatch):
    # Dir exists with *some* content, but the file the profile references is
    # absent — download_for_profiles must include it in the fetch list.
    import yaml

    gguf_dir = settings.models_dir / "gguf"
    gguf_dir.mkdir(parents=True)
    (gguf_dir / "README.md").write_text("partial")
    settings.models_config.write_text(
        yaml.safe_dump({"models": {"gguf": {"source": "org/repo"}}})
    )
    profiles = {
        "p": PipelineProfile(
            name="p",
            kind="wan22_i2v",
            gguf={"transformer": FileRef(model="gguf", weight_name="HighNoise/model.gguf")},
        )
    }

    fetched: list[str] = []
    monkeypatch.setattr(
        "nidora_ai_inference.models.manifest.download_models",
        lambda settings, manifest, names: fetched.extend(names),
    )
    download_for_profiles(settings, profiles)
    assert fetched == ["gguf"]


def test_auto_download_skips_complete_model(settings, monkeypatch):
    import yaml

    gguf_dir = settings.models_dir / "gguf" / "HighNoise"
    gguf_dir.mkdir(parents=True)
    (gguf_dir / "model.gguf").write_text("x")
    settings.models_config.write_text(
        yaml.safe_dump({"models": {"gguf": {"source": "org/repo"}}})
    )
    profiles = {
        "p": PipelineProfile(
            name="p",
            kind="wan22_i2v",
            gguf={"transformer": FileRef(model="gguf", weight_name="HighNoise/model.gguf")},
        )
    }

    fetched: list[str] = []
    monkeypatch.setattr(
        "nidora_ai_inference.models.manifest.download_models",
        lambda settings, manifest, names: fetched.extend(names),
    )
    download_for_profiles(settings, profiles)
    assert fetched == []


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
