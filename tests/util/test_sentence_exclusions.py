import json

import pytest

from GameSentenceMiner.util.sentence_exclusions import SentenceExclusions


def test_exact_matching_is_per_game_and_preserves_sentence_boundaries(tmp_path):
    path = tmp_path / "sentence_exclusions.json"
    path.write_text(json.dumps({"version": 1, "games": {"Game A": ["Menu\ntext", "設定"]}}), encoding="utf-8")
    exclusions = SentenceExclusions(path)
    assert exclusions.contains("  Menu\r\ntext  ", "Game A")
    assert exclusions.contains("設定", "Game A")
    assert not exclusions.contains("設定", "Game B")
    assert not exclusions.contains("Menu", "Game A")
    assert not exclusions.contains("menu\ntext", "Game A")
    assert not exclusions.contains("設定を開く", "Game A")
    assert not exclusions.contains("設定", "")


def test_live_add_remove_and_deleted_file(tmp_path):
    path = tmp_path / "sentence_exclusions.json"
    exclusions = SentenceExclusions(path)
    assert not exclusions.contains("text", "Game")
    path.write_text(json.dumps({"version": 1, "games": {"Game": ["text"]}}), encoding="utf-8")
    assert exclusions.contains("text", "Game")
    replacement = tmp_path / "replacement.json"
    replacement.write_text(json.dumps({"version": 1, "games": {"Game": []}}), encoding="utf-8")
    replacement.replace(path)
    assert not exclusions.contains("text", "Game")
    path.unlink()
    assert not exclusions.contains("text", "Game")


@pytest.mark.parametrize("content", ["{broken", "[]", '{"games": {"Game": "text"}}'])
def test_malformed_files_do_not_crash_text_intake(tmp_path, content):
    path = tmp_path / "sentence_exclusions.json"
    path.write_text(content, encoding="utf-8")
    assert not SentenceExclusions(path).contains("text", "Game")
