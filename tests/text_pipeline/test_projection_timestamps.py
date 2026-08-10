from datetime import datetime, timedelta, timezone

import pytest

from GameSentenceMiner.text_pipeline.models import (
    SourceKind,
    TextRecordSnapshot,
    TextRecordState,
)
from GameSentenceMiner.util.text_log import GameText


def test_authoritative_projection_preserves_captured_instant() -> None:
    captured_at = datetime(2026, 8, 10, 3, 35, tzinfo=timezone(timedelta(hours=5, minutes=45)))
    record = TextRecordSnapshot(
        line_id="line-1",
        session_id="session-1",
        stream_sequence=1,
        revision=1,
        state=TextRecordState.PROVISIONAL,
        raw_text="raw",
        text="processed",
        source_kind=SourceKind.TEXTHOOK,
        source_instance="hook-1",
        source_display_name="Hook",
        observation_ids=("observation-1",),
        captured_at_utc=captured_at,
        first_seen_at_utc=captured_at,
        first_seen_monotonic_ns=1,
    )

    line = GameText().upsert_authoritative_line(record)

    assert line.time.timestamp() == pytest.approx(captured_at.timestamp())
    assert line.first_seen_time.timestamp() == pytest.approx(captured_at.timestamp())
