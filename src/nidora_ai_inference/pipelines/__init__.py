"""Pipeline registry. Importing this package registers all concrete pipelines."""

from .base import REGISTRY, Artifact, JobCancelled, JobContext, Pipeline, register
from .mock import MockPipeline

# Heavy pipelines (torch/diffusers) are imported lazily so the API, tests, and
# CLI work on machines without GPU deps installed properly. Import errors only
# surface when a profile actually uses the pipeline kind.
_LAZY_KINDS = {
    "wan22_i2v": ".wan22_i2v",
    "flux_t2i": ".flux_t2i",
}


def resolve_pipeline_class(kind: str) -> type[Pipeline]:
    if kind not in REGISTRY and kind in _LAZY_KINDS:
        import importlib

        importlib.import_module(_LAZY_KINDS[kind], package=__name__)
    if kind not in REGISTRY:
        raise KeyError(f"unknown pipeline kind: {kind!r}")
    return REGISTRY[kind]


__all__ = [
    "REGISTRY",
    "Artifact",
    "JobCancelled",
    "JobContext",
    "MockPipeline",
    "Pipeline",
    "register",
    "resolve_pipeline_class",
]
