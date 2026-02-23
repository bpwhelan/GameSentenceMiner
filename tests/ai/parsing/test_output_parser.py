from GameSentenceMiner.ai.parsing.output_parser import OutputParser


def test_parse_passthrough_for_empty_and_non_compat_mode():
    parser = OutputParser(compat_mode=True)
    assert parser.parse("") == ""

    parser_compat_off = OutputParser(compat_mode=False)
    assert parser_compat_off.parse("{output:hello}") == "{output:hello}"


def test_parse_extracts_output_json_object():
    parser = OutputParser(compat_mode=True)
    assert parser.parse('prefix {"output":"hello"} suffix') == "hello"


def test_parse_supports_legacy_unquoted_output_key():
    parser = OutputParser(compat_mode=True)
    assert parser.parse("{output:\"value\"}") == "value"


def test_parse_returns_raw_text_on_json_failure():
    parser = OutputParser(compat_mode=True)
    raw = "{output:not-valid-json}"
    assert parser.parse(raw) == raw
