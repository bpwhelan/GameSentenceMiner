from GameSentenceMiner.util import text_log


def test_normalize_text_for_comparison_removes_punctuation_and_whitespace():
    assert text_log.normalize_text_for_comparison(" 「Hello、　World!」 \n") == "HelloWorld"


def test_is_line_recycled_uses_normalized_text(monkeypatch):
    monkeypatch.setattr(text_log.game_log, "previous_lines", {"HelloWorld"})

    assert text_log.is_line_recycled("Hello, World!")
    assert not text_log.is_line_recycled("Goodbye")
