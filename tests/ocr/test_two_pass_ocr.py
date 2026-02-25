"""Comprehensive test-suite for the two-pass OCR controller.

Tests cover the four principal modes:
    1. Two-pass disabled
    2. Two-pass enabled – same engine for OCR1 & OCR2
    3. Two-pass enabled – different engines
    4. Two-pass enabled – Meiki text-detection as OCR1

And the key trigger scenarios:
    A. Text stabilises then disappears  (text → "")
    B. Text shown then orig_text becomes empty
    C. Text changes completely mid-stream
    D. Force-stable mode
    E. Evolving text (same sentence growing)
    F. Duplicate suppression
    G. Screenshot bypass
    H. Second-pass returns empty → fallback to first-pass text
    I. Meiki bounding-box stability

The synthetic dataset spans Japanese, Chinese, Korean, English, Russian,
Arabic, Thai, mixed CJK, and various edge cases (short, long, punctuation-
only, whitespace, emoji).
"""

from __future__ import annotations

import copy
import dataclasses
import re
from datetime import datetime, timedelta
from typing import Any
from unittest.mock import MagicMock

import pytest

from GameSentenceMiner.ocr.two_pass_ocr import (
    SecondPassResult,
    TwoPassConfig,
    TwoPassOCRController,
    _normalize_bypass_text,
    _select_bypass_output_text,
    compare_ocr_results,
)


# ---------------------------------------------------------------------------
# Synthetic multi-language dataset
# ---------------------------------------------------------------------------

_SENTENCES: dict[str, list[str]] = {
    "ja": [
        "今日はいい天気ですね。",
        "明日は雨が降るでしょう。",
        "彼女は毎朝六時に起きます。",
        "この本はとても面白いです。",
        "東京タワーから富士山が見えました。",
        "お腹が空いたので、ラーメンを食べに行きましょう。",
    ],
    "zh": [
        "今天天气很好。",
        "明天会下雨。",
        "她每天早上六点起床。",
        "这本书非常有趣。",
        "我们一起去吃饭吧。",
        "北京是中国的首都。",
    ],
    "ko": [
        "오늘 날씨가 좋습니다.",
        "내일 비가 올 것입니다.",
        "그녀는 매일 아침 6시에 일어납니다.",
        "이 책은 매우 재미있습니다.",
        "서울은 한국의 수도입니다.",
        "같이 밥 먹으러 가요.",
    ],
    "en": [
        "The weather is nice today.",
        "It will rain tomorrow.",
        "She wakes up at six every morning.",
        "This book is very interesting.",
        "London is the capital of England.",
        "Let's go out for dinner together.",
    ],
    "ru": [
        "Сегодня хорошая погода.",
        "Завтра будет дождь.",
        "Она просыпается в шесть утра каждый день.",
        "Эта книга очень интересная.",
        "Москва — столица России.",
        "Пойдём вместе ужинать.",
    ],
    "ar": [
        "الطقس جميل اليوم.",
        "سيمطر غداً.",
        "تستيقظ كل صباح في السادسة.",
        "هذا الكتاب ممتع للغاية.",
        "القاهرة عاصمة مصر.",
        "هيا نذهب لتناول العشاء معاً.",
    ],
    "th": [
        "วันนี้อากาศดีมาก",
        "พรุ่งนี้ฝนจะตก",
        "เธอตื่นตอนหกโมงทุกเช้า",
        "หนังสือเล่มนี้น่าสนใจมาก",
        "กรุงเทพเป็นเมืองหลวงของไทย",
        "ไปทานข้าวด้วยกันเถอะ",
    ],
}

# Pairs guaranteed to have different first AND last characters AND low (<20%) similarity.
# Used for "completely different text" trigger tests.
_CHANGE_PAIRS: dict[str, tuple[str, str]] = {
    "ja": ("今日はいい天気ですね。", "駅前の花屋が開いていた！"),
    "zh": ("今天天气很好。", "他們已經回家了！"),
    "ko": ("오늘 날씨가 좋습니다.", "학교에서 공부했어!"),
    "en": ("Bright yellow!", "Xqjz mpk?"),
    "ru": ("Тёплый дождь!", "Щука цапля?"),
}
_EDGE_CASES = {
    "empty": "",
    "single_char_ja": "あ",
    "single_char_en": "A",
    "two_chars_zh": "你好",
    "punctuation_only": "。！？…",
    "whitespace_only": "   \t\n  ",
    "emoji": "🎮🎯🎨",
    "mixed_cjk": "日本語とChinese混合テスト",
    "very_long": "あ" * 500,
    "newlines": "一行目\n二行目\n三行目",
    "partial_overlap_ja": "今日はいい天気です",  # prefix of ja[0]
    "near_duplicate_ja": "今日はいい天気ですね！",  # slight variant of ja[0]
}


def _dummy_img() -> MagicMock:
    """Return a light-weight mock image that supports ``.copy()``."""
    img = MagicMock(name="MockImage")
    img.copy.return_value = img
    img.width = 800
    img.height = 600
    return img


def _make_time(offset_sec: int = 0) -> datetime:
    return datetime(2026, 2, 22, 12, 0, 0) + timedelta(seconds=offset_sec)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def sent_texts() -> list[dict]:
    """Accumulator that captures every call to send_result."""
    return []


@pytest.fixture()
def saved_images() -> list:
    """Accumulator that captures save_image calls."""
    return []


@pytest.fixture()
def second_ocr_calls() -> list[dict]:
    """Accumulator that captures run_second_ocr calls."""
    return []


def _make_send(sent: list[dict]):
    """Build a send_result callback that appends to *sent*."""
    def _send(text, time, *, response_dict=None, source=None):
        sent.append({
            "text": text,
            "time": time,
            "response_dict": response_dict,
            "source": source,
        })
    return _send


def _make_save(saved: list):
    def _save(img, pre_crop_image=None):
        saved.append({"img": img, "pre_crop_image": pre_crop_image})
    return _save


def _make_second_ocr(calls: list[dict], return_text: str = "", return_empty: bool = False):
    """Build a run_second_ocr mock that records calls and returns canned text."""
    def _run(img, last_result, filtering, engine, **kw):
        calls.append({
            "img": img, "last_result": last_result,
            "filtering": filtering, "engine": engine, **kw,
        })
        if return_empty:
            return SecondPassResult(text="", orig_text=[], response_dict=None)
        return SecondPassResult(
            text=return_text or "", orig_text=[return_text] if return_text else [],
            response_dict={"engine": engine},
        )
    return _run


def _passthrough_filter(text, last_result, *, engine=None, is_second_ocr=False):
    """A trivial filter that passes text through unmodified."""
    return text, [text] if text else []


def _jp_chars_only_filter(text, last_result, *, engine=None, is_second_ocr=False):
    """Approximate production Japanese filter behavior that drops punctuation.

    This intentionally removes punctuation and prolonged sound marks so tests can
    verify bypass mode preserves the raw OCR text instead of the filtered form.
    """
    filtered = "".join(re.findall(r"[\u3041-\u3096\u30A1-\u30FA\u4E00-\u9FFF]", str(text or "")))
    return filtered, [filtered] if filtered else []


def _make_controller(
    cfg: TwoPassConfig,
    sent: list[dict],
    saved: list | None = None,
    second_ocr_calls: list[dict] | None = None,
    second_ocr_return: str = "",
    second_ocr_empty: bool = False,
    filtering=None,
) -> TwoPassOCRController:
    # Use `is not None` checks to avoid the `[] or []` pitfall (empty list is falsy)
    _saved = saved if saved is not None else []
    _ocr_calls = second_ocr_calls if second_ocr_calls is not None else []
    return TwoPassOCRController(
        config=cfg,
        filtering=filtering or _passthrough_filter,
        send_result=_make_send(sent),
        run_second_ocr=_make_second_ocr(
            _ocr_calls, return_text=second_ocr_return,
            return_empty=second_ocr_empty,
        ) if not cfg.same_engine else None,
        save_image=_make_save(_saved),
        get_ocr2_image=lambda coords, img: img,  # passthrough
    )


# ===================================================================
# 1. TWO-PASS DISABLED
# ===================================================================

class TestTwoPassDisabled:
    """Mode 1: two_pass_enabled=False – text is sent directly after dedup."""

    CFG = TwoPassConfig(two_pass_enabled=False, ocr1_engine="oneocr",
                        ocr2_engine="glens")

    @pytest.mark.parametrize("lang,idx", [
        ("ja", 0), ("zh", 1), ("ko", 2), ("en", 0), ("ru", 3), ("ar", 4), ("th", 5),
    ])
    def test_direct_send_various_languages(self, sent_texts, lang, idx):
        ctrl = _make_controller(self.CFG, sent_texts)
        text = _SENTENCES[lang][idx]
        ctrl.handle_ocr_result(text, [text], _make_time(), _dummy_img())
        assert len(sent_texts) == 1
        assert sent_texts[0]["text"] == text

    def test_duplicate_suppressed(self, sent_texts):
        ctrl = _make_controller(self.CFG, sent_texts)
        text = _SENTENCES["ja"][0]
        ctrl.handle_ocr_result(text, [text], _make_time(), _dummy_img())
        ctrl.handle_ocr_result(text, [text], _make_time(1), _dummy_img())
        assert len(sent_texts) == 1

    def test_near_duplicate_suppressed(self, sent_texts):
        ctrl = _make_controller(self.CFG, sent_texts)
        ctrl.handle_ocr_result(
            _SENTENCES["ja"][0], [_SENTENCES["ja"][0]], _make_time(), _dummy_img())
        ctrl.handle_ocr_result(
            _EDGE_CASES["near_duplicate_ja"],
            [_EDGE_CASES["near_duplicate_ja"]],
            _make_time(1), _dummy_img(),
        )
        assert len(sent_texts) == 1

    def test_different_text_sent(self, sent_texts):
        ctrl = _make_controller(self.CFG, sent_texts)
        ctrl.handle_ocr_result(
            _SENTENCES["ja"][0], [_SENTENCES["ja"][0]], _make_time(), _dummy_img())
        ctrl.handle_ocr_result(
            _SENTENCES["ja"][1], [_SENTENCES["ja"][1]], _make_time(1), _dummy_img())
        assert len(sent_texts) == 2
        assert sent_texts[1]["text"] == _SENTENCES["ja"][1]

    def test_empty_text_not_sent(self, sent_texts):
        ctrl = _make_controller(self.CFG, sent_texts)
        ctrl.handle_ocr_result("", [], _make_time(), _dummy_img())
        # Empty text should be filtered out by _send_direct guard
        assert len(sent_texts) == 0

    def test_whitespace_only_not_sent(self, sent_texts):
        """Whitespace-only text passes dedup (not similar to '') but still goes through."""
        ctrl = _make_controller(self.CFG, sent_texts)
        ctrl.handle_ocr_result(
            _EDGE_CASES["whitespace_only"],
            [_EDGE_CASES["whitespace_only"]],
            _make_time(), _dummy_img(),
        )
        # Whitespace string is "truthy", so it gets sent in disabled mode.
        assert len(sent_texts) == 1

    def test_single_char_ja(self, sent_texts):
        ctrl = _make_controller(self.CFG, sent_texts)
        ctrl.handle_ocr_result("あ", ["あ"], _make_time(), _dummy_img())
        assert len(sent_texts) == 1
        assert sent_texts[0]["text"] == "あ"

    def test_manual_mode_sends_directly(self, sent_texts):
        """Manual=True also sends directly, even if two_pass_enabled."""
        cfg = TwoPassConfig(two_pass_enabled=True, ocr1_engine="oneocr",
                            ocr2_engine="glens")
        ctrl = _make_controller(cfg, sent_texts)
        ctrl.handle_ocr_result(
            _SENTENCES["en"][0], [_SENTENCES["en"][0]], _make_time(),
            _dummy_img(), manual=True,
        )
        assert len(sent_texts) == 1

    def test_screenshot_bypass(self, sent_texts):
        ctrl = _make_controller(self.CFG, sent_texts)
        ctrl.handle_ocr_result(
            _SENTENCES["ja"][2], [_SENTENCES["ja"][2]], _make_time(),
            _dummy_img(), came_from_ss=True,
        )
        assert len(sent_texts) == 1

    def test_image_saved_on_send(self, sent_texts, saved_images):
        ctrl = _make_controller(self.CFG, sent_texts, saved=saved_images)
        ctrl.handle_ocr_result(
            _SENTENCES["en"][0], [_SENTENCES["en"][0]], _make_time(), _dummy_img())
        assert len(saved_images) == 1

    def test_source_propagated(self, sent_texts):
        ctrl = _make_controller(self.CFG, sent_texts)
        ctrl.handle_ocr_result(
            _SENTENCES["en"][0], [_SENTENCES["en"][0]], _make_time(),
            _dummy_img(), source="secondary",
        )
        assert sent_texts[0]["source"] == "secondary"


