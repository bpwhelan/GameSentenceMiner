from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import requests

from GameSentenceMiner.anki import _preserve_html_tags_for_furigana
from GameSentenceMiner.mecab import mecab


DEFAULT_QUERY = '-tag:Tool::GameSentenceMiner "deck:Sentence Mining"'
DEFAULT_ANKI_CONNECT_URL = "http://127.0.0.1:8765"
DEFAULT_BATCH_SIZE = 100


@dataclass
class Mismatch:
    note_id: int
    sentence: str
    stored: str
    generated: str


def _anki_invoke(url: str, action: str, **params: Any) -> Any:
    response = requests.post(
        url,
        json={"action": action, "version": 6, "params": params},
        headers={"Content-Type": "application/json"},
        timeout=30,
    )
    response.raise_for_status()
    payload = response.json()
    if payload.get("error"):
        raise RuntimeError(f"AnkiConnect {action} failed: {payload['error']}")
    return payload["result"]


def _iter_notes(url: str, query: str, batch_size: int) -> list[dict[str, Any]]:
    note_ids = _anki_invoke(url, "findNotes", query=query)
    notes: list[dict[str, Any]] = []
    for start in range(0, len(note_ids), batch_size):
        batch = note_ids[start : start + batch_size]
        notes.extend(_anki_invoke(url, "notesInfo", notes=batch))
    return notes


def _field_value(note: dict[str, Any], name: str) -> str:
    field = note.get("fields", {}).get(name, {})
    value = field.get("value", "")
    return value if isinstance(value, str) else str(value)


def _generate_sentence_furigana(sentence: str) -> str:
    return _preserve_html_tags_for_furigana(sentence, mecab.reading(sentence))


def compare_notes(url: str, query: str, batch_size: int) -> tuple[list[Mismatch], int]:
    notes = _iter_notes(url, query, batch_size)
    mismatches: list[Mismatch] = []

    for note in notes:
        sentence = _field_value(note, "Sentence")
        stored = _field_value(note, "SentenceFurigana")
        generated = _generate_sentence_furigana(sentence)
        if stored != generated:
            mismatches.append(
                Mismatch(
                    note_id=int(note["noteId"]),
                    sentence=sentence,
                    stored=stored,
                    generated=generated,
                )
            )

    return mismatches, len(notes)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Compare Anki Sentence/SentenceFurigana fields against GSM furigana generation."
    )
    parser.add_argument("--url", default=DEFAULT_ANKI_CONNECT_URL)
    parser.add_argument("--query", default=DEFAULT_QUERY)
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE)
    parser.add_argument("--json-out", type=Path, default=None)
    parser.add_argument("--show", type=int, default=20, help="Maximum mismatches to print.")
    args = parser.parse_args()

    mismatches, total_notes = compare_notes(args.url, args.query, args.batch_size)

    print(f"Scanned {total_notes} notes for query: {args.query}")
    print(f"Mismatches: {len(mismatches)}")

    for mismatch in mismatches[: args.show]:
        print("=" * 80)
        print(f"Note ID: {mismatch.note_id}")
        print(f"Sentence: {mismatch.sentence}")
        print(f"Stored:   {mismatch.stored}")
        print(f"Generated:{mismatch.generated}")

    if args.json_out is not None:
        args.json_out.write_text(
            json.dumps(
                {
                    "query": args.query,
                    "url": args.url,
                    "total_notes": total_notes,
                    "mismatch_count": len(mismatches),
                    "mismatches": [asdict(item) for item in mismatches],
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        print(f"Wrote JSON report to {args.json_out}")

    return 0 if not mismatches else 1


if __name__ == "__main__":
    sys.exit(main())
