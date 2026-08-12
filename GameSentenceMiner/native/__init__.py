"""Stable Python facades for optional native GSM components.

Callers should import a facade from this package instead of importing
``GameSentenceMiner._native`` directly.  That keeps extension ABI details,
rollout controls, and Python fallbacks out of application code.
"""

from .runtime import NativeMode, get_native_mode

__all__ = ["NativeMode", "get_native_mode"]