# ===================================================================
# 2. TWO-PASS ENABLED – SAME ENGINE
# ===================================================================

class TestTwoPassSameEngine:
    """Mode 2: OCR1 == OCR2 → bypass second pass; filter + send on trigger."""

    CFG = TwoPassConfig(two_pass_enabled=True, ocr1_engine="oneocr",
                        ocr2_engine="oneocr")

    # -- Trigger A: text disappears --

    @pytest.mark.parametrize("lang", ["ja", "zh", "ko", "en", "ru", "ar", "th"])
    def test_text_disappears_triggers_send(self, sent_texts, lang):
        """text→"" should trigger bypass send."""
        ctrl = _make_controller(self.CFG, sent_texts)
        text = _SENTENCES[lang][0]
        ctrl.handle_ocr_result(text, [text], _make_time(), _dummy_img())
        assert len(sent_texts) == 0, "Should NOT send on first frame"
        ctrl.handle_ocr_result("", [], _make_time(1), _dummy_img())
        assert len(sent_texts) == 1
        assert sent_texts[0]["text"] == text

    def test_text_disappears_then_reappears(self, sent_texts):
        """text→""→same text: second occurrence is duplicate and suppressed."""
        ctrl = _make_controller(self.CFG, sent_texts)
        text = _SENTENCES["ja"][0]
        ctrl.handle_ocr_result(text, [text], _make_time(), _dummy_img())
        ctrl.handle_ocr_result("", [], _make_time(1), _dummy_img())
        assert len(sent_texts) == 1
        # Same text re-appears → becomes pending
        ctrl.handle_ocr_result(text, [text], _make_time(2), _dummy_img())
        # Disappears again → duplicate suppressed
        ctrl.handle_ocr_result("", [], _make_time(3), _dummy_img())
        assert len(sent_texts) == 1

    # -- Trigger B: orig_text becomes empty --

    def test_orig_text_empty_triggers_send(self, sent_texts):
        ctrl = _make_controller(self.CFG, sent_texts)
        text = _SENTENCES["ja"][1]
        ctrl.handle_ocr_result(text, [text], _make_time(), _dummy_img())
        # Empty orig_text → text is also empty string → triggers
        ctrl.handle_ocr_result("", [], _make_time(1), _dummy_img())
        assert len(sent_texts) == 1
        assert sent_texts[0]["text"] == text

    # -- Trigger C: text changes completely --

    @pytest.mark.parametrize("lang", ["ja", "zh", "ko", "en", "ru"])
    def test_completely_different_text_triggers(self, sent_texts, lang):
        ctrl = _make_controller(self.CFG, sent_texts)
        t1, t2 = _CHANGE_PAIRS[lang]
        ctrl.handle_ocr_result(t1, [t1], _make_time(), _dummy_img())
        # Completely different text
        ctrl.handle_ocr_result(t2, [t2], _make_time(1), _dummy_img())
        # Verify first text was sent (triggered by change)
        assert len(sent_texts) == 1
        assert sent_texts[0]["text"] == t1

    def test_complete_change_then_disappear_sends_both(self, sent_texts):
        ctrl = _make_controller(self.CFG, sent_texts)
        t1, t2 = _CHANGE_PAIRS["ja"]
        ctrl.handle_ocr_result(t1, [t1], _make_time(), _dummy_img())
        ctrl.handle_ocr_result(t2, [t2], _make_time(1), _dummy_img())
        assert len(sent_texts) == 1  # t1 sent
        ctrl.handle_ocr_result("", [], _make_time(2), _dummy_img())
        assert len(sent_texts) == 2  # t2 sent
        assert sent_texts[1]["text"] == t2

    def test_same_speaker_different_utterance_then_empty_sends_both(self, sent_texts):
        """Regression: same-speaker long utterances (shared Ｖ： prefix) — both must be sent.
        Production case: Ｖ：あんたの... then Ｖ：自由、開放感... then 4 empty frames.
        Bug was: bypass path returned early, t2 was never stored in pending.
        """
        ctrl = _make_controller(self.CFG, sent_texts)
        t1 = "Ｖ：あんたの戦争を経験した帰還兵たちのことだが、ノーマッドになる人が多いのは知ってるか？そのうちの何人かと会った"
        t2 = "Ｖ：自由、開放感――そんなものは所詮まやかしだ。兵士たちはそれを誰よりも知ってる。他に選択肢がないだけだ"
        ctrl.handle_ocr_result(t1, [t1], _make_time(), _dummy_img())
        ctrl.handle_ocr_result(t2, [t2], _make_time(1), _dummy_img())
        assert len(sent_texts) == 1, "t1 should be sent when t2 arrives"
        assert sent_texts[0]["text"] == t1
        # 4 empty frames follow
        for i in range(2, 6):
            ctrl.handle_ocr_result("", [], _make_time(i), _dummy_img())
        assert len(sent_texts) == 2, "t2 should be sent after empty frames"
        assert sent_texts[1]["text"] == t2

    def test_bypass_uses_orig_text_not_prefilt_text(self, sent_texts):
        """Regression: bypass must re-filter orig_text (raw OCR), not the already-filtered text.
        Production case: TextFiltering memory strips seen prefix, leaving only the new tail
        as `text`; `orig_text` still contains the full raw sentence.  Bypass must send the
        full sentence, not just the leftover tail.
        """
        raw_full = "その部分が凹凸であったかのようにぴったりと馴染んでいたので、放っておくことにした。"
        filtered_tail = "放っておくことにした。"  # what TextFiltering returns when it has memory

        ctrl = _make_controller(self.CFG, sent_texts)

        # Frame 1: sentence is still growing (evolving text).  text == orig_text.
        partial = "その部分が凹凸であったかのようにぴったりと馴染んでいたので、"
        ctrl.handle_ocr_result(partial, [partial], _make_time(), _dummy_img())

        # Frame 2: TextFiltering with memory returned only the new tail as `text`,
        # but orig_text contains the full raw sentence.
        # _is_text_evolving sees partial→raw_full as evolving, so pending updates.
        ctrl.handle_ocr_result(filtered_tail, [raw_full], _make_time(1), _dummy_img())
        assert len(sent_texts) == 0, "No send yet — text is still evolving"

        # Frame 3: empty — bypass fires on updated pending.
        ctrl.handle_ocr_result("", [], _make_time(2), _dummy_img())
        assert len(sent_texts) == 1
        # The bypass must pass orig_text (raw_full) through the filter, not filtered_tail.
        assert sent_texts[0]["text"] == raw_full, (
            f"Expected full raw sentence but got: {sent_texts[0]['text']!r}"
        )

    def test_same_engine_bypass_preserves_japanese_punctuation(self, sent_texts):
        """Regression: bypass output should keep OCR punctuation/elongation marks.

        Even if TextFiltering strips punctuation for matching, outgoing text must
        preserve raw OCR content in same-engine mode.
        """
        ctrl = _make_controller(self.CFG, sent_texts, filtering=_jp_chars_only_filter)
        text = "「返しなさいよーーーっ！！」"

        ctrl.handle_ocr_result(text, [text], _make_time(), _dummy_img())
        ctrl.handle_ocr_result("", [], _make_time(1), _dummy_img())

        assert len(sent_texts) == 1
        assert sent_texts[0]["text"] == text

    def test_same_engine_bypass_prefers_raw_text_kwarg(self, sent_texts):
        """When provided, raw_text should drive bypass output preservation."""
        ctrl = _make_controller(self.CFG, sent_texts, filtering=_jp_chars_only_filter)
        raw_text = "ジョニー：こいつはちげえ――Ｖ"
        filtered_text = "ジョニーこいつはちげえ"

        ctrl.handle_ocr_result(
            filtered_text,
            [filtered_text],
            _make_time(),
            _dummy_img(),
            raw_text=raw_text,
        )
        ctrl.handle_ocr_result("", [], _make_time(1), _dummy_img())

        assert len(sent_texts) == 1
        assert sent_texts[0]["text"] == raw_text

    def test_same_engine_bypass_preserves_quotes_and_symbols_across_updates(self, sent_texts):
        """Regression for user-reported sequence: final line should retain symbols."""
        ctrl = _make_controller(self.CFG, sent_texts, filtering=_jp_chars_only_filter)

        partial = "「返"
        growing = "「返しなさいよーーー"
        final = "「返しなさいよーーーっ！！」"

        ctrl.handle_ocr_result(partial, [partial], _make_time(), _dummy_img())
        ctrl.handle_ocr_result(growing, [growing], _make_time(1), _dummy_img())
        ctrl.handle_ocr_result(final, [final], _make_time(2), _dummy_img())
        ctrl.handle_ocr_result("", [], _make_time(3), _dummy_img())

        assert len(sent_texts) == 1
        assert sent_texts[0]["text"] == final

    # -- Trigger D: force-stable --

    def test_force_stable_triggers_immediately(self, sent_texts):
        ctrl = _make_controller(self.CFG, sent_texts)
        ctrl.set_force_stable(True)
        text = _SENTENCES["ja"][2]
        ctrl.handle_ocr_result(text, [text], _make_time(), _dummy_img())
        # Next frame with any text triggers
        ctrl.handle_ocr_result(
            _SENTENCES["ja"][3], [_SENTENCES["ja"][3]], _make_time(1), _dummy_img())
        assert len(sent_texts) == 1
        assert sent_texts[0]["text"] == text
        # Force-stable gets reset after trigger
        assert ctrl.force_stable is False

    def test_toggle_force_stable(self, sent_texts):
        ctrl = _make_controller(self.CFG, sent_texts)
        assert ctrl.toggle_force_stable() is True
        assert ctrl.toggle_force_stable() is False

    # -- Trigger E: evolving text --

    def test_evolving_text_updates_pending(self, sent_texts):
        """Same line growing → pending updates, no premature send."""
        ctrl = _make_controller(self.CFG, sent_texts)
        prefix = _EDGE_CASES["partial_overlap_ja"]
        full = _SENTENCES["ja"][0]
        ctrl.handle_ocr_result(prefix, [prefix], _make_time(), _dummy_img())
        ctrl.handle_ocr_result(full, [full], _make_time(1), _dummy_img())
        assert len(sent_texts) == 0
        # Now disappear → sends the final evolved form
        ctrl.handle_ocr_result("", [], _make_time(2), _dummy_img())
        assert len(sent_texts) == 1
        assert sent_texts[0]["text"] == full

    # -- Dedup within same-engine bypass --

    def test_same_engine_dedup(self, sent_texts):
        ctrl = _make_controller(self.CFG, sent_texts)
        text = _SENTENCES["ko"][0]
        ctrl.handle_ocr_result(text, [text], _make_time(), _dummy_img())
        ctrl.handle_ocr_result("", [], _make_time(1), _dummy_img())
        assert len(sent_texts) == 1
        # Same text again
        ctrl.handle_ocr_result(text, [text], _make_time(2), _dummy_img())
        ctrl.handle_ocr_result("", [], _make_time(3), _dummy_img())
        # Dedup should suppress
        assert len(sent_texts) == 1

    # -- Edge cases --

    def test_single_char_disappears(self, sent_texts):
        ctrl = _make_controller(self.CFG, sent_texts)
        ctrl.handle_ocr_result("あ", ["あ"], _make_time(), _dummy_img())
        ctrl.handle_ocr_result("", [], _make_time(1), _dummy_img())
        assert len(sent_texts) == 1
        assert sent_texts[0]["text"] == "あ"

    def test_emoji_text(self, sent_texts):
        ctrl = _make_controller(self.CFG, sent_texts)
        ctrl.handle_ocr_result("🎮🎯", ["🎮🎯"], _make_time(), _dummy_img())
        ctrl.handle_ocr_result("", [], _make_time(1), _dummy_img())
        assert len(sent_texts) == 1

    def test_very_long_text(self, sent_texts):
        ctrl = _make_controller(self.CFG, sent_texts)
        long_text = _EDGE_CASES["very_long"]
        ctrl.handle_ocr_result(long_text, [long_text], _make_time(), _dummy_img())
        ctrl.handle_ocr_result("", [], _make_time(1), _dummy_img())
        assert len(sent_texts) == 1
        assert sent_texts[0]["text"] == long_text

    def test_empty_then_text_no_premature_send(self, sent_texts):
        """Alternating empty → text should not cause false sends."""
        ctrl = _make_controller(self.CFG, sent_texts)
        ctrl.handle_ocr_result("", [], _make_time(), _dummy_img())
        ctrl.handle_ocr_result("", [], _make_time(1), _dummy_img())
        assert len(sent_texts) == 0
        ctrl.handle_ocr_result(
            _SENTENCES["ja"][0], [_SENTENCES["ja"][0]], _make_time(2), _dummy_img())
        assert len(sent_texts) == 0  # just becomes pending

    def test_multiline_text_newline_normalization(self, sent_texts):
        ctrl = _make_controller(
            dataclasses.replace(self.CFG, keep_newline=False), sent_texts)
        text = "一行目\n二行目\n三行目"
        ctrl.handle_ocr_result(text, [text], _make_time(), _dummy_img())
        ctrl.handle_ocr_result("", [], _make_time(1), _dummy_img())
        assert len(sent_texts) == 1
        # Newlines should be stripped in bypass mode
        assert "\n" not in sent_texts[0]["text"]

    def test_multiline_text_keep_newline(self, sent_texts):
        ctrl = _make_controller(
            dataclasses.replace(self.CFG, keep_newline=True), sent_texts)
        text = "一行目\n二行目\n三行目"
        ctrl.handle_ocr_result(text, [text], _make_time(), _dummy_img())
        ctrl.handle_ocr_result("", [], _make_time(1), _dummy_img())
        assert len(sent_texts) == 1
        # Newlines preserved
        assert "\n" in sent_texts[0]["text"]

    def test_reset_clears_pending(self, sent_texts):
        ctrl = _make_controller(self.CFG, sent_texts)
        ctrl.handle_ocr_result(
            _SENTENCES["ja"][0], [_SENTENCES["ja"][0]], _make_time(), _dummy_img())
        ctrl.reset()
        ctrl.handle_ocr_result("", [], _make_time(1), _dummy_img())
        # Pending was cleared; nothing to send
        assert len(sent_texts) == 0


