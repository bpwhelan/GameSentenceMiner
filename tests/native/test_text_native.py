from __future__ import annotations

from difflib import SequenceMatcher
from itertools import product
from types import SimpleNamespace

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from GameSentenceMiner.native import ocr
from GameSentenceMiner.ocr import compare
from GameSentenceMiner.util import text_processing
from GameSentenceMiner.util.text_utils import is_kanji

TEXT = st.text(alphabet="abc日本文字漢かなＡ！\n\x00𠀀😀\u0301", max_size=100)


def expected_metrics(a, b, minimum):
    blocks = SequenceMatcher(None, a, b, autojunk=False).get_matching_blocks()
    return (
        sum(block.size for block in blocks if block.size >= minimum) / len(b) if b else 0.0,
        max(block.size for block in blocks),
    )


def test_extension_exports_text_operations():
    for name in (
        "matching_block_stats",
        "sequence_ratio",
        "remove_repeated_chars",
        "remove_repeated_lines",
        "count_kanji",
    ):
        assert callable(getattr(ocr._extension, name, None)), name


@given(a=TEXT, b=TEXT, minimum=st.integers(1, 12))
@settings(max_examples=250, deadline=None)
def test_matching_matches_difflib(a, b, minimum):
    assert ocr._extension.matching_block_stats(a, b, minimum) == expected_metrics(a, b, minimum)
    assert ocr._extension.sequence_ratio(a, b) == SequenceMatcher(None, a, b, autojunk=False).ratio()


@pytest.mark.parametrize(
    "a,b",
    [
        ("", ""),
        ("日", ""),
        ("", "本"),
        ("tide", "diet"),
        ("diet", "tide"),
        ("ab", "acab"),
        ("abxcd", "abcd"),
        ("ab" * 180, "ba" * 180),
        ("日" * 300 + "本", "日" * 300 + "語"),
        ("𠀀😀\x00e\u0301", "😀𠀀\x00é"),
        ("a" * 5000, "ab"),
    ],
)
def test_matching_ties_popular_characters_and_unicode(a, b):
    for minimum in (1, 2, 4, 1000):
        assert ocr._extension.matching_block_stats(a, b, minimum) == expected_metrics(a, b, minimum)
    assert ocr._extension.sequence_ratio(a, b) == SequenceMatcher(None, a, b, autojunk=False).ratio()


def test_matching_exhaustive_short_repeated_alphabet():
    strings = ["".join(chars) for length in range(6) for chars in product("ab", repeat=length)]
    for a, b in product(strings, repeat=2):
        assert ocr._extension.matching_block_stats(a, b, 2) == expected_metrics(a, b, 2)
        assert ocr._extension.sequence_ratio(a, b) == SequenceMatcher(None, a, b, autojunk=False).ratio()


@given(text=TEXT, count=st.integers(-2, 15), keep=st.booleans())
@settings(max_examples=200, deadline=None)
def test_repeated_text_matches_python(text, count, keep):
    from GameSentenceMiner.native import text as native_text

    assert ocr._extension.remove_repeated_chars(text, count, keep) == native_text._remove_repeated_chars_python(
        text, count, keep
    )
    assert ocr._extension.remove_repeated_lines(text, count) == native_text._remove_repeated_lines_python(text, count)


@given(unit=TEXT, count=st.integers(1, 12))
@settings(max_examples=100, deadline=None)
def test_repetition_autodetection_matches_python(unit, count):
    from GameSentenceMiner.native import text as native_text

    repeated_line = unit * count
    repeated_chars = "".join(char * count for char in unit)
    assert ocr._extension.remove_repeated_lines(repeated_line, 1) == native_text._remove_repeated_lines_python(
        repeated_line, 1
    )
    assert ocr._extension.remove_repeated_chars(repeated_chars, 1, True) == native_text._remove_repeated_chars_python(
        repeated_chars, 1, True
    )


