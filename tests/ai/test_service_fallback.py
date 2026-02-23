from __future__ import annotations

import logging

import pytest

from GameSentenceMiner.ai.contracts import AIError, AIResponse
from GameSentenceMiner.ai.service import AIService, snapshot_config
from GameSentenceMiner.util.config.configuration import (
    AI_GEMINI,
    AI_GROQ,
    AI_LM_STUDIO,
    AI_OLLAMA,
    AI_OPENAI,
    Ai,
    General,
)


class _StubRegistry:
    def __init__(self, client):
        self._client = client

    def get_client(self, _config):
        return self._client


class _FailoverClient:
    def __init__(self, primary_model: str, backup_model: str):
        self.primary_model = primary_model
        self.backup_model = backup_model
        self.models_seen: list[str] = []

    def generate(self, request):
        self.models_seen.append(request.model)
        if request.model == self.primary_model:
            raise AIError("Processing failed: 429 RESOURCE_EXHAUSTED", transient=True)
        if request.model == self.backup_model:
            return AIResponse(
                provider=request.provider,
                model=request.model,
                text='{"output":"ok"}',
                raw_text='{"output":"ok"}',
                latency_ms=5,
            )
        raise AIError("Unexpected model", transient=False)


class _AlwaysFailClient:
    def __init__(self, primary_model: str, backup_model: str):
        self.primary_model = primary_model
        self.backup_model = backup_model
        self.models_seen: list[str] = []

    def generate(self, request):
        self.models_seen.append(request.model)
        if request.model == self.primary_model:
            raise AIError("Primary failed", transient=True)
        if request.model == self.backup_model:
            raise AIError("Backup failed", transient=True)
        raise AIError("Unexpected model", transient=False)


def _build_service(ai_config: Ai, client) -> AIService:
    snapshot = snapshot_config(ai_config, General())
    return AIService(
        config_snapshot=snapshot,
        logger=logging.getLogger("test.ai.service"),
        registry=_StubRegistry(client),
    )


def _build_ai_config(provider: str, primary_model: str, backup_model: str) -> Ai:
    if provider == AI_GEMINI:
        return Ai(
            provider=provider,
            gemini_model=primary_model,
            gemini_backup_model=backup_model,
            gemini_api_key="test-key",
        )
    if provider == AI_GROQ:
        return Ai(
            provider=provider,
            groq_model=primary_model,
            groq_backup_model=backup_model,
            groq_api_key="test-key",
        )
    if provider == AI_OPENAI:
        return Ai(
            provider=provider,
            open_ai_url="https://api.example.com/v1",
            open_ai_model=primary_model,
            open_ai_backup_model=backup_model,
            open_ai_api_key="test-key",
        )
    if provider == AI_OLLAMA:
        return Ai(
            provider=provider,
            ollama_url="http://localhost:11434",
            ollama_model=primary_model,
            ollama_backup_model=backup_model,
        )
    if provider == AI_LM_STUDIO:
        return Ai(
            provider=provider,
            lm_studio_url="http://localhost:1234/v1",
            lm_studio_model=primary_model,
            lm_studio_backup_model=backup_model,
            lm_studio_api_key="lm-studio",
        )
    raise AssertionError(f"Unsupported provider in test: {provider}")


@pytest.mark.parametrize(
    ("provider", "primary_model", "backup_model"),
    [
        (AI_GEMINI, "gemini-2.5-flash", "gemma-3-27b-it"),
        (AI_GROQ, "llama-3.1-8b-instant", "qwen/qwen3-32b"),
        (AI_OPENAI, "gpt-4o-mini", "gpt-4.1-mini"),
        (AI_OLLAMA, "llama3", "qwen2.5"),
        (AI_LM_STUDIO, "mistral-small", "qwen2.5"),
    ],
)
def test_execute_request_retries_with_backup_model_on_primary_failure(provider: str, primary_model: str, backup_model: str):
    client = _FailoverClient(primary_model=primary_model, backup_model=backup_model)
    ai_config = _build_ai_config(provider, primary_model, backup_model)
    service = _build_service(ai_config, client)

    request = service._make_request(prompt='{"output":"hello"}', request_kind="raw")
    response = service._execute_request(request)

    assert response.text == "ok"
    assert response.model == backup_model
    assert client.models_seen == [primary_model, backup_model]


@pytest.mark.parametrize(
    ("provider", "primary_model", "backup_model"),
    [
        (AI_GEMINI, "gemini-2.5-flash", "gemma-3-27b-it"),
        (AI_GROQ, "llama-3.1-8b-instant", "qwen/qwen3-32b"),
        (AI_OPENAI, "gpt-4o-mini", "gpt-4.1-mini"),
        (AI_OLLAMA, "llama3", "qwen2.5"),
        (AI_LM_STUDIO, "mistral-small", "qwen2.5"),
    ],
)
def test_execute_request_raises_primary_error_when_backup_also_fails(provider: str, primary_model: str, backup_model: str):
    client = _AlwaysFailClient(primary_model=primary_model, backup_model=backup_model)
    ai_config = _build_ai_config(provider, primary_model, backup_model)
    service = _build_service(ai_config, client)

    request = service._make_request(prompt='{"output":"hello"}', request_kind="raw")
    with pytest.raises(AIError, match="Primary failed"):
        service._execute_request(request)

    assert client.models_seen == [primary_model, backup_model]