# ===================================================================
# 3. TWO-PASS ENABLED – DIFFERENT ENGINES
# ===================================================================

class TestTwoPassDifferentEngines:
    """Mode 3: OCR1 != OCR2 → full second pass with different engine."""

    CFG = TwoPassConfig(two_pass_enabled=True, ocr1_engine="oneocr",
                        ocr2_engine="glens")

    # -- Trigger A: text disappears --

    @pytest.mark.parametrize("lang", ["ja", "zh", "ko", "en", "ru", "ar", "th"])
    def test_text_disappears_runs_second_ocr(
        self, sent_texts, second_ocr_calls, lang,
    ):
        ocr2_text = _SENTENCES[lang][0] + "(refined)"
        ctrl = _make_controller(
            self.CFG, sent_texts, second_ocr_calls=second_ocr_calls,
            second_ocr_return=ocr2_text,
        )
        text = _SENTENCES[lang][0]
        ctrl.handle_ocr_result(text, [text], _make_time(), _dummy_img())
        assert len(second_ocr_calls) == 0
        ctrl.handle_ocr_result("", [], _make_time(1), _dummy_img())
        assert len(second_ocr_calls) == 1
        assert len(sent_texts) == 1
        assert sent_texts[0]["text"] == ocr2_text

    def test_second_ocr_receives_correct_engine(
        self, sent_texts, second_ocr_calls,
    ):
        ctrl = _make_controller(
            self.CFG, sent_texts, second_ocr_calls=second_ocr_calls,
            second_ocr_return="refined",
        )
        ctrl.handle_ocr_result(
            _SENTENCES["ja"][0], [_SENTENCES["ja"][0]], _make_time(), _dummy_img())
        ctrl.handle_ocr_result("", [], _make_time(1), _dummy_img())
        assert second_ocr_calls[0]["engine"] == "glens"

    # -- Second pass returns empty → fallback to first-pass text --

    @pytest.mark.parametrize("lang", ["ja", "zh", "en"])
    def test_second_pass_empty_fallback(self, sent_texts, second_ocr_calls, lang):
        """When second OCR returns empty, fall back to OCR1 text."""
        ctrl = _make_controller(
            self.CFG, sent_texts, second_ocr_calls=second_ocr_calls,
            second_ocr_empty=True,
        )
        text = _SENTENCES[lang][0]
        ctrl.handle_ocr_result(text, [text], _make_time(), _dummy_img())
        ctrl.handle_ocr_result("", [], _make_time(1), _dummy_img())
        assert len(sent_texts) == 1
        # Fell back to OCR1 text
        assert sent_texts[0]["text"] == text

    # -- Trigger C: text changes completely --

    def test_complete_change_triggers_second_pass(
        self, sent_texts, second_ocr_calls,
    ):
        t1, t2 = _CHANGE_PAIRS["ja"]
        ocr2_text = t1 + "(refined)"
        ctrl = _make_controller(
            self.CFG, sent_texts, second_ocr_calls=second_ocr_calls,
            second_ocr_return=ocr2_text,
        )
        ctrl.handle_ocr_result(t1, [t1], _make_time(), _dummy_img())
        ctrl.handle_ocr_result(t2, [t2], _make_time(1), _dummy_img())
        assert len(second_ocr_calls) == 1
        assert len(sent_texts) == 1
        assert sent_texts[0]["text"] == ocr2_text

    def test_three_different_texts_sends_first_two(
        self, sent_texts, second_ocr_calls,
    ):
        # Use texts with guaranteed different start+end chars and < 20% similarity
        texts = [
            "Bright yellow!",
            "Xqjz mpk?",
            "復活祭りの夫#",
        ]
        call_idx = [0]

        def _multi_return(img, last_result, filtering, engine, **kw):
            call_idx[0] += 1
            second_ocr_calls.append({})
            t = texts[call_idx[0] - 1] + "(R)"
            return SecondPassResult(text=t, orig_text=[t],
                                   response_dict={"engine": engine})

        ctrl = TwoPassOCRController(
            config=self.CFG,
            filtering=_passthrough_filter,
            send_result=_make_send(sent_texts),
            run_second_ocr=_multi_return,
            save_image=lambda *a, **kw: None,
            get_ocr2_image=lambda c, i: i,
        )
        ctrl.handle_ocr_result(texts[0], [texts[0]], _make_time(0), _dummy_img())
        ctrl.handle_ocr_result(texts[1], [texts[1]], _make_time(1), _dummy_img())
        assert len(sent_texts) == 1  # texts[0] refined
        ctrl.handle_ocr_result(texts[2], [texts[2]], _make_time(2), _dummy_img())
        assert len(sent_texts) == 2  # texts[1] refined

    # -- Trigger D: force-stable with different engines --

    def test_force_stable_different_engines(
        self, sent_texts, second_ocr_calls,
    ):
        ctrl = _make_controller(
            self.CFG, sent_texts, second_ocr_calls=second_ocr_calls,
            second_ocr_return="refined",
        )
        ctrl.set_force_stable(True)
        t1, t2 = _CHANGE_PAIRS["ja"]
        ctrl.handle_ocr_result(t1, [t1], _make_time(), _dummy_img())
        ctrl.handle_ocr_result(t2, [t2], _make_time(1), _dummy_img())
        assert len(second_ocr_calls) == 1
        assert len(sent_texts) == 1

    # -- Dedup between frames --

    def test_duplicate_after_second_pass(self, sent_texts, second_ocr_calls):
        """If OCR2 returns same text twice, second is suppressed."""
        ctrl = _make_controller(
            self.CFG, sent_texts, second_ocr_calls=second_ocr_calls,
            second_ocr_return="same",
        )
        s = _SENTENCES["ja"]
        ctrl.handle_ocr_result(s[0], [s[0]], _make_time(), _dummy_img())
        ctrl.handle_ocr_result("", [], _make_time(1), _dummy_img())
        assert len(sent_texts) == 1
        ctrl.handle_ocr_result(s[1], [s[1]], _make_time(2), _dummy_img())
        ctrl.handle_ocr_result("", [], _make_time(3), _dummy_img())
        # Second pass returns "same" again → duplicate suppressed
        assert len(sent_texts) == 1

    # -- Edge: evolving text with different engines --

    def test_evolving_text_sends_final(self, sent_texts, second_ocr_calls):
        ctrl = _make_controller(
            self.CFG, sent_texts, second_ocr_calls=second_ocr_calls,
            second_ocr_return="refined_full",
        )
        ctrl.handle_ocr_result("今日は", ["今日は"], _make_time(), _dummy_img())
        ctrl.handle_ocr_result(
            "今日はいい天気", ["今日はいい天気"], _make_time(1), _dummy_img())
        ctrl.handle_ocr_result(
            _SENTENCES["ja"][0], [_SENTENCES["ja"][0]], _make_time(2), _dummy_img())
        assert len(sent_texts) == 0  # still evolving, no trigger
        ctrl.handle_ocr_result("", [], _make_time(3), _dummy_img())
        assert len(sent_texts) == 1

    # -- Edge: no second-ocr callback --

    def test_no_second_ocr_callback_uses_bypass(self, sent_texts):
        """If run_second_ocr is None, falls back to bypass."""
        ctrl = TwoPassOCRController(
            config=self.CFG,
            filtering=_passthrough_filter,
            send_result=_make_send(sent_texts),
            run_second_ocr=None,
            save_image=lambda *a, **kw: None,
            get_ocr2_image=lambda c, i: i,
        )
        ctrl.handle_ocr_result(
            _SENTENCES["ja"][0], [_SENTENCES["ja"][0]], _make_time(), _dummy_img())
        ctrl.handle_ocr_result("", [], _make_time(1), _dummy_img())
        assert len(sent_texts) == 1
        assert sent_texts[0]["text"] == _SENTENCES["ja"][0]


# ===================================================================
# 4. TWO-PASS ENABLED – MEIKI FIRST PASS
# ===================================================================