@pytest.mark.parametrize(
    "text,count,keep,expected",
    [
        ("AABB", 1, True, "AABB"),
        ("AA", 1, True, "AA"),
        ("ええ……。", 1, True, "ええ……。"),
        ("いい", 1, True, "いい"),
        ("AABB", 1, False, "AABB"),
        ("AAABBB", 1, True, "AB"),
        ("AAAABBBBCCCC", 1, True, "ABC"),
        ("AAABBB", 1, False, "AB"),
        ("AABB", 2, True, "AB"),
        ("AABB", 2, False, "AB"),
        ("AAB", 1, True, "AAB"),
        ("AAABBB", 2, True, "AABB"),
        ("AAAAA", 3, True, "AAA"),
        ("AA", 3, True, "AA"),
        ("AAABBB!", 3, False, "AB"),
        ("日日本本𠀀𠀀", 2, True, "日本𠀀"),
        ("abc", 100, False, ""),
        ("abc", 100, True, "abc"),
    ],
)
def test_repeated_character_contract(text, count, keep, expected):
    from GameSentenceMiner.native import text as native_text

    assert ocr._extension.remove_repeated_chars(text, count, keep) == expected
    assert native_text._remove_repeated_chars_python(text, count, keep) == expected


@given(texts=st.lists(st.text(max_size=100), max_size=20))
@settings(max_examples=150, deadline=None)
def test_kanji_counts_and_first_seen_order_match_python(texts):
    expected = {}
    for text in texts:
        for char in text:
            if is_kanji(char):
                expected[char] = expected.get(char, 0) + 1
    assert list(ocr._extension.count_kanji(texts).items()) == list(expected.items())


def test_kanji_range_boundaries():
    points = (0x33FF, 0x3400, 0x4DBF, 0x4DC0, 0x4DFF, 0x4E00, 0x9FFF, 0xA000, 0x1FFFF, 0x20000, 0x2A6DF, 0x2A6E0)
    text = "".join(map(chr, points))
    expected = {char: 2 for char in text if is_kanji(char)}
    assert list(ocr._extension.count_kanji([text, text]).items()) == list(expected.items())


@pytest.mark.parametrize("mode", ["native", "python", "shadow"])
def test_facade_modes_preserve_behavior(monkeypatch, mode):
    from GameSentenceMiner.native import text as native_text

    monkeypatch.setenv("GSM_NATIVE_TEXT_MODE", mode)
    assert native_text.sequence_ratio("tide", "diet") == 0.25
    assert native_text.matching_block_stats("abcde", "axcye", 2) == (0.0, 1)
    assert text_processing.remove_repeated_chars("日日文文") == "日日文文"
    assert text_processing.remove_repeated_chars("日日日文文文") == "日文"
    assert text_processing.remove_repeated_lines("日本日本") == "日本"
    assert list(native_text.count_kanji(["日文日", "本"]).items()) == [("日", 2), ("文", 1), ("本", 1)]


@pytest.mark.parametrize("extension", [None, SimpleNamespace()])
def test_missing_or_older_extension_falls_back(monkeypatch, extension):
    from GameSentenceMiner.native import text as native_text

    monkeypatch.setenv("GSM_NATIVE_TEXT_MODE", "native")
    monkeypatch.setattr(ocr, "_extension", extension)
    assert native_text.sequence_ratio("abc", "ac") == 0.8
    assert native_text.matching_block_stats("abc", "ac", 1) == (1.0, 1)
    assert native_text.remove_repeated_chars("aa") == "aa"
    assert native_text.remove_repeated_chars("aaa") == "a"
    assert native_text.remove_repeated_lines("abab") == "ab"
    assert native_text.count_kanji(["日日"]) == {"日": 2}


def test_native_failures_and_surrogates_use_python(monkeypatch):
    from GameSentenceMiner.native import text as native_text

    monkeypatch.setenv("GSM_NATIVE_TEXT_MODE", "native")
    assert native_text.sequence_ratio("日\ud800", "日") == 2 / 3
    assert native_text.matching_block_stats("日\ud800", "日", 1) == (1.0, 1)
    assert native_text.remove_repeated_chars("\ud800\ud800") == "\ud800\ud800"
    assert native_text.remove_repeated_chars("\ud800\ud800\ud800") == "\ud800"
    assert native_text.remove_repeated_lines("日\ud800日\ud800") == "日\ud800"
    assert native_text.count_kanji(["日\ud800本"]) == {"日": 1, "本": 1}
    assert native_text.remove_repeated_chars("abc", 2**100, False) == ""
    assert native_text.remove_repeated_lines("abc", 2**100) == "abc"

    def fail(*_args):
        raise RuntimeError("test native failure")

    monkeypatch.setattr(ocr, "_extension", SimpleNamespace(sequence_ratio=fail, count_kanji=fail))
    assert native_text.sequence_ratio("abc", "ac") == 0.8
    assert native_text.count_kanji(["日日"]) == {"日": 2}


