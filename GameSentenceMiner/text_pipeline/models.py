from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from types import MappingProxyType
from typing import Any, Mapping


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def normalize_utc(value: datetime | None) -> datetime:
    if value is None:
        return utc_now()
    if value.tzinfo is None:
        # Legacy GSM timestamps are local wall-clock values. Let Python attach the
        # configured local zone before converting them to an unambiguous UTC value.
        return value.astimezone().astimezone(timezone.utc)
    return value.astimezone(timezone.utc)


class SourceKind(Enum):
    MANUAL = "manual"
    TEXTHOOK = "texthook"
    CLIPBOARD = "clipboard"
    WEBSOCKET = "websocket"
    OCR = "ocr"
    OCR_MANUAL = "ocr_manual"
    OVERLAY = "overlay"
    SCREEN_CROPPER = "screen_cropper"
    HOTKEY = "hotkey"
    SECONDARY = "secondary"
    SPEECH_RECOGNITION = "speech_recognition"
    UNKNOWN = "unknown"

    @classmethod
    def normalize(cls, value: str | None, display_name: str | None = None) -> "SourceKind":
        candidate = str(value or "").strip().lower().replace("-", "_")
        display = str(display_name or "").strip().lower()
        aliases = {
            "hooker": cls.TEXTHOOK,
            "texthook": cls.TEXTHOOK,
            "textractor": cls.TEXTHOOK,
            "luna": cls.TEXTHOOK,
            "manual": cls.MANUAL,
            "clipboard": cls.CLIPBOARD,
            "ocr": cls.OCR,
            "ocr_manual": cls.OCR_MANUAL,
            "overlay": cls.OVERLAY,
            "screen_cropper": cls.SCREEN_CROPPER,
            "hotkey": cls.HOTKEY,
            "secondary": cls.SECONDARY,
            "websocket": cls.WEBSOCKET,
            "speech": cls.SPEECH_RECOGNITION,
            "speech_recognition": cls.SPEECH_RECOGNITION,
            "windows_speech": cls.SPEECH_RECOGNITION,
            "windows_speech_recognition": cls.SPEECH_RECOGNITION,
            "mssr": cls.SPEECH_RECOGNITION,
        }
        if candidate in aliases:
            return aliases[candidate]
        if "hook" in display or "luna" in display or "textractor" in display:
            return cls.TEXTHOOK
        if "clipboard" in display:
            return cls.CLIPBOARD
        if "ocr" in display:
            return cls.OCR
        if "speech" in display and "recogn" in display:
            return cls.SPEECH_RECOGNITION
        if candidate:
            return cls.WEBSOCKET
        return cls.UNKNOWN


class TextRecordState(Enum):
    PROVISIONAL = "provisional"
    FROZEN = "frozen"
    EXPIRED = "expired"


class TextEventKind(Enum):
    APPENDED = "append"
    UPDATED = "update"
    FROZEN = "freeze"
    EXPIRED = "expire"
    RESET = "reset"


class IngressStatus(Enum):
    ACCEPTED = "accepted"
    DUPLICATE = "duplicate"
    STALE_EXCLUDED = "stale_excluded"
    BACKPRESSURED = "backpressured"
    REJECTED = "rejected"


@dataclass(frozen=True)
class TextObservation:
    observation_id: str
    source_kind: SourceKind
    source_instance: str
    raw_text: str
    captured_at_utc: datetime
    emitted_at_utc: datetime
    received_at_utc: datetime
    received_monotonic_ns: int
    source_sequence: int | None = None
    source_display_name: str = ""
    processed_text: str | None = None
    revision_window_ms: int = 100
    merge_fragments: bool = False
    copy_to_clipboard: bool = False
    excluded_from_stats: bool = False
    relay_only: bool = False
    skip_overlay: bool = False
    metadata: Mapping[str, Any] = field(default_factory=lambda: MappingProxyType({}))
    protocol_version: int = 2

    def __post_init__(self) -> None:
        object.__setattr__(self, "captured_at_utc", normalize_utc(self.captured_at_utc))
        object.__setattr__(self, "emitted_at_utc", normalize_utc(self.emitted_at_utc))
        object.__setattr__(self, "received_at_utc", normalize_utc(self.received_at_utc))
        object.__setattr__(self, "metadata", MappingProxyType(dict(self.metadata)))


@dataclass(frozen=True)
class TextRecordSnapshot:
    line_id: str
    session_id: str
    stream_sequence: int
    revision: int
    state: TextRecordState
    raw_text: str
    text: str
    source_kind: SourceKind
    source_instance: str
    source_display_name: str
    observation_ids: tuple[str, ...]
    captured_at_utc: datetime
    first_seen_at_utc: datetime
    first_seen_monotonic_ns: int
    finalized_at_utc: datetime | None = None
    scene: str = ""
    copy_to_clipboard: bool = False
    excluded_from_stats: bool = False
    relay_only: bool = False
    skip_overlay: bool = False
    metadata: Mapping[str, Any] = field(default_factory=lambda: MappingProxyType({}))

    def __post_init__(self) -> None:
        object.__setattr__(self, "metadata", MappingProxyType(dict(self.metadata)))

    def to_serializable(self) -> dict[str, Any]:
        return {
            "id": self.line_id,
            "session_id": self.session_id,
            "stream_sequence": self.stream_sequence,
            "revision": self.revision,
            "state": self.state.value,
            "raw_text": self.raw_text,
            "text": self.text,
            "source": self.source_kind.value,
            "source_instance": self.source_instance,
            "source_display_name": self.source_display_name,
            "observation_ids": list(self.observation_ids),
            "captured_at": self.captured_at_utc.isoformat(),
            "first_seen_at": self.first_seen_at_utc.isoformat(),
            "finalized_at": self.finalized_at_utc.isoformat() if self.finalized_at_utc else None,
            "scene": self.scene,
            "excluded_from_stats": self.excluded_from_stats,
            "relay_only": self.relay_only,
        }


@dataclass(frozen=True)
class TextDomainEvent:
    kind: TextEventKind
    record: TextRecordSnapshot

    def to_wire(self) -> dict[str, Any]:
        return {"event": f"text_v2_{self.kind.value}", "data": self.record.to_serializable()}


@dataclass(frozen=True)
class IngressAck:
    status: IngressStatus
    observation_id: str
    line_id: str | None = None
    stream_sequence: int | None = None
    revision: int | None = None
    reason: str = ""
    matched_source: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status.value,
            "observation_id": self.observation_id,
            "line_id": self.line_id,
            "stream_sequence": self.stream_sequence,
            "revision": self.revision,
            "reason": self.reason,
            "matched_source": self.matched_source,
        }


@dataclass(frozen=True)
class IngressResult:
    ack: IngressAck
    events: tuple[TextDomainEvent, ...] = ()


@dataclass(frozen=True)
class TextStreamSnapshot:
    session_id: str
    snapshot_sequence: int
    records: tuple[TextRecordSnapshot, ...]

    def to_wire(self) -> dict[str, Any]:
        return {
            "event": "text_v2_snapshot",
            "session_id": self.session_id,
            "snapshot_sequence": self.snapshot_sequence,
            "lines": [record.to_serializable() for record in self.records],
        }