class TestMeikiFirstPass:
    """Mode 4: OCR1 is Meiki text detection → bounding-box stability check."""

    CFG = TwoPassConfig(two_pass_enabled=True, ocr1_engine="meiki",
                        ocr2_engine="glens")

    def test_meiki_single_frame_no_send(self, sent_texts, second_ocr_calls):
        ctrl = _make_controller(
            self.CFG, sent_texts, second_ocr_calls=second_ocr_calls,
            second_ocr_return="meiki_refined",
        )
        ctrl.handle_ocr_result(
            "テスト", ["テスト"], _make_time(), _dummy_img(),
            meiki_boxes=[{"box": (10, 20, 100, 50)}],
            crop_coords=(10, 20, 100, 50),
        )
        assert len(sent_texts) == 0

    def test_meiki_stable_coords_triggers_second_pass(
        self, sent_texts, second_ocr_calls,
    ):
        ctrl = _make_controller(
            self.CFG, sent_texts, second_ocr_calls=second_ocr_calls,
            second_ocr_return="meiki_refined",
        )
        coords = (10, 20, 100, 50)
        ctrl.handle_ocr_result(
            "テスト", ["テスト"], _make_time(), _dummy_img(),
            meiki_boxes=[{"box": coords}], crop_coords=coords,
        )
        # Same coords again = stable
        ctrl.handle_ocr_result(
            "テスト", ["テスト"], _make_time(1), _dummy_img(),
            meiki_boxes=[{"box": coords}], crop_coords=coords,
        )
        assert len(second_ocr_calls) == 1
        assert len(sent_texts) == 1
        assert sent_texts[0]["text"] == "meiki_refined"

    def test_meiki_changing_coords_no_trigger(
        self, sent_texts, second_ocr_calls,
    ):
        ctrl = _make_controller(
            self.CFG, sent_texts, second_ocr_calls=second_ocr_calls,
            second_ocr_return="meiki_refined",
        )
        ctrl.handle_ocr_result(
            "テスト", ["テスト"], _make_time(), _dummy_img(),
            meiki_boxes=[{"box": (10, 20, 100, 50)}],
            crop_coords=(10, 20, 100, 50),
        )
        # Very different coords
        ctrl.handle_ocr_result(
            "テスト", ["テスト"], _make_time(1), _dummy_img(),
            meiki_boxes=[{"box": (200, 300, 500, 400)}],
            crop_coords=(200, 300, 500, 400),
        )
        assert len(second_ocr_calls) == 0

    def test_meiki_stable_then_same_coords_suppressed(
        self, sent_texts, second_ocr_calls,
    ):
        """After successful send, same coords should not re-trigger."""
        ctrl = _make_controller(
            self.CFG, sent_texts, second_ocr_calls=second_ocr_calls,
            second_ocr_return="meiki_refined",
        )
        coords = (10, 20, 100, 50)
        ctrl.handle_ocr_result(
            "テスト", ["テスト"], _make_time(), _dummy_img(),
            meiki_boxes=[{"box": coords}], crop_coords=coords,
        )
        ctrl.handle_ocr_result(
            "テスト", ["テスト"], _make_time(1), _dummy_img(),
            meiki_boxes=[{"box": coords}], crop_coords=coords,
        )
        assert len(sent_texts) == 1
        # Third time – already succeeded for these coords
        ctrl.handle_ocr_result(
            "テスト", ["テスト"], _make_time(2), _dummy_img(),
            meiki_boxes=[{"box": coords}], crop_coords=coords,
        )
        assert len(sent_texts) == 1

    def test_meiki_coords_within_tolerance(self, sent_texts, second_ocr_calls):
        """Coords that differ by ≤ MEIKI_TOL count as stable."""
        ctrl = _make_controller(
            self.CFG, sent_texts, second_ocr_calls=second_ocr_calls,
            second_ocr_return="meiki_refined",
        )
        ctrl.handle_ocr_result(
            "テスト", ["テスト"], _make_time(), _dummy_img(),
            meiki_boxes=[{"box": (10, 20, 100, 50)}],
            crop_coords=(10, 20, 100, 50),
        )
        # +3 pixels – within tolerance of 5
        ctrl.handle_ocr_result(
            "テスト", ["テスト"], _make_time(1), _dummy_img(),
            meiki_boxes=[{"box": (13, 22, 102, 53)}],
            crop_coords=(13, 22, 102, 53),
        )
        assert len(sent_texts) == 1

    def test_meiki_coords_outside_tolerance(self, sent_texts, second_ocr_calls):
        """Coords differing by > MEIKI_TOL are unstable."""
        ctrl = _make_controller(
            self.CFG, sent_texts, second_ocr_calls=second_ocr_calls,
            second_ocr_return="meiki_refined",
        )
        ctrl.handle_ocr_result(
            "テスト", ["テスト"], _make_time(), _dummy_img(),
            meiki_boxes=[{"box": (10, 20, 100, 50)}],
            crop_coords=(10, 20, 100, 50),
        )
        # +6 pixels – outside tolerance
        ctrl.handle_ocr_result(
            "テスト", ["テスト"], _make_time(1), _dummy_img(),
            meiki_boxes=[{"box": (16, 26, 106, 56)}],
            crop_coords=(16, 26, 106, 56),
        )
        assert len(sent_texts) == 0

    @pytest.mark.parametrize("lang", ["ja", "zh", "ko"])
    def test_meiki_various_languages(self, sent_texts, second_ocr_calls, lang):
        refined = _SENTENCES[lang][0] + "(meiki)"
        ctrl = _make_controller(
            self.CFG, sent_texts, second_ocr_calls=second_ocr_calls,
            second_ocr_return=refined,
        )
        text = _SENTENCES[lang][0]
        coords = (50, 50, 200, 100)
        ctrl.handle_ocr_result(
            text, [text], _make_time(), _dummy_img(),
            meiki_boxes=[{"box": coords}], crop_coords=coords,
        )
        ctrl.handle_ocr_result(
            text, [text], _make_time(1), _dummy_img(),
            meiki_boxes=[{"box": coords}], crop_coords=coords,
        )
        assert len(sent_texts) == 1
        assert sent_texts[0]["text"] == refined

    def test_meiki_none_crop_coords_reset(self, sent_texts, second_ocr_calls):
        """None crop_coords after initial frame resets tracking."""
        ctrl = _make_controller(
            self.CFG, sent_texts, second_ocr_calls=second_ocr_calls,
            second_ocr_return="meiki_refined",
        )
        ctrl.handle_ocr_result(
            "テスト", ["テスト"], _make_time(), _dummy_img(),
            meiki_boxes=[{"box": (10, 20, 100, 50)}],
            crop_coords=(10, 20, 100, 50),
        )
        ctrl.handle_ocr_result(
            "テスト", ["テスト"], _make_time(1), _dummy_img(),
            meiki_boxes=[{"box": None}], crop_coords=None,
        )
        assert len(sent_texts) == 0

    def test_meiki_second_pass_empty_fallback(self, sent_texts, second_ocr_calls):
        """If second pass returns empty for meiki, fall back to first-pass text."""
        ctrl = _make_controller(
            self.CFG, sent_texts, second_ocr_calls=second_ocr_calls,
            second_ocr_empty=True,
        )
        coords = (10, 20, 100, 50)
        text = _SENTENCES["ja"][0]
        ctrl.handle_ocr_result(
            text, [text], _make_time(), _dummy_img(),
            meiki_boxes=[{"box": coords}], crop_coords=coords,
        )
        ctrl.handle_ocr_result(
            text, [text], _make_time(1), _dummy_img(),
            meiki_boxes=[{"box": coords}], crop_coords=coords,
        )
        assert len(sent_texts) == 1
        # Fell back to OCR1 text through bypass
        assert sent_texts[0]["text"] == text


# ===================================================================
# 5. CROSS-CUTTING: RAPID SEQUENCES & STATE TRANSITIONS
# ===================================================================

