"""Attention backend selection (SDPA / SageAttention / FlashAttention).

Applied per-transformer via diffusers' `set_attention_backend`. `auto` prefers
SageAttention when importable and falls back to PyTorch SDPA; explicit choices
fail loudly so misconfigured pods don't silently run slow.
"""

from __future__ import annotations

import logging

log = logging.getLogger("nidora.attention")

_BACKEND_NAMES = {"sdpa": "native", "sage": "sage", "flash": "flash"}


def _sage_unavailable_reason() -> str | None:
    """None when diffusers' sage backend is usable; otherwise why not.
    Needs sageattention>=2.1.1 (source-built from thu-ml/SageAttention; the
    PyPI 1.x package is too old) and an sm80+ GPU — its kernels raise at
    inference time on older cards, so gate here."""
    try:
        from importlib.metadata import PackageNotFoundError, version

        import torch
        from packaging.version import Version

        try:
            installed = version("sageattention")
        except PackageNotFoundError:
            return "sageattention is not installed"
        if Version(installed) < Version("2.1.1"):
            return f"sageattention {installed} < 2.1.1"
        capability = torch.cuda.get_device_capability()
        if capability < (8, 0):
            return f"GPU is sm{capability[0]}{capability[1]} (< sm80)"
        return None
    except Exception as exc:  # noqa: BLE001 — availability probe must not raise
        return f"{type(exc).__name__}: {exc}"


def apply_attention_backend(setting: str, modules: list, device: str) -> str:
    """Apply the configured attention backend to each module (diffusers
    ModelMixin). Returns the backend actually used."""
    if device != "cuda" or setting == "sdpa":
        choice = "sdpa"
    elif setting == "auto":
        reason = _sage_unavailable_reason()
        if reason is not None:
            log.warning("sage attention unavailable (%s) — using sdpa", reason)
        choice = "sdpa" if reason else "sage"
    else:
        choice = setting

    if choice == "sdpa":
        # PyTorch SDPA is diffusers' default — nothing to change.
        if setting not in ("sdpa", "auto"):
            log.warning("attention=%s requested but device is %s — using sdpa", setting, device)
        log.info("attention backend: sdpa")
        return "sdpa"

    backend_name = _BACKEND_NAMES[choice]
    try:
        for module in modules:
            if module is not None and hasattr(module, "set_attention_backend"):
                module.set_attention_backend(backend_name)
    except Exception as exc:
        if setting == "auto":
            # Acceleration is best-effort in auto mode — never fail a load for it.
            log.warning("attention backend %s unusable (%s) — falling back to sdpa", choice, exc)
            for module in modules:
                if module is not None and hasattr(module, "set_attention_backend"):
                    module.set_attention_backend("native")
            log.info("attention backend: sdpa")
            return "sdpa"
        raise
    log.info("attention backend: %s", choice)
    return choice
