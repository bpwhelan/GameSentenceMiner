import pytest

from GameSentenceMiner.util.config.configuration import (
    StringReplacement,
    TextProcessing,
    TextReplacementRule,
)
from GameSentenceMiner.util.text_processing import apply_string_replacements, apply_text_processing


def _cfg(enabled=True, rules=None):
    return StringReplacement(enabled=enabled, rules=list(rules or []))


def _rule(
    *,
    mode="plain",
    find="",
    replace="",
    enabled=True,
    case_sensitive=False,
    whole_word=False,
):
    return TextReplacementRule(
        enabled=enabled,
        mode=mode,
        find=find,
        replace=replace,
        case_sensitive=case_sensitive,
        whole_word=whole_word,
    )


def test_apply_text_processing_passthrough_for_empty_and_none_config():
    assert apply_text_processing("", None) == ""
    assert apply_text_processing("abc", None) == "abc"


def test_apply_text_processing_runs_string_replacement():
    config = TextProcessing(
        string_replacement=_cfg(
            rules=[
                _rule(find="foo", replace="bar"),
            ]
        )
    )
    assert apply_text_processing("foo", config) == "bar"


def test_apply_string_replacements_passthrough_when_disabled():
    config = _cfg(enabled=False, rules=[_rule(find="a", replace="b")])
    assert apply_string_replacements("a", config) == "a"


def test_ordered_rules_are_applied_in_sequence():
    config = _cfg(
        rules=[
            _rule(find="foo", replace="bar"),
            _rule(find="bar", replace="baz"),
        ]
    )
    assert apply_string_replacements("foo", config) == "baz"


def test_plain_replacement_is_case_insensitive_by_default():
    config = _cfg(rules=[_rule(find="hello", replace="hi")])
    assert apply_string_replacements("HeLLo WORLD", config) == "hi WORLD"


def test_plain_replacement_can_be_case_sensitive():
    config = _cfg(rules=[_rule(find="hello", replace="hi", case_sensitive=True)])
    assert apply_string_replacements("HeLLo hello", config) == "HeLLo hi"


def test_plain_whole_word_does_not_replace_inside_larger_word():
    config = _cfg(rules=[_rule(find="cat", replace="dog", whole_word=True)])
    assert apply_string_replacements("cat category scat", config) == "dog category scat"


def test_regex_replacement_with_capture_groups():
    config = _cfg(
        rules=[
            _rule(mode="regex", find=r"(\d+)", replace=r"[\1]"),
        ]
    )
    assert apply_string_replacements("a1b22", config) == "a[1]b[22]"


def test_regex_whole_word_wraps_pattern_boundaries():
    config = _cfg(
        rules=[
            _rule(mode="regex", find=r"cat", replace="dog", whole_word=True),
        ]
    )
    assert apply_string_replacements("cat category", config) == "dog category"


def test_invalid_regex_pattern_is_ignored():
    config = _cfg(
        rules=[
            _rule(mode="regex", find=r"[", replace="x"),
            _rule(find="ok", replace="done"),
        ]
    )
    assert apply_string_replacements("ok", config) == "done"


def test_html_tag_filter_pattern_from_user_report_keeps_inner_text():
    config = _cfg(
        rules=[
            _rule(mode="regex", find=r"<.*>", replace=""),
        ]
    )
    assert apply_string_replacements("<i>expeliarmsus</i>", config) == "expeliarmsus"


def test_html_tag_filter_common_non_greedy_pattern():
    config = _cfg(
        rules=[
            _rule(mode="regex", find=r"<[^>]*>", replace=""),
        ]
    )
    assert apply_string_replacements("<i>expeliarmsus</i>", config) == "expeliarmsus"


def test_newline_replacement_using_regex_pattern():
    config = _cfg(
        rules=[
            _rule(mode="regex", find=r"\n+", replace=" "),
        ]
    )
    assert apply_string_replacements("line1\n\nline2", config) == "line1 line2"


def test_newline_replacement_using_plain_mode_with_literal_newline():
    config = _cfg(
        rules=[
            _rule(find="\n", replace=" "),
        ]
    )
    assert apply_string_replacements("line1\nline2", config) == "line1 line2"


def test_mojibake_fix_rule():
    config = _cfg(
        rules=[
            _rule(find="FranÃ§ais", replace="Français"),
            _rule(find="â€”", replace="—"),
        ]
    )
    assert apply_string_replacements("FranÃ§ais â€” test", config) == "Français — test"


def test_disabled_rule_is_skipped():
    config = _cfg(
        rules=[
            _rule(find="a", replace="b", enabled=False),
            _rule(find="b", replace="c"),
        ]
    )
    assert apply_string_replacements("ab", config) == "ac"


def test_empty_find_value_is_skipped():
    config = _cfg(
        rules=[
            _rule(find="", replace="x"),
            _rule(find="a", replace="b"),
        ]
    )
    assert apply_string_replacements("a", config) == "b"


def test_none_replacement_means_remove_match():
    config = _cfg(
        rules=[
            TextReplacementRule(enabled=True, mode="plain", find="x", replace=None),
        ]
    )
    assert apply_string_replacements("x1x2", config) == "12"


def test_unknown_mode_falls_back_to_plain_behavior():
    config = _cfg(
        rules=[
            _rule(mode="unknown", find="abc", replace="z"),
        ]
    )
    assert apply_string_replacements("ABC", config) == "z"


@pytest.mark.parametrize(
    "text,expected",
    [
        ("<b>hello</b>\nworld", "hello world"),
        ("<i>a</i><i>b</i>", "ab"),
    ],
)
def test_combined_tag_strip_and_whitespace_cleanup(text, expected):
    config = _cfg(
        rules=[
            _rule(mode="regex", find=r"<.*>", replace=""),
            _rule(mode="regex", find=r"\s+", replace=" "),
            _rule(find="  ", replace=" "),
        ]
    )
    assert apply_string_replacements(text, config).strip() == expected
