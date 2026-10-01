from __future__ import annotations

import json
import logging
from dataclasses import replace
from types import SimpleNamespace

import httpx
import pytest
from google import genai
from google.genai import types

from GameSentenceMiner.ai.contracts import AIError, AIRequest
from GameSentenceMiner.ai.providers.gemini_client import GeminiClient


def _make_request(*, request_kind: str, max_tokens: int = 4096) -> AIRequest:
    return AIRequest(
        provider="Gemini",
        model="gemma-4-31b-it",
        prompt="prompt",
        temperature=0.3,
        top_p=0.9,
        max_tokens=max_tokens,
        request_kind=request_kind,
    )


def _make_client() -> GeminiClient:
    client = object.__new__(GeminiClient)
    client._safety_settings = []
    return client


def test_build_generation_config_clamps_translation_tokens_and_uses_plain_text():
    request = _make_request(request_kind="translation", max_tokens=4096)

    config = _make_client()._build_generation_config(request, "gemma-4-31b-it")

    assert config.max_output_tokens == 128
    assert config.response_mime_type == "text/plain"
    assert config.thinking_config is not None
    assert config.thinking_config.include_thoughts is False
    assert str(config.thinking_config.thinking_level) == "ThinkingLevel.MINIMAL"


def test_build_generation_config_preserves_lower_user_limit():
    request = _make_request(request_kind="translation", max_tokens=64)

    config = _make_client()._build_generation_config(request, "gemma-4-31b-it")

    assert config.max_output_tokens == 64


def test_build_generation_config_uses_budget_fallback_for_gemini_flash():
    request = _make_request(request_kind="translation", max_tokens=4096)

    config = _make_client()._build_generation_config(request, "gemini-2.5-flash")

    assert config.thinking_config is not None
    assert config.thinking_config.include_thoughts is False
    assert config.thinking_config.thinking_budget == 0


@pytest.mark.parametrize(
    ("model", "level"),
    [
        ("gemini-3-flash-preview", types.ThinkingLevel.MINIMAL),
        ("gemini-3.1-flash-lite-preview", types.ThinkingLevel.MINIMAL),
        ("gemini-3.5-flash-lite", types.ThinkingLevel.MINIMAL),
        ("gemini-3.5-flash", types.ThinkingLevel.MINIMAL),
        ("gemini-3.6-flash", types.ThinkingLevel.MINIMAL),
        ("gemini-3.7-flash", types.ThinkingLevel.LOW),
        ("gemini-3.8-flash", types.ThinkingLevel.LOW),
        ("gemini-3-pro-preview", types.ThinkingLevel.LOW),
        ("gemini-3.1-pro-preview", types.ThinkingLevel.LOW),
    ],
)
def test_gemini_3_uses_supported_thinking_levels_instead_of_legacy_budgets(model, level):
    config = _make_client()._build_generation_config(_make_request(request_kind="translation"), model)

    assert config.thinking_config is not None
    assert config.thinking_config.thinking_level == level
    assert config.thinking_config.thinking_budget is None
    assert config.thinking_config.include_thoughts is False


def test_gemini_3_omits_thinking_config_when_sdk_does_not_support_levels(monkeypatch):
    monkeypatch.setattr(
        types.ThinkingConfig,
        "model_fields",
        {name: field for name, field in types.ThinkingConfig.model_fields.items() if name != "thinking_level"},
    )

    config = _make_client()._build_generation_config(_make_request(request_kind="translation"), "gemini-3.5-flash-lite")

    assert config.thinking_config is None


def test_gemini_25_pro_keeps_dynamic_thinking_budget():
    config = _make_client()._build_generation_config(_make_request(request_kind="raw"), "gemini-2.5-pro")

    assert config.max_output_tokens == 4096
    assert config.thinking_config.thinking_budget == -1
    assert config.thinking_config.thinking_level is None


@pytest.mark.parametrize("model", ["gemma-3-27b-it", "unknown-model"])
def test_other_models_do_not_receive_thinking_options(model):
    config = _make_client()._build_generation_config(_make_request(request_kind="translation"), model)

    assert config.thinking_config is None


@pytest.mark.parametrize(
    ("statuses", "expected_calls", "succeeds"),
    [
        ([500, 200], 2, True),
        ([503, 200], 2, True),
        ([500, 500], 2, False),
        ([400, 200], 1, False),
        ([429, 200], 1, False),
    ],
)
def test_generate_retries_temporary_server_errors_but_leaves_invalid_requests_and_quota_to_fallback(
    monkeypatch, statuses, expected_calls, succeeds
):
    requests = []

    def handle_request(request):
        requests.append(request)
        status = statuses[len(requests) - 1]
        if status == 200:
            return httpx.Response(
                200,
                json={"candidates": [{"content": {"parts": [{"text": "Hello."}]}, "finishReason": "STOP"}]},
            )
        return httpx.Response(status, json={"error": {"code": status, "message": "Test API failure"}})

    sdk_client_factory = genai.Client

    def make_client(**kwargs):
        http_options = kwargs.setdefault("http_options", types.HttpOptions())
        http_options.client_args = {"transport": httpx.MockTransport(handle_request)}
        return sdk_client_factory(**kwargs)

    monkeypatch.setattr(genai, "Client", make_client)
    client = GeminiClient("test-key", "gemini-3.5-flash-lite", logging.getLogger(__name__))
    request = replace(_make_request(request_kind="translation"), model="models/gemini-3.5-flash-lite")
    try:
        if succeeds:
            response = client.generate(request)
            assert response.text == "Hello."
            assert response.model == "gemini-3.5-flash-lite"
        else:
            with pytest.raises(AIError, match="Test API failure"):
                client.generate(request)
    finally:
        client.client.close()

    assert len(requests) == expected_calls
    for sent_request in requests:
        payload = json.loads(sent_request.content)
        assert sent_request.url.path.endswith("/models/gemini-3.5-flash-lite:generateContent")
        assert payload["contents"][0]["parts"] == [{"text": "prompt"}]
        assert payload["generationConfig"]["maxOutputTokens"] == 128
        thinking = types.ThinkingConfig.model_validate(payload["generationConfig"]["thinkingConfig"])
        assert thinking.thinking_level == types.ThinkingLevel.MINIMAL
        assert thinking.thinking_budget is None
        assert thinking.include_thoughts is False


def test_extract_response_text_prefers_sdk_text_field():
    response = SimpleNamespace(
        text="Are you a third-year?",
        candidates=[
            SimpleNamespace(
                content=SimpleNamespace(
                    parts=[
                        SimpleNamespace(text="internal thoughts", thought=True),
                        SimpleNamespace(text="wrong fallback", thought=False),
                    ]
                )
            )
        ],
    )

    assert GeminiClient._extract_response_text(response) == "Are you a third-year?"


def test_extract_response_text_filters_thought_parts_when_text_field_missing():
    response = SimpleNamespace(
        text=None,
        candidates=[
            SimpleNamespace(
                content=SimpleNamespace(
                    parts=[
                        SimpleNamespace(text="analysis", thought=True),
                        SimpleNamespace(text="A third-year?", thought=False),
                    ]
                )
            )
        ],
    )

    assert GeminiClient._extract_response_text(response) == "A third-year?"