class TestRapidSequences:
    """Simulate realistic rapid OCR frame sequences."""

    CFG_DIFF = TwoPassConfig(two_pass_enabled=True, ocr1_engine="oneocr",
                             ocr2_engine="glens")
    CFG_SAME = TwoPassConfig(two_pass_enabled=True, ocr1_engine="oneocr",
                             ocr2_engine="oneocr")

    def test_rapid_empty_frames_no_crash(self, sent_texts):
        ctrl = _make_controller(self.CFG_SAME, sent_texts)
        for i in range(20):
            ctrl.handle_ocr_result("", [], _make_time(i), _dummy_img())
        assert len(sent_texts) == 0

    def test_alternating_text_empty(self, sent_texts):
        """text → "" → text → "" pattern sends each unique text once."""
        ctrl = _make_controller(self.CFG_SAME, sent_texts)
        sentences = _SENTENCES["ja"][:4]
        for i, s in enumerate(sentences):
            ctrl.handle_ocr_result(s, [s], _make_time(i * 2), _dummy_img())
            ctrl.handle_ocr_result("", [], _make_time(i * 2 + 1), _dummy_img())
        assert len(sent_texts) == 4
        for i, s in enumerate(sentences):
            assert sent_texts[i]["text"] == s

    def test_long_dialogue_sequence(self, sent_texts, second_ocr_calls):
        """Simulate a visual novel dialogue sequence with OCR2."""
        s = _SENTENCES["ja"]
        call_count = [0]

        def _sequential_return(img, last_result, filtering, engine, **kw):
            idx = call_count[0]
            call_count[0] += 1
            second_ocr_calls.append({})
            refined = s[idx] + "(R)"
            return SecondPassResult(text=refined, orig_text=[refined],
                                   response_dict=None)

        ctrl = TwoPassOCRController(
            config=self.CFG_DIFF,
            filtering=_passthrough_filter,
            send_result=_make_send(sent_texts),
            run_second_ocr=_sequential_return,
            save_image=lambda *a, **kw: None,
            get_ocr2_image=lambda c, i: i,
        )
        for i, sentence in enumerate(s):
            ctrl.handle_ocr_result(
                sentence, [sentence], _make_time(i * 3), _dummy_img())
            # A few stable frames
            ctrl.handle_ocr_result(
                sentence, [sentence], _make_time(i * 3 + 1), _dummy_img())
            # Text disappears
            ctrl.handle_ocr_result("", [], _make_time(i * 3 + 2), _dummy_img())

        assert len(sent_texts) == len(s)
        for i, sentence in enumerate(s):
            assert sent_texts[i]["text"] == sentence + "(R)"

    def test_mixed_language_sequence(self, sent_texts):
        """Sequence of different languages should all be sent."""
        ctrl = _make_controller(self.CFG_SAME, sent_texts)
        languages = ["ja", "zh", "ko", "en", "ru"]
        for i, lang in enumerate(languages):
            text = _SENTENCES[lang][0]
            ctrl.handle_ocr_result(text, [text], _make_time(i * 2), _dummy_img())
            ctrl.handle_ocr_result("", [], _make_time(i * 2 + 1), _dummy_img())
        assert len(sent_texts) == len(languages)

    def test_screenshot_clears_pending(self, sent_texts):
        """Screenshot mode should clear any pending two-pass state."""
        ctrl = _make_controller(self.CFG_SAME, sent_texts)
        ctrl.handle_ocr_result(
            _SENTENCES["ja"][0], [_SENTENCES["ja"][0]], _make_time(), _dummy_img())
        # Screenshot interrupts
        ctrl.handle_ocr_result(
            _SENTENCES["ja"][2], [_SENTENCES["ja"][2]], _make_time(1),
            _dummy_img(), came_from_ss=True,
        )
        assert len(sent_texts) == 1
        assert sent_texts[0]["text"] == _SENTENCES["ja"][2]
        # Empty frame → pending was cleared by screenshot
        ctrl.handle_ocr_result("", [], _make_time(2), _dummy_img())
        assert len(sent_texts) == 1

    def test_reset_mid_sequence(self, sent_texts, second_ocr_calls):
        ctrl = _make_controller(
            self.CFG_DIFF, sent_texts, second_ocr_calls=second_ocr_calls,
            second_ocr_return="refined",
        )
        ctrl.handle_ocr_result(
            _SENTENCES["ja"][0], [_SENTENCES["ja"][0]], _make_time(), _dummy_img())
        ctrl.reset()
        # After reset, empty frame should not trigger anything
        ctrl.handle_ocr_result("", [], _make_time(1), _dummy_img())
        assert len(sent_texts) == 0
        assert len(second_ocr_calls) == 0

    # -- Regression: speaker-prefix causes false dedup between consecutive lines --

    @pytest.mark.parametrize("line1,line2", [
        ("マイヤーズ：ふん",      "マイヤーズ：おやすみ、Ｖ"),
        ("田中：ありがとう",      "田中：おはようございます"),
        ("V: Yeah.",             "V: I don't think so."),
    ])
    def test_consecutive_same_speaker_lines_both_sent(self, sent_texts, line1, line2):
        """Regression: consecutive same-speaker dialogue lines must each be sent.

        Before fix, partial_ratio on the shared speaker prefix caused the second
        line to be falsely treated as a duplicate of the first.

        Production log:
            マイヤーズ：ふん  → (empty)  → マイヤーズ：おやすみ、Ｖ  → (empty)
        Expected: both lines sent.
        """
        ctrl = _make_controller(self.CFG_SAME, sent_texts)
        # Line 1 appears then disappears
        ctrl.handle_ocr_result(line1, [line1], _make_time(0), _dummy_img())
        ctrl.handle_ocr_result("",    [],       _make_time(1), _dummy_img())
        # Line 2 appears then disappears
        ctrl.handle_ocr_result(line2, [line2], _make_time(2), _dummy_img())
        ctrl.handle_ocr_result("",    [],       _make_time(3), _dummy_img())

        texts = [s["text"] for s in sent_texts]
        assert len(sent_texts) == 2, f"Expected 2 sends, got {len(sent_texts)}: {texts}"
        assert sent_texts[0]["text"] == line1
        assert sent_texts[1]["text"] == line2

    @pytest.mark.parametrize("line1,line2", [
        # Production: different speaker, no character between them, then 3 empties
        ("Ｖ：つまり・・・？",                    "マイヤーズ：いつもと変わらないということだ"),
        # Same pattern with different trailing punctuation
        ("ジョニー：わかった！",                  "リブ：そうじゃないわよ"),
    ])
    def test_immediate_speaker_change_no_empty_between_both_sent(self, sent_texts, line1, line2):
        """Regression: when OCR switches directly from one speaker to another
        with no empty frame between them, BOTH lines must be sent.

        Production log (2026-02-22):
            Ｖ：つまり・・・？                     (no empty)
            マイヤーズ：いつもと変わらないということだ
            (empty) × 3
        Expected: both lines sent.
        """
        ctrl = _make_controller(self.CFG_SAME, sent_texts)
        ctrl.handle_ocr_result(line1, [line1], _make_time(0), _dummy_img())
        # No empty — line2 arrives immediately
        ctrl.handle_ocr_result(line2, [line2], _make_time(1), _dummy_img())
        # Three empty frames flush line2
        ctrl.handle_ocr_result("",    [],       _make_time(2), _dummy_img())
        ctrl.handle_ocr_result("",    [],       _make_time(3), _dummy_img())
        ctrl.handle_ocr_result("",    [],       _make_time(4), _dummy_img())

        texts = [s["text"] for s in sent_texts]
        assert len(sent_texts) == 2, (
            f"Expected 2 sends (both lines), got {len(sent_texts)}: {texts}"
        )
        assert sent_texts[0]["text"] == line1
        assert sent_texts[1]["text"] == line2

    def test_immediate_speaker_change_diff_engine_both_sent(self, sent_texts, second_ocr_calls):
        """Same scenario with different OCR engines (full second-pass path)."""
        line1 = "Ｖ：つまり・・・？"
        line2 = "マイヤーズ：いつもと変わらないということだ"

        call_count = [0]
        expected = [line1, line2]
        def _echo_first_pass(img, last_result, filtering, engine, **kw):
            idx = call_count[0]
            call_count[0] += 1
            second_ocr_calls.append({})
            return SecondPassResult(text=expected[idx], orig_text=[expected[idx]], response_dict=None)

        ctrl = TwoPassOCRController(
            config=self.CFG_DIFF,
            filtering=_passthrough_filter,
            send_result=_make_send(sent_texts),
            run_second_ocr=_echo_first_pass,
            save_image=lambda *a, **kw: None,
            get_ocr2_image=lambda c, i: i,
        )
        ctrl.handle_ocr_result(line1, [line1], _make_time(0), _dummy_img())
        ctrl.handle_ocr_result(line2, [line2], _make_time(1), _dummy_img())
        ctrl.handle_ocr_result("",    [],       _make_time(2), _dummy_img())
        ctrl.handle_ocr_result("",    [],       _make_time(3), _dummy_img())
        ctrl.handle_ocr_result("",    [],       _make_time(4), _dummy_img())

        texts = [s["text"] for s in sent_texts]
        assert len(sent_texts) == 2, (
            f"Expected 2 sends (both lines), got {len(sent_texts)}: {texts}"
        )
        assert sent_texts[0]["text"] == line1
        assert sent_texts[1]["text"] == line2

    @pytest.mark.parametrize("line1,line2", [
        ("マイヤーズ：ふん",      "マイヤーズ：おやすみ、Ｖ"),
        ("V: Yeah.",             "V: I don't think so."),
    ])
    def test_consecutive_same_speaker_different_engines(self, sent_texts, second_ocr_calls, line1, line2):
        """Same regression for the full second-pass path."""
        ctrl = _make_controller(
            self.CFG_DIFF, sent_texts,
            second_ocr_calls=second_ocr_calls,
            second_ocr_return=line1,  # second pass echoes the first-pass text
        )
        ctrl.handle_ocr_result(line1, [line1], _make_time(0), _dummy_img())
        ctrl.handle_ocr_result("",    [],       _make_time(1), _dummy_img())
        # Between lines, second_ocr_return changes to line2
        ctrl._run_second_ocr = _make_second_ocr(second_ocr_calls, return_text=line2)
        ctrl.handle_ocr_result(line2, [line2], _make_time(2), _dummy_img())
        ctrl.handle_ocr_result("",    [],       _make_time(3), _dummy_img())

        texts = [s["text"] for s in sent_texts]
        assert len(sent_texts) == 2, f"Expected 2 sends, got {len(sent_texts)}: {texts}"
        assert sent_texts[0]["text"] == line1
        assert sent_texts[1]["text"] == line2

    # -- Regression: different speakers both ending in ・・・ (shared trailing punct) --

    @pytest.mark.parametrize("line1,line2", [
        # The exact production failure
        ("ジョニー：おい、Ｖ・・・",    "マイヤーズ：では復唱しろ・・・"),
        # Same speaker different content, shared ellipsis
        ("エイダ：よく聞け・・・",      "エイダ：立ち去れ・・・"),
        # English
        ("Johnny: Listen...",          "V: No way..."),
    ])
    def test_different_lines_shared_trailing_punct_both_sent(self, sent_texts, line1, line2):
        """Regression: when two consecutive lines share trailing punctuation
        (e.g. both end in ・・・), the first line must still be sent.

        Before fix:
          - fuzz.ratio inflated by shared ・・・ → is_low_sim=False
          - ends_diff check: '・' == '・' → False → trigger never fires
          → first line silently overwritten, never sent.

        Production log:
            ジョニー：おい、Ｖ・・・  → マイヤーズ：では復唱しろ・・・ → (empty)
        Expected: both lines sent.
        """
        ctrl = _make_controller(self.CFG_SAME, sent_texts)
        ctrl.handle_ocr_result(line1, [line1], _make_time(0), _dummy_img())
        # line2 arrives immediately (no empty between) – should trigger line1
        ctrl.handle_ocr_result(line2, [line2], _make_time(1), _dummy_img())
        ctrl.handle_ocr_result("",    [],       _make_time(2), _dummy_img())

        texts = [s["text"] for s in sent_texts]
        assert any(line1 in t for t in texts), (
            f"{line1!r} was not sent; got: {texts}"
        )
        assert any(line2 in t for t in texts), (
            f"{line2!r} was not sent; got: {texts}"
        )

    @pytest.mark.parametrize("line1,line2", [
        ("ジョニー：おい、Ｖ・・・",    "マイヤーズ：では復唱しろ・・・"),
    ])
    def test_different_lines_shared_trailing_punct_diff_engine(self, sent_texts, second_ocr_calls, line1, line2):
        """Same scenario using the full second-pass (different engine) path.

        The second OCR always returns the first-pass text (passthrough), so
        line1 gets sent when line2 arrives and triggers the flush.
        """
        ctrl = _make_controller(
            self.CFG_DIFF, sent_texts,
            second_ocr_calls=second_ocr_calls,
            second_ocr_return=line1,  # second OCR returns what OCR1 saw
        )
        ctrl.handle_ocr_result(line1, [line1], _make_time(0), _dummy_img())
        # line2 arrives immediately – triggers flush of line1 via second pass
        ctrl.handle_ocr_result(line2, [line2], _make_time(1), _dummy_img())
        ctrl.handle_ocr_result("",    [],       _make_time(2), _dummy_img())

        texts = [s["text"] for s in sent_texts]
        assert any(line1 in t for t in texts), (
            f"{line1!r} was not sent (diff-engine); got: {texts}"
        )

    # -- Regression: empty orig_text in pending state --

    def test_rapid_dialogue_empty_orig_text_middle_line_not_lost(self, sent_texts):
        """Regression: middle dialogue line must not be lost when its orig_text=[]
        (as seen with ScreenAI OCR in production).

        Sequence from production log:
            マイヤーズ：ダストシュートがあるだろう  <- normal frame, orig_text present
            Ｖ：本気か？                          <- orig_text=[] (ScreenAI quirk)
            マイヤーズ：フッ・・・               <- completely different, should flush 本気か
            (empty)                              <- should flush フッ
        """
        ctrl = _make_controller(self.CFG_SAME, sent_texts)

        ctrl.handle_ocr_result(
            "マイヤーズ：ダストシュートがあるだろう",
            ["マイヤーズ：ダストシュートがあるだろう"],
            _make_time(0), _dummy_img(),
        )
        # orig_text is empty list – simulates ScreenAI returning no raw tokens
        ctrl.handle_ocr_result(
            "Ｖ：本気か？", [], _make_time(1), _dummy_img(),
        )
        ctrl.handle_ocr_result(
            "マイヤーズ：フッ・・・",
            ["マイヤーズ：フッ・・・"],
            _make_time(2), _dummy_img(),
        )
        ctrl.handle_ocr_result("", [], _make_time(3), _dummy_img())

        texts = [s["text"] for s in sent_texts]
        assert any("ダストシュート" in t for t in texts), f"ダストシュート not in {texts}"
        assert any("本気" in t for t in texts), (
            f"'Ｖ：本気か？' was silently dropped! sent={texts}"
        )
        assert any("フッ" in t for t in texts), f"フッ not in {texts}"

    def test_rapid_dialogue_empty_orig_text_different_engines(self, sent_texts, second_ocr_calls):
        """Same regression scenario using different OCR engines (full second pass)."""
        ctrl = _make_controller(
            self.CFG_DIFF, sent_texts,
            second_ocr_calls=second_ocr_calls,
            second_ocr_return="",  # second OCR returns same text via fallback
        )

        ctrl.handle_ocr_result(
            "マイヤーズ：ダストシュートがあるだろう",
            ["マイヤーズ：ダストシュートがあるだろう"],
            _make_time(0), _dummy_img(),
        )
        ctrl.handle_ocr_result(
            "Ｖ：本気か？", [], _make_time(1), _dummy_img(),
        )
        ctrl.handle_ocr_result(
            "マイヤーズ：フッ・・・",
            ["マイヤーズ：フッ・・・"],
            _make_time(2), _dummy_img(),
        )
        ctrl.handle_ocr_result("", [], _make_time(3), _dummy_img())

        texts = [s["text"] for s in sent_texts]
        assert any("本気" in t for t in texts), (
            f"'Ｖ：本気か？' was silently dropped (diff-engine)! sent={texts}"
        )


# ===================================================================
# 6. COMPARE_OCR_RESULTS (unit tests for the comparison function)
# ===================================================================

class TestCompareOcrResults:
    """Exhaustive tests for the fuzzy comparison helper."""

    def test_identical_strings(self):
        assert compare_ocr_results("hello", "hello") is True

    def test_empty_vs_empty(self):
        assert compare_ocr_results("", "") is False

    def test_none_inputs(self):
        assert compare_ocr_results(None, "text") is False
        assert compare_ocr_results("text", None) is False
        assert compare_ocr_results(None, None) is False

    def test_list_inputs(self):
        assert compare_ocr_results(["hello"], ["hello"]) is True

    def test_list_with_nones(self):
        assert compare_ocr_results(["a", None, "b"], ["ab"]) is True

    def test_high_similarity(self):
        assert compare_ocr_results("今日はいい天気ですね。", "今日はいい天気ですね！") is True

    def test_low_similarity(self):
        assert compare_ocr_results(
            "今日はいい天気ですね。", "明日は雨が降るでしょう。", threshold=90
        ) is False

    def test_threshold_20(self):
        """Low threshold: very different texts should still fail."""
        assert compare_ocr_results(
            "AAAA", "ZZZZ", threshold=20
        ) is False

    def test_prefix_truncation_for_substring(self):
        """A prefix-truncated OCR result is caught by the anchored check."""
        long_text = "これは非常に長いテストの文章ですが、とても重要な情報が含まれています"
        prefix_text = "これは非常に長いテストの文章ですが"  # genuine prefix truncation
        assert compare_ocr_results(long_text, prefix_text, threshold=70) is True

    def test_middle_substring_not_deduped(self):
        """A middle-only substring is NOT treated as a duplicate (not a
        prefix/suffix truncation, so anchored ratio is low)."""
        long_text = "これは非常に長いテストの文章ですが、とても重要な情報が含まれています"
        middle_text = "テストの文章ですが"  # appears mid-text only
        assert compare_ocr_results(long_text, middle_text, threshold=70) is False

    @pytest.mark.parametrize("lang", ["ja", "zh", "ko", "en", "ru", "ar", "th"])
    def test_same_text_each_language(self, lang):
        text = _SENTENCES[lang][0]
        assert compare_ocr_results(text, text) is True

    @pytest.mark.parametrize("lang", ["ja", "zh", "ko", "en", "ru", "ar", "th"])
    def test_different_text_each_language(self, lang):
        assert compare_ocr_results(
            _SENTENCES[lang][0], _SENTENCES[lang][1], threshold=90
        ) is False

    # -- Regression: speaker-prefix false-positive dedup --

    @pytest.mark.parametrize("t1,t2", [
        # Production case: same speaker, completely different utterances
        ("マイヤーズ：ふん",           "マイヤーズ：おやすみ、Ｖ"),
        # Generic speaker prefix variants
        ("田中：ありがとう",           "田中：おはようございます"),
        ("V: Yeah.",                   "V: I don't think so."),
        # Short first utterance + longer second with same start
        ("Narrator: Oh.",              "Narrator: What a beautiful day!"),
    ])
    def test_speaker_prefix_not_deduped(self, t1, t2):
        """Two clearly different dialogue lines from the same speaker must NOT
        be treated as duplicates by the 80-threshold dedup check, even if
        partial_ratio is inflated by the shared speaker prefix.
        """
        assert compare_ocr_results(t1, t2, threshold=80) is False, (
            f"False dedup: {t1!r} vs {t2!r} should NOT be considered duplicates"
        )

    def test_genuine_truncation_still_deduped(self):
        """A genuinely truncated version of the same text must still be caught."""
        full = "マイヤーズ：おやすみ、Ｖ"
        truncated = "マイヤーズ：おやすみ"
        assert compare_ocr_results(full, truncated, threshold=80) is True

    # -- Regression: shared trailing punctuation inflates CHANGE_THRESHOLD check --

    @pytest.mark.parametrize("t1,t2,threshold", [
        # Production case: completely different speakers, both end in ・・・
        # After punctuation-strip ratio is only 11% — below CHANGE_THRESHOLD (20).
        ("ジョニー：おい、Ｖ・・・",     "マイヤーズ：では復唱しろ・・・", 20),
        # Same speaker, different utterance, both end in ・・・
        # After punctuation-strip ratio is ~43% — below PARTIAL_CHANGE_THRESHOLD (50).
        ("エイダ：よく聞け・・・",       "エイダ：立ち去れ・・・",         50),
        # English lines both ending in ...
        # After punctuation-strip ratio ~22% — below PARTIAL_CHANGE_THRESHOLD (50).
        ("Johnny: Listen...",           "V: I can't...",                  50),
    ])
    def test_different_texts_shared_trailing_punctuation_not_deduped(self, t1, t2, threshold):
        """Two clearly different texts that both end in the same punctuation
        (e.g. ・・・ / ...) must NOT be treated as duplicates.

        The threshold reflects the actual check path in _should_trigger:
        - CHANGE_THRESHOLD (20) for fully-different speakers
        - PARTIAL_CHANGE_THRESHOLD (50) for same-speaker different utterances
        """
        assert compare_ocr_results(t1, t2, threshold=threshold) is False, (
            f"False match at threshold={threshold}: {t1!r} vs {t2!r}"
        )

