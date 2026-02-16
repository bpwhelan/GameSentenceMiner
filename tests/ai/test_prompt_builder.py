from __future__ import annotations

from GameSentenceMiner.ai.prompts.builder import FullPromptRenderer


def test_full_prompt_places_prompt_before_dialogue_context():
    rendered = FullPromptRenderer.render(
        game_title="Test Game",
        character_context="Character A is calm.",
        dialogue_context="Line 1\nLine 2",
        prompt_to_use="PROMPT_TO_USE_MARKER",
        sentence="SENTENCE_MARKER",
    )

    prompt_index = rendered.index("PROMPT_TO_USE_MARKER")
    sentence_index = rendered.index("SENTENCE_MARKER")
    context_start_index = rendered.index("Line 1")

    assert prompt_index < sentence_index < context_start_index


def test_full_prompt_keeps_sentence_adjacent_to_prompt_block():
    rendered = FullPromptRenderer.render(
        game_title="Test Game",
        character_context="Character A is calm.",
        dialogue_context="Line 1\nLine 2",
        prompt_to_use="PROMPT_TO_USE_MARKER",
        sentence="SENTENCE_MARKER",
    )

    prompt_end = rendered.index("PROMPT_TO_USE_MARKER") + len("PROMPT_TO_USE_MARKER")
    sentence_start = rendered.index("SENTENCE_MARKER")
    gap = rendered[prompt_end:sentence_start]

    assert "Dialogue context:" not in gap
