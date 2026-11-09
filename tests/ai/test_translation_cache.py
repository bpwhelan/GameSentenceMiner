from __future__ import annotations

import logging
import threading
import uuid
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import replace
from datetime import UTC, datetime
from unittest.mock import Mock

import pytest

from GameSentenceMiner.ai.contracts import AIError, AIResponse
from GameSentenceMiner.ai.service import AIService, snapshot_config
from GameSentenceMiner.util.config.configuration import AI_DEEPL, Ai, General
from GameSentenceMiner.util.text_log import GameLine


@pytest.fixture
def line():
    return GameLine(id=str(uuid.uuid4()), text="試してみよう。", time=datetime.now(UTC), prev=None, next=None)


@pytest.fixture
def services(monkeypatch):
    client = Mock()
    client.generate.return_value = AIResponse("Gemini", "model", "Let's try it.", "Let's try it.", 1)
    registry = Mock()
    registry.get_client.return_value = client

    def make(ai=None, language="en"):
        service = AIService(
            snapshot_config(ai or Ai(gemini_api_key="key", gemini_backup_model=""), General(native_language=language)),
            logging.getLogger(__name__),
            registry,
        )
        monkeypatch.setattr(service, "_ensure_connectivity", Mock(return_value=True))
        monkeypatch.setattr(service.character_context_provider, "get_character_context", Mock(return_value=""))
        return service

    return make, client


def test_translation_is_reused_across_services_and_copies_of_the_same_line(services, line):
    make, client = services
    assert make().translate([line], line.text, line, "Game") == "Let's try it."
    later = make()
    clone = replace(line, translation="", TL="")
    assert later.translate([clone], clone.text, clone, "Game") == "Let's try it."
    client.generate.assert_called_once()
    later._ensure_connectivity.assert_not_called()
    later.character_context_provider.get_character_context.assert_not_called()
    assert clone.translation == clone.TL == "Let's try it."


def test_textfeed_prompt_and_anki_share_the_same_line_translation(services, line):
    make, client = services
    assert (
        make().translate(
            [line], line.text, line, "Game", custom_prompt="Translate this line only.", translation_only=True
        )
        == "Let's try it."
    )
    assert make().translate([line], "<b>試して</b>みよう。\n", line, "Game") == "Let's try it."
    client.generate.assert_called_once()


def test_overlapping_translation_requests_share_one_provider_call(services, line):
    make, client = services
    started, release = threading.Event(), threading.Event()
    rendezvous = threading.Barrier(5)

    def generate(_request):
        started.set()
        assert release.wait(3)
        return AIResponse("Gemini", "model", "Shared result", "Shared result", 1)

    client.generate.side_effect = generate

    def translate():
        service = make()
        rendezvous.wait(timeout=3)
        return service.translate([line], line.text, line, "Game")

    with ThreadPoolExecutor(max_workers=4) as executor:
        requests = [executor.submit(translate) for _ in range(4)]
        rendezvous.wait(timeout=3)
        try:
            assert started.wait(3)
        finally:
            release.set()
        assert [request.result(timeout=3) for request in requests] == ["Shared result"] * 4
    client.generate.assert_called_once()


def test_line_revision_and_growing_context_do_not_retranslate_unchanged_text(services, line):
    make, client = services
    make().translate([line], line.text, line, "Game")
    line.revision += 1
    later_line = replace(line, id=str(uuid.uuid4()), text="次の台詞。")
    make().translate([line, later_line], line.text + "\n", line, "Game")
    client.generate.assert_called_once()


def test_changed_text_language_and_different_lines_get_their_own_translations(services, line):
    make, client = services
    make().translate([line], line.text, line, "Game")
    make().translate([line], line.text, line, "Game")
    line.text = "別の台詞。"
    make().translate([line], line.text, line, "Game")
    make(language="ja").translate([line], line.text, line, "Game")
    other = replace(line, id=str(uuid.uuid4()))
    make().translate([other], other.text, other, "Game")
    assert client.generate.call_count == 4


def test_explicit_refresh_replaces_the_reused_translation(services, line):
    make, client = services
    make().translate([line], line.text, line, "Game")
    client.generate.return_value = AIResponse("Gemini", "model", "Refreshed", "Refreshed", 1)
    assert make().translate([line], line.text, line, "Game", force_refresh=True) == "Refreshed"
    assert make().translate([line], line.text, line, "Game") == "Refreshed"
    assert client.generate.call_count == 2
    assert line.translation == line.TL == "Refreshed"


