from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Dict, Any


@dataclass(frozen=True)
class AIRequest:
    provider: str
    model: str
    prompt: str
    temperature: float
    top_p: float
    max_tokens: int
    game_title: str = ""
    request_kind: str = "translation"
    metadata: Optional[Dict[str, Any]] = None


@dataclass(frozen=True)
class AIResponse:
    provider: str
    model: str
    text: str
    raw_text: str
    latency_ms: int
    usage: Optional[Dict[str, Any]] = None


class AIError(Exception):
    def __init__(self, message: str, transient: bool = False):
        super().__init__(message)
        self.transient = transient
