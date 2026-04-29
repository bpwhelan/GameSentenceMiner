from datetime import datetime, timedelta
from types import SimpleNamespace

from GameSentenceMiner.util import text_log


def test_normalize_text_for_comparison_removes_punctuation_and_whitespace():
    assert text_log.normalize_text_for_comparison(" 「Hello、　World!」 \n") == "HelloWorld"


def test_is_line_recycled_uses_normalized_text(monkeypatch):
    monkeypatch.setattr(text_log.game_log, "previous_lines", {"HelloWorld"})

    assert text_log.is_line_recycled("Hello, World!")
    assert not text_log.is_line_recycled("Goodbye")


def test_lines_match_rejects_punctuation_only_line_against_sentence():
    assert not text_log.lines_match("‥‥‥‥。", "‥‥ま、旅は道連れ、世は情け。一緒に行くか。")


def test_lines_match_allows_exact_punctuation_only_match():
    assert text_log.lines_match("‥‥‥‥。", "‥‥‥‥。")


def test_get_matching_line_does_not_let_punctuation_only_line_shadow_target(monkeypatch):
    monkeypatch.setattr(
        text_log,
        "get_config",
        lambda: SimpleNamespace(anki=SimpleNamespace(sentence_field="Sentence")),
    )
    monkeypatch.setattr(text_log.gsm_state, "replay_buffer_length", 300, raising=False)

    now = datetime.now()
    target = text_log.GameLine(
        id="target",
        text="‥‥ま、旅は道連れ、世は情け。一緒に行くか。",
        time=now - timedelta(seconds=5),
        prev=None,
        next=None,
    )
    punctuation = text_log.GameLine(
        id="punctuation",
        text="‥‥‥‥。",
        time=now - timedelta(seconds=1),
        prev=target,
        next=None,
    )
    target.next = punctuation

    card = SimpleNamespace(get_field=lambda _field: "‥‥ま、旅は<b>道連れ</b>、世は情け。一緒に行くか。")

    assert text_log.get_matching_line(card, [target, punctuation]) is target
