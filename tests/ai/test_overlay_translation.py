import json
from types import SimpleNamespace

import pytest

from GameSentenceMiner.ai import overlay_translation as translation

BLOCKS = [{"id": "0", "text": "こんにちは"}, {"id": "1", "text": "終了"}]


def test_batch_translates_all_blocks_in_one_call_without_mutating_dialogue(monkeypatch):
    calls = []

    class Service:
        def __init__(self, **kwargs):
            pass

        def generate_raw_prompt(self, prompt, request_kind):
            calls.append((prompt, request_kind))
            return '```json\n{"blocks":[{"id":"1","translation":"Quit"},{"id":"0","translation":"Hello"}]}\n```'

    config = SimpleNamespace(
        ai=SimpleNamespace(dialogue_context_length=2, use_canned_translation_prompt=True),
        general=SimpleNamespace(get_native_language_name=lambda: "English"),
    )
    monkeypatch.setattr(translation, "get_config", lambda: config)
    monkeypatch.setattr(translation, "_get_ai_service_components", lambda: (Service, lambda *args: None))
    line = SimpleNamespace(text="Earlier dialogue", translation="existing")
    result = translation.translate_overlay_blocks([line], BLOCKS, "Test Game")
    assert result == [{"id": "0", "translation": "Hello"}, {"id": "1", "translation": "Quit"}]
    assert len(calls) == 1
    assert calls[0][1] == "overlay_translation"
    assert "English" in calls[0][0] and "Earlier dialogue" in calls[0][0]
    assert json.dumps({"blocks": BLOCKS}, ensure_ascii=False) in calls[0][0]
    assert line.translation == "existing"


@pytest.mark.parametrize(
    "response",
    [
        "plain translation",
        '{"blocks": [{"id": "0", "translation": "Hello"}]}',
        '{"blocks": [{"id": "0", "translation": "Hello"}, {"id": "0", "translation": "Quit"}]}',
        '{"blocks": [{"id": "0", "translation": "Hello"}, {"id": "other", "translation": "Quit"}]}',
        '{"blocks": [{"id": "0", "translation": "Hello"}, {"id": "1", "translation": ""}]}',
    ],
)
def test_rejects_unmappable_or_incomplete_output(response):
    with pytest.raises(ValueError):
        translation.parse_block_translations(response, BLOCKS)


@pytest.mark.parametrize("blocks", [[], [{"id": "0", "text": ""}], BLOCKS + [BLOCKS[0]], [{"id": 0, "text": "hi"}]])
def test_rejects_invalid_input_blocks(blocks):
    with pytest.raises(ValueError):
        translation.validate_blocks(blocks)
