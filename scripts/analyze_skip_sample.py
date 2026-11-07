"""Replay saved text through skip admission without modifying the sample DB.

Saved rows are a censored sample: earlier filtering and fragment merging have
already removed timing information. This reports exclusion, not ground-truth
recall. No game text is written to the report.
"""

import argparse
import json
import sqlite3
from datetime import UTC, datetime
from pathlib import Path

from GameSentenceMiner.text_pipeline.coordinator import TextCoordinatorState
from GameSentenceMiner.text_pipeline.models import SourceKind, TextObservation


def analyze(path):
    reports = []
    with sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True) as db:
        games = [r[0] for r in db.execute("SELECT DISTINCT game_name FROM game_lines")]
        for game in games:
            rows = db.execute(
                "SELECT id, timestamp, line_text FROM game_lines WHERE game_name=? ORDER BY timestamp", (game,)
            ).fetchall()
            state = TextCoordinatorState(skip_detection=True)
            start = rows[0][1]
            for line_id, stamp, text in rows:
                now_ns = int((stamp - start + 100) * 1e9)
                now = datetime.fromtimestamp(stamp, UTC)
                state.freeze_due(now=now, now_monotonic_ns=now_ns)
                state.ingest(
                    TextObservation(
                        observation_id=line_id,
                        source_kind=SourceKind.TEXTHOOK,
                        source_instance=game,
                        raw_text=text,
                        captured_at_utc=now,
                        emitted_at_utc=now,
                        received_at_utc=now,
                        received_monotonic_ns=now_ns,
                        metadata={"scene": game},
                    ),
                    now=now,
                    now_monotonic_ns=now_ns,
                )
            state.freeze_due(now_monotonic_ns=now_ns + 10_000_000_000)
            state.poll_skip_detection(now_ns + 10_000_000_000)
            records = state.snapshot().records
            skipped = [r for r in records if r.stats_status == "skipped"]
            total = sum(len(r.text) for r in records)
            excluded = sum(len(r.text) for r in skipped)
            reports.append(
                {
                    "game": game,
                    "rows": len(rows),
                    "characters": total,
                    "excluded_rows": len(skipped),
                    "excluded_characters": excluded,
                    "excluded_character_percent": round(100 * excluded / total, 1) if total else 0,
                }
            )
    return reports


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database")
    args = parser.parse_args()
    print(json.dumps(analyze(args.database), ensure_ascii=True, indent=2))
