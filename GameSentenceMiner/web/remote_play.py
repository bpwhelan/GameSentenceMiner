from __future__ import annotations

import hmac
import secrets
import threading
import time
from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class NormalizedPointer:
    x: float
    y: float
    inside_video: bool


def map_letterboxed_pointer(
    pointer_x: float,
    pointer_y: float,
    display_width: float,
    display_height: float,
    source_width: float,
    source_height: float,
) -> NormalizedPointer:
    if min(display_width, display_height, source_width, source_height) <= 0:
        raise ValueError("Display and source dimensions must be greater than zero.")

    scale = min(display_width / source_width, display_height / source_height)
    video_width = source_width * scale
    video_height = source_height * scale
    offset_x = (display_width - video_width) / 2
    offset_y = (display_height - video_height) / 2
    normalized_x = (pointer_x - offset_x) / video_width
    normalized_y = (pointer_y - offset_y) / video_height
    inside_video = 0 <= normalized_x <= 1 and 0 <= normalized_y <= 1
    return NormalizedPointer(
        x=max(0.0, min(1.0, normalized_x)),
        y=max(0.0, min(1.0, normalized_y)),
        inside_video=inside_video,
    )


class RemotePlayAccess:
    def __init__(self, token_ttl_seconds: float = 15 * 60):
        self._token_ttl_seconds = token_ttl_seconds
        self._token: str | None = None
        self._expires_at = 0.0
        self._lock = threading.Lock()

    def issue_token(self) -> str:
        token = secrets.token_urlsafe(32)
        with self._lock:
            self._token = token
            self._expires_at = time.monotonic() + self._token_ttl_seconds
        return token

    def validate(self, candidate: str | None) -> bool:
        with self._lock:
            token = self._token
            expires_at = self._expires_at
        return bool(token and candidate and time.monotonic() <= expires_at and hmac.compare_digest(token, candidate))


class InputBackend(Protocol):
    def dispatch(self, event_type: str, payload: dict) -> bool: ...

    def release_all(self) -> None: ...


class RemoteInputGate:
    def __init__(self, backend: InputBackend):
        self._backend = backend
        self.enabled = False

    def set_enabled(self, enabled: bool) -> None:
        if not enabled and self.enabled:
            self._backend.release_all()
        self.enabled = enabled

    def handle(self, event_type: str, payload: dict) -> bool:
        if event_type == "key_down" and payload.get("code") == "Escape":
            self.stop("escape")
            return False
        if not self.enabled:
            return False
        return self._backend.dispatch(event_type, payload)

    def stop(self, _reason: str) -> None:
        was_enabled = self.enabled
        self.enabled = False
        if was_enabled:
            self._backend.release_all()
