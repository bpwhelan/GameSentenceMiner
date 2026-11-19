from GameSentenceMiner.util.config.configuration import StringReplacement, TextProcessing, TextReplacementRule
from GameSentenceMiner.util.text_processing import apply_text_processing, with_processor_overrides
from GameSentenceMiner.util.texthook_matching import rank_hooks


def hook(hook_id, *samples):
    return {"id": hook_id, "samples": list(samples)}


def test_ranks_hooks_by_match_tier_across_independent_blocks():
    dialogue = "今日の放課後は図書館で待ち合わせよう"
    hooks = [
        hook("empty"),
        hook("other", "昨日も雨が降っていた"),
        hook("close", "今日の放課後は図書館で勉強しよう"),
        hook("enable", f"<longermarkup>{dialogue}</longermarkup>"),
        hook("disable", "セーブデータ1234567890"),
        hook("fuzzy", "今日の放課後は図書舘で待ち合わせよう"),
        hook("exact", "今日の放課後は\n図書館で待ち合わせよう", "おはよう"),
    ]
    config = TextProcessing(remove_numbers=True)

    matches = rank_hooks(hooks, ["セーブデータ1234567890", dialogue, "設定を開く"], config, "ja")

    assert [(entry["hookId"], entry["tier"]) for entry in matches] == [
        ("exact", "exact"),
        ("fuzzy", "fuzzy"),
        ("enable", "filtered"),
        ("close", "close"),
        ("empty", "unmatched"),
        ("other", "unmatched"),
        ("disable", "unmatched"),
    ]
    assert matches[0]["ocrText"] == dialogue
    assert matches[2]["changes"] == {"remove_angle_brackets": True}
    assert matches[-1]["processorOverrides"] == {}
    match = matches[2]
    effective = with_processor_overrides(config, match["processorOverrides"])
    assert apply_text_processing(match["sample"], effective) == match["ocrText"]
    assert config.remove_numbers and not config.remove_angle_brackets


def test_preserves_the_active_hook_overrides_and_compares_whole_blocks():
    config = TextProcessing(remove_numbers=True)
    blocks = ["セーブ123456789", "設定を開く"]
    matches = rank_hooks(
        [hook("concatenated", "セーブ123456789設定を開く"), hook("current", blocks[0])],
        blocks,
        config,
        "ja",
        selected_hook_id="current",
        processor_overrides={"remove_numbers": False},
    )
    assert matches[0]["hookId"] == "current"
    assert matches[0]["tier"] == "exact"
    assert matches[0]["processorOverrides"] == {"remove_numbers": False}
    assert matches[1]["tier"] in {"close", "unmatched"}


def test_short_fuzzy_match_requires_matching_characters():
    matches = rank_hooks([hook("yes", "「はい」"), hook("ash", "灰")], ["はい"], TextProcessing(), "ja")
    assert [match["tier"] for match in matches] == ["fuzzy", "unmatched"]


def test_combines_control_character_cleanup_and_language_filtering_for_bilingual_dialogue():
    japanese = "【武】「…\x03…\x03…\x03うそ〜ん」\x03"
    raw = japanese + "\n【Takeru】「…No frickin' way…」\x03"
    block = "⋯ 『うそ～ん！』"
    config = TextProcessing(remove_control_chars=False)

    match = rank_hooks([hook("Ages3ResT", raw)], ["武", block], config, "ja")[0]

    assert match["tier"] == "filtered"
    assert match["changes"] == {"remove_control_chars": True, "language_filter": True}
    assert match["ocrText"] == block
    assert match["output"] == japanese.replace("\x03", "")
    effective = with_processor_overrides(config, match["processorOverrides"])
    assert apply_text_processing(raw, effective, target_language="ja") == match["output"]


def test_inline_bilingual_dialogue_can_suggest_language_trim_for_this_hook():
    raw = "【武】「…\x03うそ〜ん」\x03 【Takeru】「…No frickin' way…」 12345"
    config = TextProcessing(remove_control_chars=False)

    match = rank_hooks([hook("Ages3ResT", raw)], ["『うそ～ん』"], config, "ja")[0]

    assert match["tier"] == "filtered"
    assert match["changes"] == {"remove_control_chars": True, "language_filter": True, "language_filter_mode": "trim"}
    effective = with_processor_overrides(config, match["processorOverrides"])
    assert apply_text_processing(raw, effective, target_language="ja") == "【武】「…うそ〜ん」"
    assert config.language_filter_config.mode == "blocks"


def test_enables_filters_in_a_pipeline_with_a_repeated_processor():
    config = TextProcessing(
        processor_order=["remove_numbers", "language_filter", "remove_numbers", "remove_control_chars"],
        remove_numbers=False,
        remove_control_chars=False,
    )
    raw = "「番号1234567890\x03」\nMENU1234567890"
    match = rank_hooks([hook("save", raw)], ["「番号1234567890」"], config, "ja")[0]

    assert match["tier"] == "filtered"
    assert match["changes"] == {"remove_control_chars": True, "language_filter": True}
    effective = with_processor_overrides(config, match["processorOverrides"])
    assert apply_text_processing(raw, effective, target_language="ja") == match["ocrText"]


def test_preserves_the_mode_of_an_enabled_language_filter():
    raw = "【武】「うそ〜ん」 【Takeru】「No frickin' way」 12345"
    config = TextProcessing(processor_order=["language_filter"], language_filter=True)

    match = rank_hooks([hook("Ages3ResT", raw)], ["『うそ～ん』"], config, "ja")[0]

    assert match["tier"] in {"close", "unmatched"}
    assert match["processorOverrides"] == {}


def test_ignores_edge_marks_and_matches_a_labeled_quote_to_the_dialogue_block():
    match = rank_hooks([hook("dialogue", "【武】「…うそ〜ん！？」~")], ["⋯『うそ～ん』"], TextProcessing(), "ja")[0]

    assert match["tier"] == "fuzzy"
    assert match["processorOverrides"] == {}


def test_overrides_use_existing_string_replacement_and_repetition_settings():
    config = TextProcessing(
        string_replacement=StringReplacement(enabled=True, rules=[TextReplacementRule(find="世界", replace="地球")]),
    )
    overridden = with_processor_overrides(config, {"string_replacement": False, "remove_repeated_lines": False})
    assert overridden.remove_repeated_lines_v2 is False
    assert apply_text_processing("こんにちは、世界！", overridden) == "こんにちは、世界！"
    assert apply_text_processing("こんにちは、世界！", config) == "こんにちは、地球！"
