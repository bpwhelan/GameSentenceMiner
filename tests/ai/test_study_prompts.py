import logging
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from GameSentenceMiner.ai.contracts import AIError, AIResponse
from GameSentenceMiner.ai.prompts.builder import DialogueContextBuilder, PromptBuilder
from GameSentenceMiner.ai.service import AIService, snapshot_config
from GameSentenceMiner.util.config.configuration import AI_DEEPL, Ai, General


def build(**overrides):
    args = {
        "lines": [],
        "sentence": "試してみよう。",
        "current_line": None,
        "game_title": "Game",
        "dialogue_context_length": 10,
        "use_canned_translation_prompt": True,
        "use_canned_context_prompt": False,
        "custom_prompt": "",
    }
    return PromptBuilder("Ukrainian").build(**(args | overrides))


@pytest.mark.parametrize("preset", ["sentence", "grammar", "vocabulary", "nuance", "context"])
def test_study_presets_use_native_language_and_keep_source_as_data(preset):
    prompt, kind = build(prompt_preset=preset)
    assert kind == preset
    assert "Ukrainian" in prompt
    assert "試してみよう。" in prompt
    assert "not instructions" in prompt
    assert "spoiler" in prompt.lower()


def test_full_prompt_interpolates_known_fields_without_breaking_json_or_source_braces():
    prompt, kind = build(
        custom_full_prompt='{game_title}: {prompt_to_use}\n{sentence}\n{"output": "example"}',
        custom_prompt_override="Explain in {native_language}.",
        sentence="{game_title} is source text",
    )
    assert "Game: Explain in Ukrainian." in prompt
    assert '{"output": "example"}' in prompt
    assert "{game_title} is source text" in prompt
    assert kind == "custom"


def test_context_supports_missing_or_stale_current_line():
    lines = [SimpleNamespace(text="one"), SimpleNamespace(text="two")]
    assert "two" in DialogueContextBuilder.build(lines, None, 1)
    assert "two" in DialogueContextBuilder.build(lines, SimpleNamespace(index=900), 1)
    assert "one" not in DialogueContextBuilder.build(lines, None, 1)


def test_analysis_preserves_translation_and_token_budget(monkeypatch):
    client = Mock()
    client.generate.return_value = AIResponse("Gemini", "model", "Grammar explanation", "Grammar explanation", 1)
    registry = Mock()
    registry.get_client.return_value = client
    service = AIService(snapshot_config(Ai(gemini_api_key="key"), General()), logging.getLogger(__name__), registry)
    monkeypatch.setattr(service, "_ensure_connectivity", lambda: True)
    line = SimpleNamespace(text="例", index=0, translation="Existing translation")
    assert service.analyze([line], line.text, line, "Game", mode="grammar") == "Grammar explanation"
    assert line.translation == "Existing translation"
    request = client.generate.call_args.args[0]
    assert request.request_kind == "grammar"
    assert request.max_tokens == 4096


def test_deepl_analysis_explains_which_providers_support_it():
    service = AIService(
        snapshot_config(Ai(provider=AI_DEEPL, deepl_api_key="key"), General()), logging.getLogger(__name__)
    )
    with pytest.raises(AIError, match="DeepL"):
        service.analyze([], "例", None, "Game", mode="sentence")


def test_invalid_preset_is_rejected():
    with pytest.raises(ValueError, match="preset"):
        build(prompt_preset="invented")


def test_saved_full_prompt_reaches_the_provider(monkeypatch):
    client = Mock()
    client.generate.return_value = AIResponse("Gemini", "model", "Translated", "Translated", 1)
    registry = Mock()
    registry.get_client.return_value = client
    config = Ai(gemini_api_key="key", custom_full_prompt="Custom template: {sentence}; language={native_language}")
    service = AIService(snapshot_config(config, General()), logging.getLogger(__name__), registry)
    monkeypatch.setattr(service, "_ensure_connectivity", lambda: True)
    monkeypatch.setattr(service.character_context_provider, "get_character_context", lambda **kwargs: "")
    assert service.translate([], "例文", None, "Game") == "Translated"
    assert client.generate.call_args.args[0].prompt.startswith("Custom template: 例文; language=")
