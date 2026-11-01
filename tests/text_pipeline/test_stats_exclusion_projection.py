from dataclasses import replace
from datetime import UTC, datetime

import pytest

from GameSentenceMiner.text_pipeline.models import (
    SourceKind,
    TextDomainEvent,
    TextEventKind,
    TextRecordSnapshot,
    TextRecordState,
)
from GameSentenceMiner.util.text_log import GameText
from GameSentenceMiner.web.events import EventManager


def make_record(**changes):
    stamp = datetime(2026, 10, 31, tzinfo=UTC)
    record = TextRecordSnapshot(
        line_id="line-1",
        session_id="session-1",
        stream_sequence=1,
        revision=1,
        state=TextRecordState.PROVISIONAL,
        raw_text="通常の文章。",
        text="通常の文章。",
        source_kind=SourceKind.TEXTHOOK,
        source_instance="hook-1",
        source_display_name="Hook",
        observation_ids=("observation-1",),
        captured_at_utc=stamp,
        first_seen_at_utc=stamp,
        first_seen_monotonic_ns=1,
    )
    return replace(record, **changes)


@pytest.mark.parametrize("stats_status", ["accepted", "pending", "pending_manual", "skipped"])
@pytest.mark.parametrize("explicitly_excluded", [False, True])
def test_wire_badge_requires_confirmed_stats_exclusion(stats_status, explicitly_excluded):
    record = make_record(stats_status=stats_status, excluded_from_stats=explicitly_excluded)
    expected = explicitly_excluded or stats_status == "skipped"

    assert record.to_serializable()["excluded_from_stats"] is expected
    assert TextDomainEvent(TextEventKind.APPENDED, record).to_wire()["data"]["excluded_from_stats"] is expected


@pytest.mark.parametrize("stats_status", ["accepted", "pending", "pending_manual", "skipped"])
@pytest.mark.parametrize("explicitly_excluded", [False, True])
@pytest.mark.parametrize("existing_line", [False, True])
def test_history_and_reconnect_badges_require_confirmed_exclusion(stats_status, explicitly_excluded, existing_line):
    history = GameText()
    events = EventManager()
    if existing_line:
        events.upsert_gameline(history.upsert_authoritative_line(make_record()))
    record = make_record(revision=2, stats_status=stats_status, excluded_from_stats=explicitly_excluded)
    expected = explicitly_excluded or stats_status == "skipped"

    line = history.upsert_authoritative_line(record)
    event = events.upsert_gameline(line)

    assert line.excluded_from_stats is expected
    assert event.to_serializable()["excluded_from_stats"] is expected
    assert events.get_session_sync_state([])["missing_events"][0]["excluded_from_stats"] is expected


def test_pending_line_stays_unbadged_until_spam_is_confirmed_and_clears_on_recovery():
    history = GameText()
    events = EventManager()
    for revision, (status, excluded) in enumerate(
        [("pending", False), ("pending", False), ("skipped", True), ("accepted", False)], start=1
    ):
        record = make_record(revision=revision, stats_status=status)
        line = history.upsert_authoritative_line(record)
        event = events.upsert_gameline(line)

        assert record.to_serializable()["excluded_from_stats"] is excluded
        assert line.excluded_from_stats is excluded
        assert event.to_serializable()["excluded_from_stats"] is excluded
