"""Runtime settings (env-driven) and YAML config loading for model manifest and
pipeline profiles."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="NIDORA_", env_file=".env", extra="ignore")

    models_dir: Path = Path("models")
    outputs_dir: Path = Path("outputs")
    db_path: Path = Path("jobs.sqlite3")

    pipelines_config: Path = Path("configs/pipelines.yaml")
    models_config: Path = Path("configs/models.yaml")

    device: str | None = None  # "cuda" | "cpu" | None = auto-detect
    dtype: Literal["bf16", "fp16", "fp32"] = "bf16"
    offload: Literal["none", "model", "sequential", "group"] = "none"
    attention: Literal["auto", "sdpa", "sage", "flash"] = "auto"

    auto_download: bool = False

    # Pipeline profile to load at startup (NIDORA_WARMUP=wan22-i2v) so the
    # first job doesn't pay the model-load cost. Unset = no warmup.
    warmup: str | None = None

    # When set, all /v1/* endpoints require this key via the X-Api-Key header
    # (or Authorization: Bearer). /health stays open for load balancers.
    api_key: str | None = None

    host: str = "0.0.0.0"
    port: int = 8000

    def resolve_device(self) -> str:
        if self.device:
            return self.device
        try:
            import torch

            return "cuda" if torch.cuda.is_available() else "cpu"
        except ImportError:
            return "cpu"


class ModelEntry(BaseModel):
    """One entry in configs/models.yaml — a HF repo or a local path."""

    source: str
    revision: str | None = None
    allow_patterns: list[str] | None = None
    ignore_patterns: list[str] | None = None


class FileRef(BaseModel):
    """A reference to a file inside a ModelEntry."""

    model: str  # name of a ModelEntry
    weight_name: str | None = None


class LoraRef(FileRef):
    """A LoRA reference inside a pipeline profile."""

    strength: float = 1.0


class PipelineProfile(BaseModel):
    """One entry in configs/pipelines.yaml — a named, configured pipeline variant."""

    name: str
    kind: str
    model: str | None = None  # name of a ModelEntry
    gguf: dict[str, FileRef] = Field(default_factory=dict)  # target -> GGUF file
    loras: dict[str, LoraRef] = Field(default_factory=dict)  # target -> LoRA
    defaults: dict[str, Any] = Field(default_factory=dict)


def load_model_manifest(path: Path) -> dict[str, ModelEntry]:
    raw = yaml.safe_load(path.read_text()) or {}
    return {name: ModelEntry(**entry) for name, entry in (raw.get("models") or {}).items()}


def load_pipeline_profiles(path: Path) -> dict[str, PipelineProfile]:
    raw = yaml.safe_load(path.read_text()) or {}
    return {
        name: PipelineProfile(name=name, **entry)
        for name, entry in (raw.get("pipelines") or {}).items()
    }
