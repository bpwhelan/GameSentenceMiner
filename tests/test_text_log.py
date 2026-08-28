from datetime import datetime, timedelta
from types import SimpleNamespace

from GameSentenceMiner.util import text_log


def test_normalize_text_for_comparison_removes_punctuation_and_whitespace():
    assert text_log.normalize_text_for_comparison(" 「Hello、　World!」 \n") == "HelloWorld"


def test_is_line_recycled_uses_normalized_text(monkeypatch):
    monkeypatch.setattr(text_log.game_log, "previous_lines", {"HelloWorld"})

    assert text_log.is_line_recycled("Hello, World!")
    assert not text_log.is_line_recycled("Goodbye")


def test_game_text_prunes_oldest_lines_and_unlinks_history(monkeypatch):
    monkeypatch.setattr(text_log, "is_recycled_line_detection_enabled", lambda: False)
    game_text = text_log.GameText(max_lines=3)

    lines = [game_text.add_line(f"line {index}") for index in range(4)]

    assert [line.text for line in game_text.snapshot()] == ["line 1", "line 2", "line 3"]
    assert game_text.get_by_id(lines[0].id) is None
    assert lines[1].prev is None
    assert lines[0].next is None
    assert game_text.game_line_index == 4


def test_previous_line_cache_is_bounded(monkeypatch):
    monkeypatch.setattr(text_log, "MAX_PREVIOUS_LINES", 2)
    game_text = text_log.GameText()

    game_text.replace_previous_lines(["one", "two", "three"])

    assert game_text.previous_lines == {"two", "three"}


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


def test_get_matching_line_prefers_candidate_containing_expression(monkeypatch):
    monkeypatch.setattr(
        text_log,
        "get_config",
        lambda: SimpleNamespace(anki=SimpleNamespace(sentence_field="Sentence", word_field="Expression")),
    )
    monkeypatch.setattr(text_log.gsm_state, "replay_buffer_length", 300, raising=False)

    now = datetime.now()
    earlier_long_line = text_log.GameLine(
        id="earlier",
        text="これは先に表示された、とても長い台詞の部分です。",
        time=now - timedelta(seconds=2),
        prev=None,
        next=None,
    )
    mined_line = text_log.GameLine(
        id="mined",
        text="最後の対象語を含む行です。",
        time=now - timedelta(seconds=1),
        prev=earlier_long_line,
        next=None,
    )
    earlier_long_line.next = mined_line
    fields = {
        "Sentence": f"{earlier_long_line.text}\n{mined_line.text}",
        "Expression": "対象語",
    }
    card = SimpleNamespace(get_field=lambda field: fields[field])

    assert text_log.get_matching_line(card, [earlier_long_line, mined_line]) is mined_line


def test_get_matching_line_can_prefer_latest_valid_partial_match(monkeypatch):
    monkeypatch.setattr(
        text_log,
        "get_config",
        lambda: SimpleNamespace(anki=SimpleNamespace(sentence_field="Sentence", word_field="Expression")),
    )
    monkeypatch.setattr(text_log.gsm_state, "replay_buffer_length", 300, raising=False)

    now = datetime.now()
    earlier_long_line = text_log.GameLine(
        id="earlier",
        text="これは先に表示された、とても長い台詞の部分です。",
        time=now - timedelta(seconds=3),
        prev=None,
        next=None,
    )
    latest_matching_line = text_log.GameLine(
        id="latest-match",
        text="最後に表示された短い台詞です。",
        time=now - timedelta(seconds=2),
        prev=earlier_long_line,
        next=None,
    )
    unrelated_line = text_log.GameLine(
        id="unrelated",
        text="まったく関係のない別の文章です。",
        time=now - timedelta(seconds=1),
        prev=latest_matching_line,
        next=None,
    )
    earlier_long_line.next = latest_matching_line
    latest_matching_line.next = unrelated_line
    fields = {
        "Sentence": f"{earlier_long_line.text}\n{latest_matching_line.text}",
        # Simulate a dictionary-form expression which is not a literal substring.
        "Expression": "見つからない辞書形",
    }
    card = SimpleNamespace(get_field=lambda field: fields[field])

    assert (
        text_log.get_matching_line(
            card,
            [earlier_long_line, latest_matching_line, unrelated_line],
            prefer_recent=True,
        )
        is latest_matching_line
    )


def test_overlay_recency_beats_expression_and_longer_match_for_nvl_ranking(monkeypatch):
    monkeypatch.setattr(
        text_log,
        "get_config",
        lambda: SimpleNamespace(anki=SimpleNamespace(sentence_field="Sentence", word_field="Expression")),
    )
    monkeypatch.setattr(text_log.gsm_state, "replay_buffer_length", 300, raising=False)

    now = datetime.now()
    clicked_earlier_line = text_log.GameLine(
        id="clicked",
        text="対象語がある、先に表示されたとても長い一つ目の台詞です。",
        time=now - timedelta(seconds=2),
        prev=None,
        next=None,
    )
    newer_line = text_log.GameLine(
        id="newer",
        text="その後に表示された別の台詞です。",
        time=now - timedelta(seconds=1),
        prev=clicked_earlier_line,
        next=None,
    )
    clicked_earlier_line.next = newer_line
    fields = {
        "Sentence": f"{clicked_earlier_line.text}\n{newer_line.text}",
        "Expression": "対象語",
    }
    card = SimpleNamespace(get_field=lambda field: fields[field])

    assert (
        text_log.get_matching_line(
            card,
            [clicked_earlier_line, newer_line],
            prefer_recent=True,
        )
        is newer_line
    )
