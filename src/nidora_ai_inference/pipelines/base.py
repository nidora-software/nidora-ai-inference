"""Pipeline abstraction: a small ABC + a plain dict registry.

A *pipeline class* is code (how to load and generate). A *profile*
(configs/pipelines.yaml) binds a class to a model, LoRAs, and default params.
The API exposes profiles; several profiles can share one class.
"""

from __future__ import annotations

import gc
import threading
from abc import ABC, abstractmethod
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, ClassVar

from pydantic import BaseModel

from ..core.config import PipelineProfile, Settings


class JobCancelled(Exception):
    pass


@dataclass
class Artifact:
    path: Path
    media_type: str


@dataclass
class JobContext:
    job_id: str
    cancel_event: threading.Event
    report_progress: Callable[[int, int], None]  # (step, total_steps)
    output_dir: Path

    def check_cancelled(self) -> None:
        if self.cancel_event.is_set():
            raise JobCancelled(self.job_id)


REGISTRY: dict[str, type[Pipeline]] = {}


def register(cls: type[Pipeline]) -> type[Pipeline]:
    REGISTRY[cls.kind] = cls
    return cls


class Pipeline(ABC):
    kind: ClassVar[str]
    Params: ClassVar[type[BaseModel]]

    def __init__(self, profile: PipelineProfile, settings: Settings):
        self.profile = profile
        self.settings = settings

    @abstractmethod
    def load(self) -> None: ...

    @abstractmethod
    def generate(self, params: BaseModel, ctx: JobContext) -> list[Artifact]: ...

    def unload(self) -> None:
        for attr in list(vars(self)):
            if attr.startswith("_pipe"):
                setattr(self, attr, None)
        gc.collect()
        try:
            import torch

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except ImportError:
            pass

    def validate_params(self, user_params: dict[str, Any]) -> BaseModel:
        """Merge profile defaults under user params, then validate."""
        merged = {**self.profile.defaults, **user_params}
        return self.Params(**merged)

    @classmethod
    def params_schema(cls) -> dict[str, Any]:
        return cls.Params.model_json_schema()