@pytest.mark.parametrize("failure", ["", "Processing failed: Rate limit", AIError("Rate limit")])
def test_failed_and_empty_results_are_retried_instead_of_cached(services, line, failure):
    make, client = services
    service = make()
    result = client.generate.return_value
    client.generate.side_effect = [
        failure if isinstance(failure, Exception) else AIResponse("Gemini", "model", failure, failure, 1),
        result,
    ]
    service.translate([line], line.text, line, "Game")
    assert line.translation == line.TL == ""
    assert make().translate([line], line.text, line, "Game") == "Let's try it."
    assert client.generate.call_count == 2


def test_batch_and_text_override_do_not_replace_the_lines_own_translation(services, line):
    make, client = services
    make().translate([line], line.text, line, "Game")
    client.generate.return_value = AIResponse("Gemini", "model", "Different output", "Different output", 1)
    service = make()
    assert service.translate([line], line.text + "\n次の台詞。", line, "Game") == "Different output"
    assert service.translate([line], "Edited text", line, "Game") == "Different output"
    assert line.translation == line.TL == "Let's try it."
    assert make().translate([line], line.text, line, "Game") == "Let's try it."
    assert client.generate.call_count == 3


def test_configured_explanations_have_a_separate_cache_from_translation(services, line):
    make, client = services
    make().translate([line], line.text, line, "Game")
    client.generate.return_value = AIResponse("Gemini", "model", "Grammar", "Grammar", 1)
    explaining = make(Ai(gemini_api_key="key", prompt_preset="grammar"))
    assert explaining.translate([line], line.text, line, "Game") == "Grammar"
    assert explaining.translate([line], line.text, line, "Game") == "Grammar"
    assert line.translation == line.TL == "Let's try it."
    assert client.generate.call_count == 2


def test_late_result_for_an_older_source_does_not_overwrite_the_line(services, line):
    make, client = services

    def generate(_request):
        line.text = "新しい台詞。"
        line.translation = line.TL = "New translation"
        return AIResponse("Gemini", "model", "Old translation", "Old translation", 1)

    client.generate.side_effect = generate
    assert make().translate([line], line.text, line, "Game") == "Old translation"
    assert line.translation == line.TL == "New translation"


def test_deepl_uses_the_same_cache_and_sends_only_source_text(services, line):
    make, client = services
    ai = Ai(provider=AI_DEEPL, deepl_api_key="key", deepl_target_lang="EN")
    assert make(ai).translate([line], line.text, line, "Game") == "Let's try it."
    assert make(ai).translate([line], line.text, line, "Game") == "Let's try it."
    client.generate.assert_called_once()
    assert client.generate.call_args.args[0].prompt == line.text


def test_cache_evicts_old_entries_without_retaining_failures():
    from GameSentenceMiner.ai.translation_cache import TranslationCache

    cache = TranslationCache(max_entries=2)
    generate = Mock(return_value="Translation")
    for key in ("one", "two", "three", "three", "one"):
        assert cache.get_or_translate(key, generate) == "Translation"
    assert generate.call_count == 4


def test_unexpected_failures_release_waiters_and_allow_retry(monkeypatch):
    from GameSentenceMiner.ai import translation_cache

    started, waiting, release = threading.Event(), threading.Event(), threading.Event()

    class WaitingFuture(Future):
        def result(self, timeout=None):
            waiting.set()
            return super().result(timeout)

    monkeypatch.setattr(translation_cache, "Future", WaitingFuture)
    cache = translation_cache.TranslationCache()

    def generate():
        started.set()
        assert release.wait(3)
        raise RuntimeError("failed")

    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(cache.get_or_translate, "line", generate)
        assert started.wait(3)
        second = executor.submit(cache.get_or_translate, "line", generate)
        try:
            assert waiting.wait(3)
        finally:
            release.set()
        for result in (first, second):
            with pytest.raises(RuntimeError, match="failed"):
                result.result(timeout=3)
    assert cache.get_or_translate("line", lambda: "Recovered") == "Recovered"


@pytest.mark.parametrize("source", ["<b>試して</b>みよう。", "{{c1::試して::hint}}みよう。", " 試してみよう。\n"])
def test_source_markup_and_trailing_newlines_share_the_translation(services, line, source):
    make, client = services
    assert make().translate([line], source, line, "Game") == "Let's try it."
    assert make().translate([line], line.text, line, "Game") == "Let's try it."
    client.generate.assert_called_once()