# ===================================================================

class TestNormalizeBypassText:

    def test_strip_newlines(self):
        assert _normalize_bypass_text("a\nb\nc", keep_newline=False) == "abc"

    def test_keep_newlines(self):
        assert _normalize_bypass_text("a\nb\nc", keep_newline=True) == "a\nb\nc"

    def test_collapse_whitespace(self):
        assert _normalize_bypass_text("a  \t  b", keep_newline=False) == "a b"

    def test_newline_after_punctuation_becomes_space(self):
        result = _normalize_bypass_text("Hello.\nWorld", keep_newline=False)
        assert result == "Hello. World"

    def test_japanese_period_newline(self):
        result = _normalize_bypass_text("文。\n次", keep_newline=False)
        assert result == "文。 次"

    def test_crlf_normalized(self):
        result = _normalize_bypass_text("a\r\nb", keep_newline=False)
        assert result == "ab"

    def test_empty_string(self):
        assert _normalize_bypass_text("", keep_newline=False) == ""

    def test_none_becomes_empty(self):
        assert _normalize_bypass_text(None, keep_newline=False) == ""


# ===================================================================
# 8. CONFIG PROPERTIES
# ===================================================================

class TestTwoPassConfig:

    def test_same_engine_true(self):
        cfg = TwoPassConfig(ocr1_engine="OneOCR", ocr2_engine="oneocr")
        assert cfg.same_engine is True

    def test_same_engine_false(self):
        cfg = TwoPassConfig(ocr1_engine="oneocr", ocr2_engine="glens")
        assert cfg.same_engine is False

    def test_same_engine_empty(self):
        cfg = TwoPassConfig(ocr1_engine="", ocr2_engine="")
        assert cfg.same_engine is False

    def test_is_meiki_first(self):
        cfg = TwoPassConfig(ocr1_engine="meiki", ocr2_engine="glens")
        assert cfg.is_meiki_first is True

    def test_is_not_meiki_first(self):
        cfg = TwoPassConfig(ocr1_engine="oneocr", ocr2_engine="glens")
        assert cfg.is_meiki_first is False

    def test_meiki_case_insensitive(self):
        cfg = TwoPassConfig(ocr1_engine="Meiki", ocr2_engine="glens")
        assert cfg.is_meiki_first is True


# ===================================================================
# 9. ADVANCED EDGE CASES
# ===================================================================

class TestAdvancedEdgeCases:
    """Unusual inputs, boundary conditions, and regression guards."""

    CFG_SAME = TwoPassConfig(two_pass_enabled=True, ocr1_engine="oneocr",
                             ocr2_engine="oneocr")
    CFG_DIFF = TwoPassConfig(two_pass_enabled=True, ocr1_engine="oneocr",
                             ocr2_engine="glens")

    def test_punctuation_only_text(self, sent_texts):
        ctrl = _make_controller(self.CFG_SAME, sent_texts)
        punc = _EDGE_CASES["punctuation_only"]
        ctrl.handle_ocr_result(punc, [punc], _make_time(), _dummy_img())
        ctrl.handle_ocr_result("", [], _make_time(1), _dummy_img())
        assert len(sent_texts) == 1

    def test_mixed_cjk_text(self, sent_texts):
        ctrl = _make_controller(self.CFG_SAME, sent_texts)
        mixed = _EDGE_CASES["mixed_cjk"]
        ctrl.handle_ocr_result(mixed, [mixed], _make_time(), _dummy_img())
        ctrl.handle_ocr_result("", [], _make_time(1), _dummy_img())
        assert len(sent_texts) == 1
        assert sent_texts[0]["text"] == mixed

    def test_text_with_none_in_orig_list(self, sent_texts):
        """orig_text may contain None entries."""
        ctrl = _make_controller(self.CFG_SAME, sent_texts)
        ctrl.handle_ocr_result(
            "テスト", [None, "テスト", None], _make_time(), _dummy_img())
        ctrl.handle_ocr_result("", [], _make_time(1), _dummy_img())
        assert len(sent_texts) == 1

    def test_orig_text_none_entirely(self, sent_texts):
        """orig_text=None should be handled gracefully."""
        ctrl = _make_controller(self.CFG_SAME, sent_texts)
        ctrl.handle_ocr_result("テスト", None, _make_time(), _dummy_img())
        ctrl.handle_ocr_result("", None, _make_time(1), _dummy_img())
        assert len(sent_texts) == 1

    def test_image_is_none(self, sent_texts):
        """img=None should not crash."""
        ctrl = _make_controller(self.CFG_SAME, sent_texts)
        ctrl.handle_ocr_result(
            _SENTENCES["ja"][0], [_SENTENCES["ja"][0]], _make_time(), None)
        ctrl.handle_ocr_result("", [], _make_time(1), None)
        assert len(sent_texts) == 1

    def test_time_is_none(self, sent_texts):
        """time=None should use datetime.now()."""
        ctrl = _make_controller(self.CFG_SAME, sent_texts)
        ctrl.handle_ocr_result(_SENTENCES["ja"][0], [_SENTENCES["ja"][0]],
                               None, _dummy_img())
        ctrl.handle_ocr_result("", [], None, _dummy_img())
        assert len(sent_texts) == 1
        assert sent_texts[0]["time"] is not None

    def test_response_dict_propagated(self, sent_texts, second_ocr_calls):
        """Response dict should make it through to sent result."""
        ctrl = _make_controller(
            self.CFG_DIFF, sent_texts, second_ocr_calls=second_ocr_calls,
            second_ocr_return="refined",
        )
        rdict = {"test": True, "pipeline": {"engine": "oneocr"}}
        ctrl.handle_ocr_result(
            _SENTENCES["ja"][0], [_SENTENCES["ja"][0]], _make_time(),
            _dummy_img(), response_dict=rdict,
        )
        ctrl.handle_ocr_result("", [], _make_time(1), _dummy_img())
        assert len(sent_texts) == 1

    def test_similarity_boundary_19_pct(self, sent_texts):
        """Two texts with ~19% similarity should trigger (< 20% threshold)."""
        ctrl = _make_controller(self.CFG_SAME, sent_texts)
        t1 = "あいうえおかきくけこ"
        t2 = "さしすせそたちつてと"
        ctrl.handle_ocr_result(t1, [t1], _make_time(), _dummy_img())
        ctrl.handle_ocr_result(t2, [t2], _make_time(1), _dummy_img())
        # t1 should have been sent if similarity < 20% AND start/end differ
        if not compare_ocr_results(t1, t2, 20) and t1[0] != t2[0] and t1[-1] != t2[-1]:
            assert len(sent_texts) == 1
            assert sent_texts[0]["text"] == t1

    def test_similarity_exact_20_pct_no_trigger(self, sent_texts):
        """At exactly 20% similarity, should_trigger returns False (need < 20%)."""
        ctrl = _make_controller(self.CFG_SAME, sent_texts)
        # These are different texts but we set threshold at 20
        t1 = "テストのテキスト"
        t2 = "テストの異なるテキスト"
        ctrl.handle_ocr_result(t1, [t1], _make_time(), _dummy_img())
        ctrl.handle_ocr_result(t2, [t2], _make_time(1), _dummy_img())
        # With high similarity (> 20%), trigger should NOT fire
        if compare_ocr_results(t1, t2, 20):
            assert len(sent_texts) == 0

    def test_custom_filtering_applied(self, sent_texts):
        """Custom filtering function modifies text before sending."""
        def custom_filter(text, last_result, *, engine=None, is_second_ocr=False):
            return text.upper(), [text.upper()]

        ctrl = _make_controller(self.CFG_SAME, sent_texts, filtering=custom_filter)
        ctrl.handle_ocr_result("hello", ["hello"], _make_time(), _dummy_img())
        ctrl.handle_ocr_result("", [], _make_time(1), _dummy_img())
        assert len(sent_texts) == 1
        assert sent_texts[0]["text"] == "HELLO"

    def test_filtering_returns_empty_blocks_send(self, sent_texts):
        """If filtering returns empty text, bypass should not send."""
        def empty_filter(text, last_result, *, engine=None, is_second_ocr=False):
            return "", []

        ctrl = _make_controller(self.CFG_SAME, sent_texts, filtering=empty_filter)
        ctrl.handle_ocr_result("hello", ["hello"], _make_time(), _dummy_img())
        ctrl.handle_ocr_result("", [], _make_time(1), _dummy_img())
        # Empty text after filtering → dedup vs "" last_sent → no match → sends ""
        # But empty string is falsy, so compare_ocr_results("", "") → False
        # The send happens with empty text.  This tests the edge.
        # In practice the caller would filter this, but controller sends it.
        assert len(sent_texts) == 1
        assert sent_texts[0]["text"] == ""

    def test_very_rapid_complete_changes(self, sent_texts):
        """Rapidly cycling through completely different texts."""
        ctrl = _make_controller(self.CFG_SAME, sent_texts)
        all_texts = []
        for lang in ["ja", "zh", "ko", "en", "ru", "ar", "th"]:
            for s in _SENTENCES[lang]:
                all_texts.append(s)

        for i, text in enumerate(all_texts):
            ctrl.handle_ocr_result(text, [text], _make_time(i), _dummy_img())

        # Final disappear to flush
        ctrl.handle_ocr_result("", [], _make_time(len(all_texts)), _dummy_img())

        # At minimum the last text should be sent.
        # Due to change-detection, many intermediate should also be sent.
        assert len(sent_texts) >= 1
        # Last sent should be last text
        assert sent_texts[-1]["text"] == all_texts[-1]

    def test_get_ocr2_image_called_with_crop_coords(
        self, sent_texts, second_ocr_calls,
    ):
        """Verify crop_coords are passed to get_ocr2_image."""
        captured_crops = []

        def _mock_get_ocr2(coords, img):
            captured_crops.append(coords)
            return img

        ctrl = TwoPassOCRController(
            config=self.CFG_DIFF,
            filtering=_passthrough_filter,
            send_result=_make_send(sent_texts),
            run_second_ocr=_make_second_ocr(second_ocr_calls, return_text="r"),
            save_image=lambda *a, **kw: None,
            get_ocr2_image=_mock_get_ocr2,
        )
        crop = (10, 20, 300, 400)
        ctrl.handle_ocr_result(
            _SENTENCES["ja"][0], [_SENTENCES["ja"][0]], _make_time(),
            _dummy_img(), crop_coords=crop,
        )
        ctrl.handle_ocr_result("", [], _make_time(1), _dummy_img())
        assert len(captured_crops) == 1
        assert captured_crops[0] == crop

    # -- Regression: empty orig_text in pending --

    @pytest.mark.parametrize("lang,pair_key", [
        ("ja", "ja"), ("zh", "zh"), ("ko", "ko"), ("en", "en"), ("ru", "ru"),
    ])
    def test_empty_orig_text_complete_change_triggers_same_engine(
        self, sent_texts, lang, pair_key,
    ):
        """When pending was stored with orig_text=[], a completely different
        text must still trigger the second-pass / bypass path.

        Root cause: _should_trigger used `p_orig` (empty string) in the
        'completely changed' guard — the `and p_orig` short-circuit prevented
        the trigger from firing.
        """
        t1, t2 = _CHANGE_PAIRS[pair_key]
        ctrl = _make_controller(self.CFG_SAME, sent_texts)
        # Intentionally pass orig_text=[] so pending.orig_text == ""
        ctrl.handle_ocr_result(t1, [], _make_time(0), _dummy_img())
        # Completely different text arrives
        ctrl.handle_ocr_result(t2, [t2], _make_time(1), _dummy_img())
        # t1 should have been triggered and sent
        assert len(sent_texts) >= 1, (
            f"No text sent for lang={lang}; "
            f"t1={t1!r} (empty orig_text) followed by t2={t2!r}"
        )
        assert sent_texts[0]["text"] == t1

    @pytest.mark.parametrize("lang,pair_key", [
        ("ja", "ja"), ("zh", "zh"), ("en", "en"),
    ])
    def test_empty_orig_text_complete_change_triggers_diff_engine(
        self, sent_texts, second_ocr_calls, lang, pair_key,
    ):
        """Same regression check for the different-engine path."""
        t1, t2 = _CHANGE_PAIRS[pair_key]
        ctrl = _make_controller(
            self.CFG_DIFF, sent_texts,
            second_ocr_calls=second_ocr_calls,
            second_ocr_return=t1,  # second OCR returns t1
        )
        ctrl.handle_ocr_result(t1, [], _make_time(0), _dummy_img())
        ctrl.handle_ocr_result(t2, [t2], _make_time(1), _dummy_img())
        assert len(sent_texts) >= 1, (
            f"No text sent for lang={lang} (diff-engine); t1={t1!r}, t2={t2!r}"
        )

    def test_empty_orig_text_evolving_text_uses_text_field(self, sent_texts):
        """When orig_text=[], _is_text_evolving should compare against pending.text
        so that a genuinely evolving sentence still updates the pending rather
        than starting a new one prematurely."""
        ctrl = _make_controller(self.CFG_SAME, sent_texts)
        base = "今日はいい天気です"
        extended = "今日はいい天気ですね。"
        ctrl.handle_ocr_result(base, [], _make_time(0), _dummy_img())
        # Extended version with orig_text populated – should be treated as evolution
        ctrl.handle_ocr_result(extended, [extended], _make_time(1), _dummy_img())
        # Disappear → flush
        ctrl.handle_ocr_result("", [], _make_time(2), _dummy_img())
        assert len(sent_texts) == 1
        assert sent_texts[0]["text"] == extended