def test_shadow_returns_python_and_reports_mismatch(monkeypatch):
    from GameSentenceMiner.native import text as native_text

    monkeypatch.setenv("GSM_NATIVE_TEXT_MODE", "shadow")
    monkeypatch.setattr(ocr, "_extension", SimpleNamespace(sequence_ratio=lambda *_args: 0.9))
    messages = []
    monkeypatch.setattr(native_text, "logger", SimpleNamespace(warning=lambda *args: messages.append(args)))
    assert native_text.sequence_ratio("abc", "ac") == 0.8
    assert len(messages) == 1


def test_python_mode_does_not_call_extension(monkeypatch):
    from GameSentenceMiner.native import text as native_text

    def unexpected(*_args):
        pytest.fail("Python mode called Rust")

    monkeypatch.setenv("GSM_NATIVE_TEXT_MODE", "python")
    monkeypatch.setattr(ocr, "_extension", SimpleNamespace(sequence_ratio=unexpected))
    assert native_text.sequence_ratio("abc", "ac") == 0.8


def test_ocr_comparison_uses_native_metrics(monkeypatch):
    monkeypatch.setenv("GSM_NATIVE_TEXT_MODE", "native")
    calls = []
    actual = ocr._extension.matching_block_stats

    def metrics(*args):
        calls.append(args)
        return actual(*args)

    monkeypatch.setattr(ocr._extension, "matching_block_stats", metrics)
    compare._matching_block_stats_cached.cache_clear()
    try:
        assert compare._matching_block_stats("abcde", "axcye") == (0.0, 1)
        assert calls == [("abcde", "axcye", 2)]
    finally:
        compare._matching_block_stats_cached.cache_clear()


def test_ocr_stability_uses_native_ratio(monkeypatch):
    from GameSentenceMiner.ocr import gsm_ocr

    monkeypatch.setenv("GSM_NATIVE_TEXT_MODE", "native")
    calls = []
    actual = ocr._extension.sequence_ratio

    def ratio(*args):
        calls.append(args)
        return actual(*args)

    monkeypatch.setattr(ocr._extension, "sequence_ratio", ratio)
    assert gsm_ocr._v2_texts_stable("今日は学校で日本語を勉強します", "今日は学校で日本語を勉強したす", 90)
    assert len(calls) == 1


@pytest.mark.parametrize(
    "name,text,expected",
    [("remove_repeated_chars", "日日日本本本", "日本"), ("remove_repeated_lines", "日本日本", "日本")],
)
def test_cleanup_callers_use_native(monkeypatch, name, text, expected):
    monkeypatch.setenv("GSM_NATIVE_TEXT_MODE", "native")
    actual = getattr(ocr._extension, name)
    calls = []

    def clean(*args):
        calls.append(args)
        return actual(*args)

    monkeypatch.setattr(ocr._extension, name, clean)
    assert getattr(text_processing, name)(text) == expected
    assert len(calls) == 1


def test_stats_batching_preserves_archive_order_and_ties(monkeypatch):
    from GameSentenceMiner.web.stats import calculate_kanji_frequency

    monkeypatch.setenv("GSM_NATIVE_TEXT_MODE", "native")
    lines = [
        SimpleNamespace(line_text="日"),
        SimpleNamespace(archived_kanji={"本": 2, "日": 1, "x": 0}),
        SimpleNamespace(line_text="語語\ud800"),
        SimpleNamespace(line_text=None),
        SimpleNamespace(line_text=123),
    ]
    result = calculate_kanji_frequency(iter(lines))
    assert [(row["kanji"], row["frequency"]) for row in result["kanji_data"]] == [
        ("日", 2),
        ("本", 2),
        ("語", 2),
        ("x", 0),
    ]


def test_stats_sends_batches_to_native(monkeypatch):
    from GameSentenceMiner.web.stats import calculate_kanji_frequency

    monkeypatch.setenv("GSM_NATIVE_TEXT_MODE", "native")
    actual = ocr._extension.count_kanji
    batches = []

    def count(texts):
        batches.append(len(texts))
        return actual(texts)

    monkeypatch.setattr(ocr._extension, "count_kanji", count)
    result = calculate_kanji_frequency(SimpleNamespace(line_text="日本") for _ in range(2500))
    assert result["max_frequency"] == 2500
    assert sum(batches) == 2500
    assert len(batches) < 10
    assert max(batches) <= 1024
