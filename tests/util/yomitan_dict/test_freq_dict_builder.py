"""Unit tests for FrequencyDictBuilder."""

from __future__ import annotations

import json
import time
import zipfile
import io

import pytest

from GameSentenceMiner.util.yomitan_dict.freq_dict_builder import FrequencyDictBuilder


class TestBuildEntry:
    def test_with_reading(self):
        entry = FrequencyDictBuilder._build_entry("食べる", "たべる", 42)
        assert entry == ["食べる", "freq", {"frequency": 42, "reading": "たべる"}]

    def test_empty_reading_produces_simplified_format(self):
        entry = FrequencyDictBuilder._build_entry("食べる", "", 10)
        assert entry == ["食べる", "freq", 10]

    def test_zero_count(self):
        entry = FrequencyDictBuilder._build_entry("猫", "ねこ", 0)
        assert entry == ["猫", "freq", {"frequency": 0, "reading": "ねこ"}]


class TestCreateIndex:
    def test_basic_metadata(self):
        builder = FrequencyDictBuilder()
        index = builder._create_index()
        assert index["title"] == "GSM Frequency Dictionary"
        assert index["format"] == 3
        assert index["frequencyMode"] == "occurrence-based"
        assert index["author"] == "GameSentenceMiner"

    def test_with_download_url(self):
        builder = FrequencyDictBuilder(
            download_url="http://127.0.0.1:9000/api/yomitan-freq-dict"
        )
        index = builder._create_index()
        assert index["downloadUrl"] == "http://127.0.0.1:9000/api/yomitan-freq-dict"
        assert index["indexUrl"] == "http://127.0.0.1:9000/api/yomitan-freq-index"
        assert index["isUpdatable"] is True

    def test_without_download_url_no_updatable_fields(self):
        builder = FrequencyDictBuilder()
        index = builder._create_index()
        assert "downloadUrl" not in index
        assert "isUpdatable" not in index

    def test_revision_is_unix_timestamp(self):
        before = int(time.time())
        builder = FrequencyDictBuilder()
        after = int(time.time())
        rev = int(builder.revision)
        assert before <= rev <= after


class TestExportBytes:
    def test_produces_valid_zip(self):
        builder = FrequencyDictBuilder()
        builder.entries = [["猫", "freq", {"frequency": 5, "reading": "ねこ"}]]
        data = builder.export_bytes()
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            names = zf.namelist()
            assert "index.json" in names
            assert "term_meta_bank_1.json" in names

    def test_correct_file_names_for_empty_entries(self):
        builder = FrequencyDictBuilder()
        builder.entries = []
        data = builder.export_bytes()
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            names = zf.namelist()
            assert "index.json" in names
            assert "term_meta_bank_1.json" in names

    def test_round_trip_entries(self):
        builder = FrequencyDictBuilder()
        builder.entries = [
            ["食べる", "freq", {"frequency": 42, "reading": "たべる"}],
            ["猫", "freq", 3],
        ]
        data = builder.export_bytes()
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            entries = json.loads(zf.read("term_meta_bank_1.json"))
            assert entries == builder.entries

    def test_chunking_at_boundary(self):
        builder = FrequencyDictBuilder()
        # Create exactly 10001 entries to trigger chunking
        builder.entries = [["word", "freq", i] for i in range(10_001)]
        data = builder.export_bytes()
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            names = zf.namelist()
            assert "term_meta_bank_1.json" in names
            assert "term_meta_bank_2.json" in names
            chunk1 = json.loads(zf.read("term_meta_bank_1.json"))
            chunk2 = json.loads(zf.read("term_meta_bank_2.json"))
            assert len(chunk1) == 10_000
            assert len(chunk2) == 1


class TestBuildFromDb:
    def test_excludes_orphaned_words(self, monkeypatch):
        """Words with zero occurrences should not appear."""
        # Mock the database query to return only words with occurrences
        fake_rows = [("食べる", "たべる", 5)]
        mock_db = type("MockDB", (), {"fetchall": lambda self, *a: fake_rows})()

        import GameSentenceMiner.util.yomitan_dict.freq_dict_builder as mod
        from GameSentenceMiner.util.database.tokenization_tables import WordsTable

        original_db = getattr(WordsTable, "_db", None)
        monkeypatch.setattr(WordsTable, "_db", mock_db)

        builder = FrequencyDictBuilder()
        builder.build_from_db()

        assert len(builder.entries) == 1
        assert builder.entries[0] == [
            "食べる",
            "freq",
            {"frequency": 5, "reading": "たべる"},
        ]

        if original_db is not None:
            monkeypatch.setattr(WordsTable, "_db", original_db)
