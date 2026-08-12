from __future__ import annotations

import os
from enum import Enum


class NativeMode(str, Enum):
    """Rollout mode shared by native components.

    ``shadow`` returns the Python reference result while comparing it with the
    native result.  It is intentionally diagnostic and may be substantially
    slower than either implementation by itself.
    """

    NATIVE = "native"
    PYTHON = "python"
    SHADOW = "shadow"


def get_native_mode(component: str | None = None) -> NativeMode:
    component_key = f"GSM_NATIVE_{component.upper()}_MODE" if component else None
    value = os.environ.get(component_key, "") if component_key else ""
    value = value or os.environ.get("GSM_NATIVE_MODE", NativeMode.NATIVE.value)
    try:
        return NativeMode(value.strip().lower())
    except ValueError:
        return NativeMode.NATIVE
