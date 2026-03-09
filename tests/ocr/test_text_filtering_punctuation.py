from __future__ import annotations

import re

from GameSentenceMiner.owocr.owocr import run as run_module
from GameSentenceMiner.owocr.owocr.run import TextFiltering


class _PassthroughSegmenter:
    def segment(self, text):
        return [text]


class _PipeSegmenter:
    def segment(self, text):
        return str(text).split("|")


def _make_text_filtering_for_ja(monkeypatch):
    monkeypatch.setattr(run_module, "get_ocr_language", lambda: "ja")

    tf = TextFiltering.__new__(TextFiltering)
    tf.initial_lang = "ja"
    tf.segmenter = _PassthroughSegmenter()
    tf.kana_kanji_regex = re.compile(r"[\u3041-\u3096\u30A1-\u30FA\u4E00-\u9FFF]")
    tf.kana_kanji_with_punct_regex = re.compile(
        r"[\u3041-\u3096\u30A1-\u30FA\u30FC\u4E00-\u9FFF"
        r"\u3001\u3002\u300C\u300D\u300E\u300F\u3010\u3011"
        r"\uFF08\uFF09\u3008\u3009\u300A\u300B\u3014\u3015"
        r"\uFF01\uFF1F\uFF0C\uFF0E\u30FB\u2026\u301C\uFF5E"
        r"\!\?\'\"\(\)\[\]\{\}\-]"
    )
    tf.last_few_results = {}
    tf.accurate_filtering = False
    tf.classify = lambda block: ("ja", 1.0)
    tf.regex = tf.kana_kanji_regex
    return tf


def test_text_filtering_preserves_japanese_punctuation_in_orig_text(monkeypatch):
    tf = _make_text_filtering_for_ja(monkeypatch)

    raw = "「返しなさいよーーーっ！！」"
    text, orig_text = tf(raw, [], engine=None, is_second_ocr=True)

    assert text == raw
    assert orig_text == [raw]


def test_text_filtering_uses_punctuation_stripped_tokens_for_dedup(monkeypatch):
    tf = _make_text_filtering_for_ja(monkeypatch)

    raw = "「返しなさいよーーーっ！！」"
    text1, _ = tf(raw, [], engine="oneocr", is_second_ocr=False)
    text2, _ = tf(raw, [], engine="oneocr", is_second_ocr=False)

    assert text1 == raw
    assert text2 == ""


def test_text_filtering_second_ocr_normalizes_raw_last_result(monkeypatch):
    tf = _make_text_filtering_for_ja(monkeypatch)

    raw = "「返しなさいよーーーっ！！」"
    text, _ = tf(raw, [raw], engine="oneocr", is_second_ocr=True)

    assert text == ""


def test_text_filtering_returns_all_current_blocks_for_state(monkeypatch):
    tf = _make_text_filtering_for_ja(monkeypatch)
    tf.segmenter = _PipeSegmenter()

    first = "淳平「痛って！」したたか頭を打ちつける。"
    second = "身をよじって手をつこうとしたのだが、その先にはなにもなかった。"

    _, prev_blocks = tf(first, [], engine="oneocr", is_second_ocr=True)
    dispatched, current_blocks = tf(
        f"{first}|{second}",
        prev_blocks,
        engine="oneocr",
        is_second_ocr=True,
    )

    assert dispatched == second
    assert current_blocks == [first, second]
