from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from datetime import UTC, datetime
from io import StringIO
from pathlib import Path

import requests


DOWNLOAD_URL = "https://api.jiten.moe/api/frequency-list/download?downloadType=csv"
SOURCE_URL = "https://jiten.moe/other"
REQUEST_TIMEOUT_SECONDS = 120

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = (
    REPO_ROOT
    / "GameSentenceMiner"
    / "web"
    / "templates"
    / "components"
    / "word_frequency_sources"
    / "jiten_global.json"
)


def _clear_proxy_env() -> None:
    for key in list(os.environ):
        if "proxy" in key.lower():
            os.environ.pop(key, None)


def _download_csv_text() -> str:
    session = requests.Session()
    session.trust_env = False
    response = session.get(DOWNLOAD_URL, timeout=REQUEST_TIMEOUT_SECONDS)
    response.raise_for_status()
    response.encoding = "utf-8-sig"
    return response.text


def _normalize_word(raw_word: str | None) -> str:
    return str(raw_word or "").replace("\u3000", " ").strip()


def _build_entries(csv_text: str, max_rank: int | None) -> list[list[object]]:
    best_rank_by_word: dict[str, int] = {}
    reader = csv.DictReader(StringIO(csv_text))

    for row in reader:
        word = _normalize_word(row.get("Word"))
        if not word:
            continue

        try:
            rank = int(row.get("Rank") or 0)
        except (TypeError, ValueError):
            continue

        if rank <= 0:
            continue
        if max_rank is not None and rank > max_rank:
            continue

        current = best_rank_by_word.get(word)
        if current is None or rank < current:
            best_rank_by_word[word] = rank

    return [
        [word, rank]
        for word, rank in sorted(
            best_rank_by_word.items(), key=lambda item: (item[1], item[0])
        )
    ]


def _build_payload(entries: list[list[object]], max_rank: int | None) -> dict:
    generated_at = (
        datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    )
    effective_max_rank = max((int(rank) for _, rank in entries), default=0)
    scope = f"top{max_rank}" if max_rank is not None else "full"
    name = "Jiten Global Frequency"
    if max_rank is not None:
        name = f"{name} (Top {max_rank:,})"

    return {
        "id": "jiten-global",
        "name": name,
        "version": f"{generated_at.split('T', 1)[0]}-{scope}",
        "source_url": SOURCE_URL,
        "download_url": DOWNLOAD_URL,
        "default": True,
        "max_rank": effective_max_rank,
        "generated_at": generated_at,
        "entry_count": len(entries),
        "entries": entries,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Download Jiten's global frequency CSV and emit a GSM source bundle."
    )
    parser.add_argument(
        "--max-rank",
        type=int,
        default=None,
        help="Optional maximum rank to keep from the CSV export.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help=f"Output JSON path (default: {DEFAULT_OUTPUT})",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.max_rank is not None and args.max_rank <= 0:
        raise SystemExit("--max-rank must be greater than 0")

    _clear_proxy_env()

    print(f"Downloading Jiten frequency CSV from {DOWNLOAD_URL}...")
    csv_text = _download_csv_text()
    entries = _build_entries(csv_text, args.max_rank)
    payload = _build_payload(entries, args.max_rank)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )

    print(
        f"Wrote {payload['entry_count']:,} entries "
        f"(max rank {payload['max_rank']:,}) to {args.output}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
