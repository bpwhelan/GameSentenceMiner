"""Frequency dictionary builder for Yomitan-compatible term_meta_bank format."""

from __future__ import annotations

import io
import json
import time
import zipfile


class FrequencyDictBuilder:
    """Build a Yomitan-compatible frequency dictionary from word occurrence data."""

    DICT_TITLE = "GSM Frequency Dictionary"
    MAX_ENTRIES_PER_FILE = 10_000

    def __init__(self, download_url: str | None = None) -> None:
        self.download_url = download_url
        self.revision = str(int(time.time()))
        self.entries: list[list] = []

    def _create_index(self) -> dict:
        """Return the index.json metadata dict."""
        index: dict = {
            "title": self.DICT_TITLE,
            "revision": self.revision,
            "format": 3,
            "frequencyMode": "occurrence-based",
            "author": "GameSentenceMiner",
            "description": "Word frequency data from your GSM database",
        }
        if self.download_url:
            index["downloadUrl"] = self.download_url
            # Derive indexUrl by replacing the dict endpoint with the index endpoint
            index["indexUrl"] = self.download_url.replace(
                "/api/yomitan-freq-dict", "/api/yomitan-freq-index"
            )
            index["isUpdatable"] = True
        return index

    @staticmethod
    def _build_entry(word: str, reading: str, count: int) -> list:
        """Build a single term_meta_bank entry."""
        if reading:
            return [word, "freq", {"frequency": count, "reading": reading}]
        return [word, "freq", count]

    def build_from_db(self) -> None:
        """Query words + word_occurrences and populate self.entries."""
        from GameSentenceMiner.util.database.tokenization_tables import WordsTable

        rows = WordsTable._db.fetchall(
            "SELECT w.word, w.reading, COUNT(wo.id) as freq "
            "FROM words w "
            "INNER JOIN word_occurrences wo ON w.id = wo.word_id "
            "GROUP BY w.id "
            "HAVING freq > 0 "
            "ORDER BY freq DESC"
        )
        self.entries = [self._build_entry(row[0], row[1], row[2]) for row in rows]

    def export_bytes(self) -> bytes:
        """Create an in-memory ZIP with index.json and term_meta_bank_N.json files."""
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr(
                "index.json", json.dumps(self._create_index(), ensure_ascii=False)
            )
            for i in range(0, max(len(self.entries), 1), self.MAX_ENTRIES_PER_FILE):
                chunk = self.entries[i : i + self.MAX_ENTRIES_PER_FILE]
                bank_index = (i // self.MAX_ENTRIES_PER_FILE) + 1
                zf.writestr(
                    f"term_meta_bank_{bank_index}.json",
                    json.dumps(chunk, ensure_ascii=False),
                )
        return buf.getvalue()
