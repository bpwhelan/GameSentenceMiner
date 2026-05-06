from __future__ import annotations

from types import SimpleNamespace

from GameSentenceMiner.ai.contracts import AIRequest
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
