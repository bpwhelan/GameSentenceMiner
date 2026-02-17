from __future__ import annotations

from typing import Protocol

from GameSentenceMiner.ai.contracts import AIRequest, AIResponse


class ProviderClient(Protocol):
    def generate(self, request: AIRequest) -> AIResponse:
        ...