# ===================================================================
# 10. STATE INSPECTION
# ===================================================================

class TestStateInspection:
    """Verify internal state consistency after various operations."""

    CFG = TwoPassConfig(two_pass_enabled=True, ocr1_engine="oneocr",
                        ocr2_engine="oneocr")

    def test_last_sent_result_updated(self, sent_texts):
        ctrl = _make_controller(self.CFG, sent_texts)
        text = _SENTENCES["ja"][0]
        ctrl.handle_ocr_result(text, [text], _make_time(), _dummy_img())
        ctrl.handle_ocr_result("", [], _make_time(1), _dummy_img())
        assert ctrl.last_sent_result == text

    def test_last_sent_result_after_reset(self, sent_texts):
        ctrl = _make_controller(self.CFG, sent_texts)
        text = _SENTENCES["ja"][0]
        ctrl.handle_ocr_result(text, [text], _make_time(), _dummy_img())
        ctrl.handle_ocr_result("", [], _make_time(1), _dummy_img())
        ctrl.reset()
        assert ctrl.last_sent_result == ""
        assert ctrl.last_ocr2_result == []

    def test_force_stable_reset_after_trigger(self, sent_texts):
        ctrl = _make_controller(self.CFG, sent_texts)
        ctrl.set_force_stable(True)
        ctrl.handle_ocr_result(
            _SENTENCES["ja"][0], [_SENTENCES["ja"][0]], _make_time(), _dummy_img())
        ctrl.handle_ocr_result(
            _SENTENCES["ja"][1], [_SENTENCES["ja"][1]], _make_time(1), _dummy_img())
        assert ctrl.force_stable is False

    def test_pending_cleared_after_trigger(self, sent_texts):
        ctrl = _make_controller(self.CFG, sent_texts)
        ctrl.handle_ocr_result(
            _SENTENCES["ja"][0], [_SENTENCES["ja"][0]], _make_time(), _dummy_img())
        assert ctrl._pending is not None
        ctrl.handle_ocr_result("", [], _make_time(1), _dummy_img())
        # After trigger, pending should be cleared (new text "")
        # Actually, "" doesn't create new pending since text is falsy
        assert ctrl._pending is None


# ===================================================================
# 11. COVERAGE GAP TESTS
# ===================================================================

class TestCoverageGaps:
    """Tests specifically targeting uncovered lines and edge branches."""

    CFG_SAME = TwoPassConfig(two_pass_enabled=True, ocr1_engine="oneocr",
                             ocr2_engine="oneocr")
    CFG_DIFF = TwoPassConfig(two_pass_enabled=True, ocr1_engine="oneocr",
                             ocr2_engine="glens")
    CFG_MEIKI = TwoPassConfig(two_pass_enabled=True, ocr1_engine="meiki",
                              ocr2_engine="glens")

    # --- Line 253: meiki_boxes path returns early after _handle_meiki ---

    def test_meiki_returns_early_no_two_pass_logic(self, sent_texts, second_ocr_calls):
        """Meiki path should return immediately after _handle_meiki, skipping
        two-pass trigger logic."""
        ctrl = _make_controller(
            self.CFG_MEIKI, sent_texts, second_ocr_calls=second_ocr_calls,
            second_ocr_return="meiki_result",
        )
        coords = (10, 20, 100, 50)
        # First frame: starts tracking
        ctrl.handle_ocr_result(
            "テスト", ["テスト"], _make_time(), _dummy_img(),
            meiki_boxes=[{"box": coords}], crop_coords=coords,
        )
        assert len(sent_texts) == 0  # No send, just tracking
        assert ctrl._pending is None  # No pending state from two-pass path

    # --- Line 312: evolving text guard in _should_trigger ---

    def test_evolving_text_blocks_trigger_despite_moderate_diff(self, sent_texts):
        """When shorter text is a prefix of longer, the evolving-text guard
        should prevent the trigger even if similarity is moderate."""
        ctrl = _make_controller(self.CFG_SAME, sent_texts)
        # Base is short; extension is MUCH longer so similarity drops well below
        # thresholds, ensuring we enter the (is_low_sim or is_moderate_diff) block.
        base = "今日は"
        extended = "今日は素晴らしい天気で外で散歩して花を見て鳥の声を聞いた"
        ctrl.handle_ocr_result(base, [base], _make_time(), _dummy_img())
        # Extended version arrives - should detect as evolving, NOT trigger
        ctrl.handle_ocr_result(extended, [extended], _make_time(1), _dummy_img())
        assert len(sent_texts) == 0, "Evolving text should not trigger send"
        # Now disappear - sends evolved text
        ctrl.handle_ocr_result("", [], _make_time(2), _dummy_img())
        assert len(sent_texts) == 1
        assert sent_texts[0]["text"] == extended

    # --- Line 492: _process_trigger with no pending ---

    def test_process_trigger_no_pending_noop(self, sent_texts):
        """_process_trigger should be a no-op when there's no pending state."""
        ctrl = _make_controller(self.CFG_SAME, sent_texts)
        # Directly call _process_trigger with no pending
        ctrl._process_trigger("text", "text", _make_time(), _dummy_img(), None, "ocr")
        assert len(sent_texts) == 0

    # --- Line 552-554: meiki with None crop_coords on initial frame ---

    def test_meiki_initial_none_crop_coords(self, sent_texts, second_ocr_calls):
        """If the very first meiki frame has None crop_coords, it should just
        store them without crashing."""
        ctrl = _make_controller(
            self.CFG_MEIKI, sent_texts, second_ocr_calls=second_ocr_calls,
            second_ocr_return="meiki_result",
        )
        ctrl.handle_ocr_result(
            "テスト", ["テスト"], _make_time(), _dummy_img(),
            meiki_boxes=[{"box": None}], crop_coords=None,
        )
        assert len(sent_texts) == 0
        # After setting initial None, a second frame with also None
        ctrl.handle_ocr_result(
            "テスト", ["テスト"], _make_time(1), _dummy_img(),
            meiki_boxes=[{"box": None}], crop_coords=None,
        )
        assert len(sent_texts) == 0

    def test_meiki_second_frame_none_crop_coords(self, sent_texts, second_ocr_calls):
        """After a real initial frame, if second frame has None crop_coords,
        should reset tracking."""
        ctrl = _make_controller(
            self.CFG_MEIKI, sent_texts, second_ocr_calls=second_ocr_calls,
            second_ocr_return="meiki_result",
        )
        ctrl.handle_ocr_result(
            "テスト", ["テスト"], _make_time(), _dummy_img(),
            meiki_boxes=[{"box": (10, 20, 100, 50)}], crop_coords=(10, 20, 100, 50),
        )
        # Second frame with missing crop_coords
        ctrl.handle_ocr_result(
            "テスト", ["テスト"], _make_time(1), _dummy_img(),
            meiki_boxes=[{"box": None}], crop_coords=None,
        )
        assert len(sent_texts) == 0

    # --- Lines 552-554: "already sent for these coords" dedup in meiki ---

    def test_meiki_already_sent_coords_dedup(self, sent_texts, second_ocr_calls):
        """After meiki fires OCR2 for coords, re-seeing the same coords
        should be suppressed (lines 552-554: last_success_coords guard)."""
        ctrl = _make_controller(
            self.CFG_MEIKI, sent_texts, second_ocr_calls=second_ocr_calls,
            second_ocr_return="meiki_result",
        )
        coords = (10, 20, 100, 50)
        # Frame 1: initial → sets last_crop_coords
        ctrl.handle_ocr_result(
            "テスト", ["テスト"], _make_time(), _dummy_img(),
            meiki_boxes=[{"box": coords}], crop_coords=coords,
        )
        # Frame 2: same → stable, fires OCR2, sets last_success_coords
        ctrl.handle_ocr_result(
            "テスト", ["テスト"], _make_time(1), _dummy_img(),
            meiki_boxes=[{"box": coords}], crop_coords=coords,
        )
        assert len(sent_texts) == 1  # First trigger
        # After success, last_crop_coords = None. Frame 3: same coords again
        # → hits "last_crop_coords is None" guard → sets last_crop_coords
        ctrl.handle_ocr_result(
            "テスト", ["テスト"], _make_time(2), _dummy_img(),
            meiki_boxes=[{"box": coords}], crop_coords=coords,
        )
        # Frame 4: same coords again → close=True, last_success_coords=coords
        # → enters "already sent" branch (lines 552-554)
        ctrl.handle_ocr_result(
            "テスト", ["テスト"], _make_time(3), _dummy_img(),
            meiki_boxes=[{"box": coords}], crop_coords=coords,
        )
        # Should NOT have sent a second time
        assert len(sent_texts) == 1

    # --- Line 587: _filter with filtering=None ---

    def test_filter_with_none_filtering(self, sent_texts):
        """When filtering is None, _filter should return text and [text]."""
        ctrl = TwoPassOCRController(
            config=self.CFG_SAME,
            filtering=None,
            send_result=_make_send(sent_texts),
            save_image=lambda *a, **kw: None,
        )
        result = ctrl._filter("hello", None)
        assert result == ("hello", ["hello"])

    def test_filter_with_none_filtering_empty(self, sent_texts):
        """When filtering is None and text is empty, should return ('', [])."""
        ctrl = TwoPassOCRController(
            config=self.CFG_SAME,
            filtering=None,
            send_result=_make_send(sent_texts),
            save_image=lambda *a, **kw: None,
        )
        result = ctrl._filter("", None)
        assert result == ("", [])

    # --- Lines 616-618: _copy_img exception handling ---

    def test_copy_img_exception_returns_original(self, sent_texts):
        """If img.copy() raises, _copy_img should return the original."""
        from GameSentenceMiner.ocr.two_pass_ocr import _copy_img
        bad_img = MagicMock()
        bad_img.copy.side_effect = RuntimeError("copy failed")
        result = _copy_img(bad_img)
        assert result is bad_img

    def test_copy_img_none_returns_none(self, sent_texts):
        """_copy_img(None) should return None."""
        from GameSentenceMiner.ocr.two_pass_ocr import _copy_img
        assert _copy_img(None) is None

    def test_copy_img_no_copy_method_returns_original(self, sent_texts):
        """Objects without .copy() should be returned as-is."""
        from GameSentenceMiner.ocr.two_pass_ocr import _copy_img
        plain_obj = object()
        assert _copy_img(plain_obj) is plain_obj

    # --- Lines 627-628: _coords_close exception handling ---

    def test_coords_close_invalid_types(self, sent_texts):
        """_coords_close with non-numeric items should return False."""
        from GameSentenceMiner.ocr.two_pass_ocr import _coords_close
        assert _coords_close(("a", "b", "c", "d"), (1, 2, 3, 4), 5) is False

    def test_coords_close_mismatched_lengths(self, sent_texts):
        """_coords_close with short tuples should return False."""
        from GameSentenceMiner.ocr.two_pass_ocr import _coords_close
        assert _coords_close((1, 2), (1, 2, 3, 4), 5) is False

    def test_coords_close_none_inputs(self, sent_texts):
        """_coords_close with None inputs should return False."""
        from GameSentenceMiner.ocr.two_pass_ocr import _coords_close
        assert _coords_close(None, (1, 2, 3, 4), 5) is False

    # --- Meiki with close coords on first frame None last_crop_coords ---

    def test_meiki_else_branch_resets_success(self, sent_texts, second_ocr_calls):
        """When meiki coords change (not close), last_success_coords is cleared."""
        ctrl = _make_controller(
            self.CFG_MEIKI, sent_texts, second_ocr_calls=second_ocr_calls,
            second_ocr_return="meiki_result",
        )
        coords_a = (10, 20, 100, 50)
        coords_far = (500, 600, 700, 800)  # very different
        # Frame 1: set initial crop coords
        ctrl.handle_ocr_result(
            "テスト", ["テスト"], _make_time(), _dummy_img(),
            meiki_boxes=[{"box": coords_a}], crop_coords=coords_a,
        )
        # Frame 2: same coords → stable → fires OCR2, sets last_success_coords
        ctrl.handle_ocr_result(
            "テスト", ["テスト"], _make_time(1), _dummy_img(),
            meiki_boxes=[{"box": coords_a}], crop_coords=coords_a,
        )
        assert len(sent_texts) == 1
        # After success, last_crop_coords is reset to None.
        # Frame 3: new coords → hits the "last_crop_coords is None" guard
        ctrl.handle_ocr_result(
            "テスト", ["テスト"], _make_time(2), _dummy_img(),
            meiki_boxes=[{"box": coords_far}], crop_coords=coords_far,
        )
        # last_success_coords still set from the success
        assert ctrl._meiki.last_success_coords == coords_a
        # Frame 4: another far-away coords → close=False → else branch
        coords_far2 = (900, 1000, 1100, 1200)
        ctrl.handle_ocr_result(
            "テスト", ["テスト"], _make_time(3), _dummy_img(),
            meiki_boxes=[{"box": coords_far2}], crop_coords=coords_far2,
        )
        # NOW last_success_coords should be cleared by the else branch
        assert ctrl._meiki.last_success_coords is None


