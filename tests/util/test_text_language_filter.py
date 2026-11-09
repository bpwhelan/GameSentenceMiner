from types import SimpleNamespace

import pytest

from GameSentenceMiner.util import text_processing
from GameSentenceMiner.util.config.configuration import TextProcessing


def filter_config(mode="blocks", **overrides):
    return TextProcessing.from_dict(
        {
            "language_filter": True,
            "language_filter_config": {"mode": mode},
            "remove_repeated_lines_v2": False,
            **overrides,
        }
    )


@pytest.mark.parametrize(
    "mode,expected",
    [
        ("blocks", "Speaker: 「今日はHPが10回復した！」 Next\n次の台詞。"),
        ("trim", "「今日はHPが10回復した！」\n次の台詞。"),
        ("strict", "今日はが回復した次の台詞"),
    ],
)
def test_filter_strengths_in_processing_and_preview(mode, expected):
    source = "MENU\nSpeaker: 「今日はHPが10回復した！」 Next\n123\n次の台詞。\nSAVE"
    config = filter_config(mode)

    assert text_processing.apply_text_processing(source, config, target_language="ja") == expected
    assert text_processing.preview_text_processing_request(
        {"text": source, "config": config.to_dict(), "target_language": "ja"}
    ) == {"result": expected}


@pytest.mark.parametrize("mode", ["blocks", "trim", "strict"])
@pytest.mark.parametrize("source", ["", "MENU\nSAVE", "123 😀\n!?", " \r\n\t"])
def test_no_target_text_returns_empty(mode, source):
    assert text_processing.apply_text_processing(source, filter_config(mode), target_language="ja") == ""


def test_block_mode_keeps_mixed_blocks_intact():
    source = "English prefix 日本語 HP 25 English suffix!"
    assert text_processing.apply_text_processing(source, filter_config(), target_language="ja") == source


def test_trim_keeps_interior_foreign_text_and_adjacent_punctuation():
    source = "Name: 「今日はHPが10増えた！」 Next 42\nDEBUG テストABCです。 END"
    assert text_processing.apply_text_processing(source, filter_config("trim"), target_language="ja") == (
        "「今日はHPが10増えた！」\nテストABCです。"
    )


def test_trim_removes_label_delimiters_and_does_not_keep_suffix_opening_brackets():
    assert (
        text_processing.apply_text_processing("Speaker:「日本語！」[Next]", filter_config("trim"), target_language="ja")
        == "「日本語！」"
    )


@pytest.mark.parametrize("mode", ["blocks", "trim"])
def test_block_modes_keep_original_separators_between_surviving_lines(mode):
    source = "MENU\r\n「こんにちは！」\r\nSAVE\r\n次の行。\r\nEXIT"
    assert text_processing.apply_text_processing(source, filter_config(mode), target_language="ja") == (
        "「こんにちは！」\r\n次の行。"
    )


def test_unicode_japanese_keeps_halfwidth_kana_long_vowels_and_rare_kanji():
    source = "abc ｽｰﾊﾟｰ スーパー 時々 か\u3099 𠮷野家 🙂"
    assert text_processing.apply_text_processing(source, filter_config("strict"), target_language="ja") == (
        "ｽｰﾊﾟｰスーパー時々か\u3099𠮷野家"
    )


@pytest.mark.parametrize(
    "language,source,expected",
    [
        ("ko", "MENU\n안녕하세요!\n日本語", "안녕하세요!"),
        ("zh-TW", "MENU\n你好。\nカタカナ", "你好。"),
        ("uk", "MENU\nПривіт!\n日本語", "Привіт!"),
        ("el", "MENU\nΕλληνικά!", "Ελληνικά!"),
        ("ar", "MENU\nمرحبا!", "مرحبا!"),
        ("he", "MENU\nשלום!", "שלום!"),
        ("th", "MENU\nสวัสดี!", "สวัสดี!"),
        ("hi", "MENU\nनमस्ते!", "नमस्ते!"),
        ("en-US", "日本語\nHello!", "Hello!"),
        ("fr", "日本語\nÉcoute le café!", "Écoute le café!"),
    ],
)
def test_filter_uses_target_writing_system(language, source, expected):
    assert text_processing.apply_text_processing(source, filter_config(), target_language=language) == expected


def test_strict_keeps_decomposed_accents_without_normalizing_the_text():
    assert (
        text_processing.apply_text_processing("日本語 Cafe\u0301! 123", filter_config("strict"), target_language="fr")
        == "Cafe\u0301"
    )


def test_disabled_filter_does_not_change_text():
    source = "MENU\n日本語\nNext"
    assert (
        text_processing.apply_text_processing(
            source, filter_config("strict", language_filter=False), target_language="ja"
        )
        == source
    )


def test_live_processing_and_preview_follow_the_active_profile_language(monkeypatch):
    profile = SimpleNamespace(general=SimpleNamespace(target_language="ko"))
    monkeypatch.setattr(text_processing, "get_config", lambda: profile)
    config = filter_config()
    source = "日本語\n한국어"

    assert text_processing.apply_text_processing(source, config) == "한국어"
    assert text_processing.preview_text_processing_request({"text": source, "config": config.to_dict()}) == {
        "result": "한국어"
    }
    profile.general.target_language = "ja"
    assert text_processing.apply_text_processing(source, config) == "日本語"


def test_filter_respects_pipeline_order():
    config = filter_config(processor_order=["language_filter", "remove_newlines"], remove_newlines=True)
    source = "MENU\n日本語"
    assert text_processing.apply_text_processing(source, config, target_language="ja") == "日本語"
    config.processor_order.reverse()
    assert text_processing.apply_text_processing(source, config, target_language="ja") == "MENU日本語"


def test_legacy_pipeline_gains_disabled_filter_before_line_break_removal():
    config = TextProcessing.from_dict(
        {
            "processor_order": ["string_replacement", "remove_newlines", "remove_non_japanese"],
            "remove_non_japanese": True,
        }
    )
    assert config.language_filter is False
    assert config.language_filter_config.mode == "blocks"
    assert config.remove_non_japanese is True
    assert config.processor_order == ["string_replacement", "language_filter", "remove_newlines", "remove_non_japanese"]
    assert TextProcessing.from_dict(config.to_dict()).processor_order == config.processor_order


def test_language_filter_config_round_trips():
    config = filter_config("trim", processor_order=["remove_numbers", "language_filter"])
    restored = TextProcessing.from_dict(config.to_dict())
    assert restored.language_filter is True
    assert restored.language_filter_config.mode == "trim"
    assert restored.processor_order == ["remove_numbers", "language_filter"]


def test_unknown_language_or_mode_leaves_input_intact():
    source = "MENU 日本語"
    assert text_processing.apply_text_processing(source, filter_config(), target_language="unknown") == source
    assert text_processing.apply_text_processing(source, filter_config("unknown"), target_language="ja") == source
