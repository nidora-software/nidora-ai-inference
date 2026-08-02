"""Attention backend selection (SDPA / SageAttention / FlashAttention).

Applied per-transformer via diffusers' `set_attention_backend`. `auto` prefers
SageAttention when importable and falls back to PyTorch SDPA; explicit choices
fail loudly so misconfigured pods don't silently run slow.
"""

from __future__ import annotations

import logging

log = logging.getLogger("nidora.attention")

_BACKEND_NAMES = {"sdpa": "native", "sage": "sage", "flash": "flash"}


def _sage_available() -> bool:
    try:
        import sageattention  # noqa: F401

        return True
    except ImportError:
        return False


def apply_attention_backend(setting: str, modules: list, device: str) -> str:
    """Apply the configured attention backend to each module (diffusers
    ModelMixin). Returns the backend actually used."""
    if device != "cuda" or setting == "sdpa":
        choice = "sdpa"
    elif setting == "auto":
        choice = "sage" if _sage_available() else "sdpa"
    else:
        choice = setting

    if choice == "sdpa":
        # PyTorch SDPA is diffusers' default — nothing to change.
        if setting not in ("sdpa", "auto"):
            log.warning("attention=%s requested but device is %s — using sdpa", setting, device)
        log.info("attention backend: sdpa")
        return "sdpa"

    backend_name = _BACKEND_NAMES[choice]
    for module in modules:
        if module is not None and hasattr(module, "set_attention_backend"):
            module.set_attention_backend(backend_name)
    log.info("attention backend: %s", choice)
    return choice
