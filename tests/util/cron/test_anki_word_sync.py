"""Tests for the anki_word_sync cron module."""

from __future__ import annotations

import json
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest


# Stub heavy deps so the module under test can be imported without MeCab.
# We use a conftest-style approach: install stubs, import the module, then
# immediately restore originals so later test files see the real packages.
_MECAB_STUBS = [
    "GameSentenceMiner.mecab",
    "GameSentenceMiner.mecab.mecab",
    "GameSentenceMiner.mecab.basic_types",
]
_MISSING = object()
_originals: dict[str, object] = {}
for _mod in _MECAB_STUBS:
    _originals[_mod] = sys.modules.get(_mod, _MISSING)
    if _mod not in sys.modules:
        sys.modules[_mod] = MagicMock()

# Import the module under test while stubs are active
from GameSentenceMiner.util.cron import anki_word_sync as _anki_word_sync_mod  # noqa: E402

# Restore immediately so other test modules collected after this one
# see the real mecab packages, not our MagicMock stubs.
for _mod, _orig in _originals.items():
    if _orig is _MISSING:
        sys.modules.pop(_mod, None)
    else:
        sys.modules[_mod] = _orig
# Clean the parent attribute so a fresh import works for later tests.
import GameSentenceMiner as _gsm_pkg

if hasattr(_gsm_pkg, "mecab") and isinstance(getattr(_gsm_pkg, "mecab"), MagicMock):
    delattr(_gsm_pkg, "mecab")


def _make_config(word_field: str = "Expression", url: str = "http://127.0.0.1:8765"):
    return SimpleNamespace(
        anki=SimpleNamespace(word_field=word_field, url=url),
    )


class TestFetchAllExpressionValues:
    """Tests for _fetch_all_expression_values."""

    def test_returns_none_when_word_field_empty(self, monkeypatch):
        from GameSentenceMiner.util.cron import anki_word_sync as mod

        monkeypatch.setattr(mod, "get_config", lambda: _make_config(word_field=""))
        result = mod._fetch_all_expression_values()
        assert result is None

    def test_returns_none_on_connection_error(self, monkeypatch):
        import urllib.error

        from GameSentenceMiner.util.cron import anki_word_sync as mod

        monkeypatch.setattr(mod, "get_config", lambda: _make_config())

        def _raise(*args, **kwargs):
            raise urllib.error.URLError("refused")

        monkeypatch.setattr(mod.urllib.request, "urlopen", _raise)
        result = mod._fetch_all_expression_values()
        assert result is None

    def test_returns_empty_set_when_no_notes(self, monkeypatch):
        from GameSentenceMiner.util.cron import anki_word_sync as mod

        monkeypatch.setattr(mod, "get_config", lambda: _make_config())

        resp_data = json.dumps({"result": [], "error": None}).encode()
        mock_resp = MagicMock()
        mock_resp.read.return_value = resp_data
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)

        monkeypatch.setattr(mod.urllib.request, "urlopen", lambda *a, **kw: mock_resp)
        result = mod._fetch_all_expression_values()
        assert result == set()

    def test_returns_expression_values(self, monkeypatch):
        from GameSentenceMiner.util.cron import anki_word_sync as mod

        monkeypatch.setattr(mod, "get_config", lambda: _make_config())

        call_count = {"n": 0}

        def fake_urlopen(req, **kwargs):
            call_count["n"] += 1
            if call_count["n"] == 1:
                # findNotes response
                data = json.dumps({"result": [1, 2], "error": None}).encode()
            else:
                # notesInfo response
                data = json.dumps(
                    {
                        "result": [
                            {"fields": {"Expression": {"value": "食べる"}}},
                            {"fields": {"Expression": {"value": "飲む"}}},
                        ],
                        "error": None,
                    }
                ).encode()
            mock = MagicMock()
            mock.read.return_value = data
            mock.__enter__ = lambda s: s
            mock.__exit__ = MagicMock(return_value=False)
            return mock

        monkeypatch.setattr(mod.urllib.request, "urlopen", fake_urlopen)
        result = mod._fetch_all_expression_values()
        assert result == {"食べる", "飲む"}


class TestRunAnkiWordSync:
    """Tests for run_anki_word_sync."""

    def test_skips_when_tokenization_disabled(self, monkeypatch):
        from GameSentenceMiner.util.cron import anki_word_sync as mod

        monkeypatch.setattr(mod, "is_tokenization_enabled", lambda: False)
        result = mod.run_anki_word_sync()
        assert result["skipped"] is True
        assert "tokenization" in result["reason"]

    def test_skips_when_anki_unreachable(self, monkeypatch):
        from GameSentenceMiner.util.cron import anki_word_sync as mod

        monkeypatch.setattr(mod, "is_tokenization_enabled", lambda: True)
        monkeypatch.setattr(mod, "_fetch_all_expression_values", lambda: None)
        result = mod.run_anki_word_sync()
        assert result["skipped"] is True

    def test_matches_words_correctly(self, monkeypatch):
        from GameSentenceMiner.util.cron import anki_word_sync as mod

        monkeypatch.setattr(mod, "is_tokenization_enabled", lambda: True)
        monkeypatch.setattr(
            mod, "_fetch_all_expression_values", lambda: {"食べる", "走る"}
        )

        # Create fake word objects
        word1 = SimpleNamespace(id=1, word="食べる")
        word2 = SimpleNamespace(id=2, word="飲む")
        word3 = SimpleNamespace(id=3, word="走る")

        marked_ids = []

        fake_words_table = MagicMock()
        fake_words_table.get_words_not_in_anki.return_value = [word1, word2, word3]
        fake_words_table.mark_in_anki.side_effect = lambda wid: marked_ids.append(wid)

        with patch.dict(
            "sys.modules",
            {
                "GameSentenceMiner.util.database.tokenization_tables": MagicMock(
                    WordsTable=fake_words_table
                )
            },
        ):
            # Re-import to pick up the patched module
            import importlib

            importlib.reload(mod)
            monkeypatch.setattr(mod, "is_tokenization_enabled", lambda: True)
            monkeypatch.setattr(
                mod, "_fetch_all_expression_values", lambda: {"食べる", "走る"}
            )
            result = mod.run_anki_word_sync()

        assert result["matched"] == 2
        assert result["checked"] == 3
        assert set(marked_ids) == {1, 3}

    def test_no_untagged_words(self, monkeypatch):
        from GameSentenceMiner.util.cron import anki_word_sync as mod

        monkeypatch.setattr(mod, "is_tokenization_enabled", lambda: True)
        monkeypatch.setattr(mod, "_fetch_all_expression_values", lambda: {"食べる"})

        fake_words_table = MagicMock()
        fake_words_table.get_words_not_in_anki.return_value = []

        with patch.dict(
            "sys.modules",
            {
                "GameSentenceMiner.util.database.tokenization_tables": MagicMock(
                    WordsTable=fake_words_table
                )
            },
        ):
            import importlib

            importlib.reload(mod)
            monkeypatch.setattr(mod, "is_tokenization_enabled", lambda: True)
            monkeypatch.setattr(mod, "_fetch_all_expression_values", lambda: {"食べる"})
            result = mod.run_anki_word_sync()

        assert result["matched"] == 0
        assert "no untagged words" in result.get("reason", "")
