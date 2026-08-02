"""Model manifest resolution and (opt-in) downloading.

Local mode (default): entries resolve to local paths and a missing model is a
clear, actionable error — nothing downloads implicitly.
Cloud mode: `nidora-ai-inference download --all` or NIDORA_AUTO_DOWNLOAD=1
fetches everything from the same manifest.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

from ..core.config import (
    ModelEntry,
    PipelineProfile,
    Settings,
    load_model_manifest,
)

log = logging.getLogger("nidora.models")


class ModelMissing(Exception):
    def __init__(self, name: str, entry: ModelEntry, expected_path: Path):
        self.name = name
        self.entry = entry
        self.expected_path = expected_path
        super().__init__(
            f"model {name!r} not found at {expected_path}. "
            f"Place the files there manually (source: {entry.source}) or run "
            f"`nidora-ai-inference download {name}` to fetch them."
        )


def _is_local_source(source: str) -> bool:
    # Windows drive letters ("C:\\...") and absolute/relative paths are local;
    # anything shaped like "org/repo" is a HF repo id.
    p = Path(source)
    return p.is_absolute() or source.startswith((".", "~")) or p.exists()


def local_path_for(settings: Settings, name: str, entry: ModelEntry) -> Path:
    if _is_local_source(entry.source):
        return Path(entry.source).expanduser()
    return settings.models_dir / name


def resolve_model(settings: Settings, name: str, manifest: dict[str, ModelEntry]) -> Path:
    """Resolve a manifest name to an existing local path or raise ModelMissing."""
    entry = manifest.get(name)
    if entry is None:
        raise KeyError(f"model {name!r} is not in the manifest ({settings.models_config})")
    path = local_path_for(settings, name, entry)
    if not path.exists() or (path.is_dir() and not any(path.iterdir())):
        raise ModelMissing(name, entry, path)
    return path


def resolve_lora_file(
    settings: Settings,
    name: str,
    weight_name: str | None,
    manifest: dict[str, ModelEntry],
) -> tuple[Path, str | None]:
    """Resolve a LoRA reference to (directory_or_file, weight_name)."""
    base = resolve_model(settings, name, manifest)
    if weight_name:
        if not (base / weight_name).is_file():
            raise ModelMissing(name, manifest[name], base / weight_name)
        return base, weight_name
    return base, None


def models_for_profiles(profiles: dict[str, PipelineProfile]) -> list[str]:
    names: list[str] = []
    for profile in profiles.values():
        if profile.model and profile.model not in names:
            names.append(profile.model)
        for ref in [*profile.gguf.values(), *profile.loras.values()]:
            if ref.model not in names:
                names.append(ref.model)
    return names


def download_models(
    settings: Settings, manifest: dict[str, ModelEntry], names: list[str]
) -> None:
    os.environ.setdefault("HF_HUB_ENABLE_HF_TRANSFER", "1")
    from huggingface_hub import snapshot_download

    for name in names:
        entry = manifest[name]
        if _is_local_source(entry.source):
            log.info("%s: local source (%s), skipping download", name, entry.source)
            continue
        dest = settings.models_dir / name
        log.info("%s: downloading %s -> %s", name, entry.source, dest)
        snapshot_download(
            repo_id=entry.source,
            revision=entry.revision,
            allow_patterns=entry.allow_patterns,
            ignore_patterns=entry.ignore_patterns,
            local_dir=dest,
            token=os.environ.get("HF_TOKEN") or None,
        )
        log.info("%s: done", name)


def download_for_profiles(settings: Settings, profiles: dict[str, PipelineProfile]) -> None:
    """Startup hook for NIDORA_AUTO_DOWNLOAD=1: fetch anything missing."""
    manifest = load_model_manifest(settings.models_config)
    missing = []
    for name in models_for_profiles(profiles):
        if name not in manifest:
            log.warning("profile references unknown model %r — skipping", name)
            continue
        try:
            resolve_model(settings, name, manifest)
        except ModelMissing:
            missing.append(name)
    if missing:
        log.info("auto-download enabled — fetching: %s", ", ".join(missing))
        download_models(settings, manifest, missing)
