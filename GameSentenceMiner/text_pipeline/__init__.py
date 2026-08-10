"""Authoritative, revision-aware text stream for GSM."""

from .coordinator import TextCoordinatorActor, TextCoordinatorState
from .models import (
    IngressAck,
    IngressStatus,
    SourceKind,
    TextDomainEvent,
    TextEventKind,
    TextObservation,
    TextRecordSnapshot,
    TextRecordState,
    TextStreamSnapshot,
)

__all__ = [
    "IngressAck",
    "IngressStatus",
    "SourceKind",
    "TextCoordinatorActor",
    "TextCoordinatorState",
    "TextDomainEvent",
    "TextEventKind",
    "TextObservation",
    "TextRecordSnapshot",
    "TextRecordState",
    "TextStreamSnapshot",
]