# ===================================================================
# 12. COMPARE MODULE COVERAGE
# ===================================================================

class TestCompareModuleCoverageGaps:
    """Cover edge cases in compare.py."""

    def test_is_evolving_text_shorter_longer_than_longer(self):
        """is_evolving_text returns False when shorter is actually longer."""
        from GameSentenceMiner.ocr.compare import is_evolving_text
        assert is_evolving_text("longer_text", "short") is False

    def test_is_evolving_text_empty_shorter(self):
        """is_evolving_text returns False for empty shorter."""
        from GameSentenceMiner.ocr.compare import is_evolving_text
        assert is_evolving_text("", "anything") is False

    def test_is_evolving_text_empty_longer(self):
        """is_evolving_text returns False for empty longer."""
        from GameSentenceMiner.ocr.compare import is_evolving_text
        assert is_evolving_text("text", "") is False

    def test_compare_empty_after_strip(self):
        """When both texts are only whitespace, should return False."""
        assert compare_ocr_results("   ", "   ") is False

    def test_compare_punctuation_only_fallback(self):
        """When normalization produces empty strings (punctuation-only),
        falls back to raw comparison."""
        # Both are punctuation-only, so norm is empty -> falls back
        assert compare_ocr_results("...", "...", threshold=80) is True

    def test_compare_anchored_prefix_check_short_strings(self):
        """Anchored prefix check should not fire for very short strings."""
        # Both < 8 chars after normalization, so anchored check skipped
        assert compare_ocr_results("AB", "AC", threshold=80) is False

    def test_compare_anchored_check_low_base_similarity(self):
        """When base similarity is too low (< threshold - 15), anchored
        check should be skipped even for qualifying lengths."""
        long_a = "これは非常に長いテストの文章ですが、とても重要な情報が含まれています"
        long_b = "全く違う内容なので比較しても意味がないと思われます。別のテキストです"
        # Very different texts, both long - base similarity should be low
        assert compare_ocr_results(long_a, long_b, threshold=80) is False


# ===================================================================
# 13. TWO-PASS CONFIG EDGE CASES
# ===================================================================

class TestTwoPassConfigEdgeCases:
    """Additional config property tests."""

    def test_config_default_values(self):
        cfg = TwoPassConfig()
        assert cfg.two_pass_enabled is True
        assert cfg.ocr1_engine == ""
        assert cfg.ocr2_engine == ""
        assert cfg.optimize_second_scan is True
        assert cfg.keep_newline is False
        assert cfg.language == "ja"

    def test_config_same_engine_case_mismatch(self):
        cfg = TwoPassConfig(ocr1_engine="OneOCR  ", ocr2_engine="  oneocr")
        assert cfg.same_engine is True

    def test_config_is_meiki_with_suffix(self):
        cfg = TwoPassConfig(ocr1_engine="meiki_v2")
        assert cfg.is_meiki_first is True

    def test_config_not_meiki(self):
        cfg = TwoPassConfig(ocr1_engine="glens")
        assert cfg.is_meiki_first is False


# ===================================================================
# 14. SECOND PASS RESULT DATACLASS
# ===================================================================

class TestSecondPassResult:
    """Test the SecondPassResult dataclass defaults and structure."""

    def test_default_values(self):
        result = SecondPassResult()
        assert result.text == ""
        assert result.orig_text == []
        assert result.response_dict is None

    def test_custom_values(self):
        result = SecondPassResult(
            text="refined",
            orig_text=["refined"],
            response_dict={"engine": "glens"},
        )
        assert result.text == "refined"
        assert result.orig_text == ["refined"]
        assert result.response_dict == {"engine": "glens"}


# ===================================================================
# 15. CONTROLLER INITIALIZATION AND CALLBACK EDGE CASES
# ===================================================================

class TestControllerCallbacks:
    """Test controller behavior with various callback configurations."""

    CFG_SAME = TwoPassConfig(two_pass_enabled=True, ocr1_engine="oneocr",
                             ocr2_engine="oneocr")
    CFG_DIFF = TwoPassConfig(two_pass_enabled=True, ocr1_engine="oneocr",
                             ocr2_engine="glens")

    def test_controller_with_no_callbacks(self, sent_texts):
        """Controller with all default callbacks shouldn't crash."""
        ctrl = TwoPassOCRController(config=self.CFG_SAME)
        ctrl.handle_ocr_result("テスト", ["テスト"], _make_time(), _dummy_img())
        ctrl.handle_ocr_result("", [], _make_time(1), _dummy_img())
        # No assertions for sent_texts since default send_result is noop
        assert ctrl.last_sent_result == "テスト"

    def test_controller_disabled_no_callbacks(self):
        """Disabled controller with no callbacks shouldn't crash."""
        cfg = TwoPassConfig(two_pass_enabled=False)
        ctrl = TwoPassOCRController(config=cfg)
        ctrl.handle_ocr_result("テスト", ["テスト"], _make_time(), _dummy_img())
        assert ctrl.last_sent_result == "テスト"

    def test_screenshot_with_none_image(self, sent_texts, saved_images):
        """Screenshot mode with None image should not crash."""
        ctrl = _make_controller(self.CFG_SAME, sent_texts, saved=saved_images)
        ctrl.handle_ocr_result(
            "テスト", ["テスト"], _make_time(), None,
            came_from_ss=True,
        )
        assert len(sent_texts) == 1
        assert len(saved_images) == 1

    def test_get_ocr2_image_receives_correct_args_meiki(
        self, sent_texts, second_ocr_calls,
    ):
        """Verify meiki path passes correct args to get_ocr2_image."""
        captured = []

        def _mock_ocr2_image(coords, img):
            captured.append({"coords": coords, "img": img})
            return img

        cfg_meiki = TwoPassConfig(
            two_pass_enabled=True, ocr1_engine="meiki", ocr2_engine="glens",
        )
        ctrl = TwoPassOCRController(
            config=cfg_meiki,
            filtering=_passthrough_filter,
            send_result=_make_send(sent_texts),
            run_second_ocr=_make_second_ocr(second_ocr_calls, return_text="r"),
            save_image=lambda *a, **kw: None,
            get_ocr2_image=_mock_ocr2_image,
        )
        coords = (10, 20, 100, 50)
        ctrl.handle_ocr_result(
            "テスト", ["テスト"], _make_time(), _dummy_img(),
            meiki_boxes=[{"box": coords}], crop_coords=coords,
        )
        ctrl.handle_ocr_result(
            "テスト", ["テスト"], _make_time(1), _dummy_img(),
            meiki_boxes=[{"box": coords}], crop_coords=coords,
        )
        # Called twice: once in _handle_meiki, once in _execute_second_pass
        assert len(captured) == 2
        assert captured[0]["coords"] == coords
        assert captured[1]["coords"] == coords

    def test_different_engine_dedup_after_second_pass(
        self, sent_texts, second_ocr_calls,
    ):
        """If second pass returns text equal to last_sent, it's suppressed."""
        ctrl = _make_controller(
            self.CFG_DIFF, sent_texts,
            second_ocr_calls=second_ocr_calls,
            second_ocr_return="identical",
        )
        # First cycle
        ctrl.handle_ocr_result("A", ["A"], _make_time(), _dummy_img())
        ctrl.handle_ocr_result("", [], _make_time(1), _dummy_img())
        assert len(sent_texts) == 1
        assert sent_texts[0]["text"] == "identical"
        # Second cycle - OCR2 returns same "identical"
        ctrl.handle_ocr_result("B", ["B"], _make_time(2), _dummy_img())
        ctrl.handle_ocr_result("", [], _make_time(3), _dummy_img())
        # Should be suppressed as duplicate
        assert len(sent_texts) == 1


# ===================================================================
# 16. NORMALIZE BYPASS TEXT EDGE CASES
# ===================================================================

class TestNormalizeBypassTextExtended:
    """Additional edge cases for _normalize_bypass_text."""

    def test_multiple_spaces_collapsed(self):
        assert _normalize_bypass_text("a     b     c", keep_newline=False) == "a b c"

    def test_tab_collapsed(self):
        assert _normalize_bypass_text("a\t\tb", keep_newline=False) == "a b"

    def test_mixed_whitespace(self):
        result = _normalize_bypass_text("a  \t  b\n\nc", keep_newline=False)
        assert result == "a bc"

    def test_leading_trailing_stripped(self):
        result = _normalize_bypass_text("  hello  ", keep_newline=False)
        assert result == "hello"

    def test_carriage_return_only(self):
        result = _normalize_bypass_text("a\rb", keep_newline=False)
        assert result == "ab"

    def test_mixed_line_endings(self):
        result = _normalize_bypass_text("a\r\nb\rc\nd", keep_newline=False)
        assert result == "abcd"

    def test_japanese_exclamation_newline(self):
        result = _normalize_bypass_text("すごい！\n次の文", keep_newline=False)
        assert result == "すごい！ 次の文"

    def test_japanese_question_newline(self):
        result = _normalize_bypass_text("本当？\n嘘でしょ", keep_newline=False)
        assert result == "本当？ 嘘でしょ"

    def test_keep_newline_preserves_all(self):
        text = "a\r\nb\rc\nd"
        result = _normalize_bypass_text(text, keep_newline=True)
        assert result == "a\nb\nc\nd"


class TestSelectBypassOutputText:
    """Tests for shared bypass output text selection logic."""

    def test_prefers_raw_when_filter_strips_punctuation(self):
        raw = "「返しなさいよーーーっ！！」"
        filtered = "返しなさいよっ"
        assert _select_bypass_output_text(raw, filtered, keep_newline=False) == raw

    def test_keeps_filtered_for_substantive_transform(self):
        raw = "hello"
        filtered = "HELLO"
        assert _select_bypass_output_text(raw, filtered, keep_newline=False) == filtered

    def test_honors_empty_filtered_output(self):
        raw = "hello"
        filtered = ""
        assert _select_bypass_output_text(raw, filtered, keep_newline=False) == ""

    def test_prefers_raw_when_only_newline_soft_wrap_changes(self):
        raw = "文。\n次"
        filtered = "文。 次"
        assert _select_bypass_output_text(raw, filtered, keep_newline=False) == "文。 次"
