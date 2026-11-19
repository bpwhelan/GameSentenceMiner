from __future__ import annotations

import threading
import time
import uuid
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from sys import maxsize

from GameSentenceMiner.native import text_correlation
from GameSentenceMiner.util.concurrency.actor import Actor, MailboxFull, MailboxPolicy
from GameSentenceMiner.util.concurrency.resource_qos import ExecutionClass

from .journal import make_journal
from .models import (
    IngressAck,
    IngressResult,
    IngressStatus,
    SourceKind,
    TextDomainEvent,
    TextEventKind,
    TextObservation,
    TextRecordSnapshot,
    TextRecordState,
    TextStreamSnapshot,
    normalize_utc,
    utc_now,
)
from .skip_detection import AUTOMATIC_SOURCES, WINDOW_NS, compact_text, make_detector


@dataclass
class TextCoordinatorMetrics:
    accepted: int = 0
    duplicates: int = 0
    rejected: int = 0
    appended: int = 0
    updated: int = 0
    frozen: int = 0


def _compact(text: str) -> str:
    return "".join(str(text or "").split())


class TextCoordinatorState:
    """Own completed dialogue records and revisable speech hypotheses."""

    def __init__(
        self,
        *,
        session_id: str | None = None,
        cross_source_window: timedelta = timedelta(seconds=5),
        cross_source_similarity: int = 70,
        same_source_dedup_window: timedelta = timedelta(seconds=2),
        max_observation_ids: int = 20_000,
        skip_detection: bool = False,
    ) -> None:
        self.session_id = session_id or str(uuid.uuid4())
        self.cross_source_window = cross_source_window
        self.cross_source_similarity = cross_source_similarity
        self.same_source_dedup_window = same_source_dedup_window
        self.max_observation_ids = max_observation_ids
        self.metrics = TextCoordinatorMetrics()
        self._classify, self._shadow_correlation = text_correlation.implementation()
        self._journal = make_journal()
        self._open_line_id: str | None = None
        self._open_deadline_monotonic_ns: int | None = None
        self._skip_detector = make_detector() if skip_detection else None
        self._skip_scene: str | None = None
        self._skip_record_id: str | None = None
        self._landing_record_id: str | None = None
        self._landing_deadline_ns = 0

    def _uses_skip_detection(self, observation: TextObservation) -> bool:
        return bool(
            self._skip_detector is not None
            and observation.source_kind in AUTOMATIC_SOURCES
            and not observation.excluded_from_stats
            and not observation.relay_only
            and not observation.metadata.get("skip_landing_confirmed")
        )

    def _classify_stats(self, record: TextRecordSnapshot, skipped: bool) -> TextDomainEvent:
        record = replace(
            record,
            revision=record.revision + 1,
            stats_status="skipped" if skipped else "accepted",
            excluded_from_stats=record.excluded_from_stats or skipped,
        )
        self._publish_record(record)
        return TextDomainEvent(TextEventKind.STATS_EXCLUDED if skipped else TextEventKind.STATS_READY, record)

    def poll_skip_detection(self, now_monotonic_ns: int | None = None) -> tuple[TextDomainEvent, ...]:
        detector = self._skip_detector
        if detector is None:
            return ()
        now_ns = time.monotonic_ns() if now_monotonic_ns is None else now_monotonic_ns
        events = []
        if detector.quiet(now_ns):
            last = self.get(self._skip_record_id)
            if last is not None:
                # Close a long fragment window before normal text resumes.
                events.extend(self.freeze(last.line_id))
                events.append(TextDomainEvent(TextEventKind.SKIP_ENDED, self.get(last.line_id)))
                if detector.confirmed and self._journal.latest().line_id == last.line_id:
                    self._landing_record_id = last.line_id
                    self._landing_deadline_ns = now_ns + 10_000_000_000
            detector.reset()
        for record in self._journal.ready(now_ns, WINDOW_NS):
            events.append(self._classify_stats(record, False))
        return tuple(events)

    def finish_stats(self) -> tuple[TextDomainEvent, ...]:
        """Drain undecided normal text on clean shutdown, without a recovery scan."""
        return self._finish_pending(bool(self._skip_detector and self._skip_detector.confirmed))

    def _finish_pending(self, exclude_automatic: bool, now: datetime | None = None) -> tuple[TextDomainEvent, ...]:
        events = []
        for record in self._journal.pending():
            if record.state is TextRecordState.PROVISIONAL:
                (frozen,) = self.freeze(record.line_id, now=now)
                events.append(frozen)
                record = frozen.record
            events.append(self._classify_stats(record, exclude_automatic and record.stats_status == "pending"))
        return tuple(events)

    def recover_skip_landing(self, text: str, scene: str, *, now=None, now_monotonic_ns=None):
        """Admit only a visually verified suffix, never the entire skipped batch."""
        now_ns = time.monotonic_ns() if now_monotonic_ns is None else now_monotonic_ns
        record = self.get(self._landing_record_id)
        visible = compact_text(text)
        if (
            record is None
            or scene != record.scene
            or self._skip_detector.suspended
            or now_ns > self._landing_deadline_ns
            or not 8 <= len(visible) <= 500
            or not compact_text(record.text).endswith(visible)
        ):
            return ()
        self._landing_record_id = None
        stamp = normalize_utc(now or utc_now())
        if compact_text(record.text) == visible:
            restored = replace(
                record,
                revision=record.revision + 1,
                stats_status="accepted",
                excluded_from_stats=False,
                source_kind=SourceKind.OVERLAY,
                source_instance="skip-recovery",
                captured_at_utc=stamp,
                first_seen_at_utc=stamp,
                first_seen_monotonic_ns=now_ns,
            )
            self._publish_record(restored)
            return (TextDomainEvent(TextEventKind.STATS_READY, restored),)
        observation = TextObservation(
            observation_id=str(uuid.uuid4()),
            source_kind=SourceKind.OVERLAY,
            source_instance="skip-recovery",
            raw_text=text,
            captured_at_utc=stamp,
            emitted_at_utc=stamp,
            received_at_utc=stamp,
            received_monotonic_ns=now_ns,
            skip_overlay=True,
            metadata={"scene": scene, "skip_landing_confirmed": True},
        )
        result = self._ingest(observation, now=stamp, now_monotonic_ns=now_ns, track_stats=False)
        return result.events + self.freeze(result.ack.line_id, now=stamp) if result.ack.line_id else ()

    def ingest(
        self,
        observation: TextObservation,
        *,
        now: datetime | None = None,
        now_monotonic_ns: int | None = None,
    ) -> IngressResult:
        now_ns = now_monotonic_ns if now_monotonic_ns is not None else observation.received_monotonic_ns
        now_ns = now_ns or time.monotonic_ns()
        events = list(self.poll_skip_detection(now_ns))
        detector = self._skip_detector
        scene = str(observation.metadata.get("scene", "") or "")
        if detector is not None and scene != self._skip_scene:
            self._landing_record_id = None
            if detector.suspended and (old := self.get(self._skip_record_id)) is not None:
                events.append(
                    TextDomainEvent(
                        TextEventKind.SKIP_ENDED,
                        replace(
                            old,
                            metadata={**old.metadata, "skip_context_reset": True},
                        ),
                    )
                )
            events.extend(self._finish_pending(False, now))
            detector.reset()
            self._skip_scene = scene
        result = self._ingest(observation, now=now, now_monotonic_ns=now_ns)
        if result.ack.status is IngressStatus.ACCEPTED:
            self._landing_record_id = None
            record = result.events[-1].record
        events.extend(result.events)
        if self._uses_skip_detection(observation) and result.ack.status is IngressStatus.ACCEPTED:
            was_suspended = detector.suspended
            detector.observe(
                (observation.source_kind, observation.source_instance),
                observation.processed_text if observation.processed_text is not None else observation.raw_text,
                now_ns,
                skip_control=bool(observation.metadata.get("skip_control_active", False)),
            )
            self._skip_record_id = record.line_id
            if detector.suspended and not was_suspended:
                events.append(TextDomainEvent(TextEventKind.SKIP_STARTED, record))
            for row in self._journal.for_exclusion(detector.confirmed):
                events.append(self._classify_stats(row, True))
        return IngressResult(result.ack, tuple(events))

    def _ingest(
        self,
        observation: TextObservation,
        *,
        now: datetime | None = None,
        now_monotonic_ns: int | None = None,
        track_stats: bool = True,
    ) -> IngressResult:
        now = normalize_utc(now or utc_now())
        now_monotonic_ns = (
            int(now_monotonic_ns)
            if now_monotonic_ns is not None
            else int(observation.received_monotonic_ns or time.monotonic_ns())
        )
        if not observation.observation_id or not observation.raw_text:
            self.metrics.rejected += 1
            return IngressResult(
                IngressAck(IngressStatus.REJECTED, observation.observation_id, reason="empty observation id or text")
            )
        if not self._journal.observe(observation.observation_id, self.max_observation_ids):
            self.metrics.duplicates += 1
            return IngressResult(
                IngressAck(IngressStatus.DUPLICATE, observation.observation_id, reason="idempotent retry")
            )

        full_processed = observation.processed_text if observation.processed_text is not None else observation.raw_text
        if not full_processed:
            self.metrics.rejected += 1
            return IngressResult(
                IngressAck(IngressStatus.REJECTED, observation.observation_id, reason="empty processed text")
            )

        source_text_key = self._source_text_key(observation)
        sequence, has_pending, newest, current, prior = self._journal.context(
            self._open_line_id, source_text_key if observation.remove_matching_prefix else None
        )
        decision = None
        if self._classify is not None:
            decision = text_correlation.decide(
                self._classify,
                observation,
                full_processed,
                source_text_key[-1],
                now_monotonic_ns,
                newest,
                current,
                prior,
                self._open_deadline_monotonic_ns,
                (
                    int(self.same_source_dedup_window.total_seconds() * 1e9),
                    int(self.cross_source_window.total_seconds() * 1e9),
                    self.cross_source_similarity,
                ),
            )
        if decision is None or self._shadow_correlation:
            reference = self._classify_reference(observation, full_processed, now_monotonic_ns, newest, current, prior)
            if decision is not None and decision != reference:
                from GameSentenceMiner.util.logging_config import logger

                logger.warning("Native dialogue classification differs from the reference")
            decision = reference
        action, reason, suffix = decision
        processed = suffix if suffix is not None else full_processed
        if action in ("duplicate_newest", "duplicate_open"):
            matched = newest if action == "duplicate_newest" else current
            self.metrics.duplicates += 1
            return IngressResult(
                IngressAck(
                    IngressStatus.DUPLICATE,
                    observation.observation_id,
                    line_id=matched.line_id,
                    stream_sequence=matched.stream_sequence,
                    revision=matched.revision,
                    reason=reason,
                    matched_source=matched.source_kind.value,
                )
            )
        if action == "revise":
            updated = replace(
                current,
                revision=current.revision + 1,
                stats_status=(
                    "pending_manual"
                    if current.stats_status == "pending" and observation.source_kind not in AUTOMATIC_SOURCES
                    else current.stats_status
                ),
                raw_text=observation.raw_text,
                text=processed,
                source_kind=observation.source_kind,
                source_instance=observation.source_instance,
                source_display_name=observation.source_display_name,
                observation_ids=current.observation_ids + (observation.observation_id,),
                captured_at_utc=min(current.captured_at_utc, observation.captured_at_utc),
                copy_to_clipboard=current.copy_to_clipboard or observation.copy_to_clipboard,
                excluded_from_stats=current.excluded_from_stats and observation.excluded_from_stats,
                relay_only=current.relay_only and observation.relay_only,
                skip_overlay=current.skip_overlay and observation.skip_overlay,
                metadata=observation.metadata,
            )
            self._publish_record(
                updated,
                source=(source_text_key, (full_processed, updated.line_id)),
                observed_ns=now_monotonic_ns if track_stats else None,
            )
            self._set_deadline(observation, now_monotonic_ns)
            self.metrics.accepted += 1
            self.metrics.updated += 1
            event = TextDomainEvent(TextEventKind.UPDATED, updated)
            return IngressResult(
                IngressAck(
                    IngressStatus.ACCEPTED,
                    observation.observation_id,
                    line_id=updated.line_id,
                    stream_sequence=updated.stream_sequence,
                    revision=updated.revision,
                ),
                (event,),
            )

        events: list[TextDomainEvent] = []
        is_speech = observation.source_kind is SourceKind.SPEECH_RECOGNITION
        if is_speech and current is not None and current.state is TextRecordState.PROVISIONAL:
            events.extend(self.freeze(current.line_id, now=now))

        stats_status = "accepted"
        if self._uses_skip_detection(observation):
            stats_status = "skipped" if self._skip_detector.confirmed else "pending"
        elif has_pending and not observation.excluded_from_stats and not observation.relay_only:
            stats_status = "pending_manual"
        record = TextRecordSnapshot(
            line_id=str(uuid.uuid4()),
            session_id=self.session_id,
            stream_sequence=sequence + 1,
            revision=1,
            state=TextRecordState.PROVISIONAL if is_speech else TextRecordState.FROZEN,
            stats_status=stats_status,
            raw_text=observation.raw_text,
            text=processed,
            source_kind=observation.source_kind,
            source_instance=observation.source_instance,
            source_display_name=observation.source_display_name,
            observation_ids=(observation.observation_id,),
            captured_at_utc=observation.captured_at_utc,
            first_seen_at_utc=now,
            first_seen_monotonic_ns=observation.received_monotonic_ns,
            finalized_at_utc=None if is_speech else now,
            copy_to_clipboard=observation.copy_to_clipboard,
            excluded_from_stats=observation.excluded_from_stats or stats_status == "skipped",
            relay_only=observation.relay_only,
            skip_overlay=observation.skip_overlay,
            metadata=observation.metadata,
            scene=str(observation.metadata.get("scene", "") or ""),
        )
        self._publish_record(
            record,
            append=True,
            source=(source_text_key, (full_processed, record.line_id)),
            observed_ns=now_monotonic_ns if track_stats else None,
        )
        if is_speech:
            self._open_line_id = record.line_id
            self._set_deadline(observation, now_monotonic_ns)
        self.metrics.accepted += 1
        self.metrics.appended += 1
        events.append(TextDomainEvent(TextEventKind.APPENDED, record))
        return IngressResult(
            IngressAck(
                IngressStatus.ACCEPTED,
                observation.observation_id,
                line_id=record.line_id,
                stream_sequence=record.stream_sequence,
                revision=record.revision,
            ),
            tuple(events),
        )

    def _classify_reference(self, observation, full, now_ns, newest, current, prior):
        if newest is not None and _compact(newest.text) == _compact(full):
            return "duplicate_newest", "same text as immediately previous record", None
        suffix = None
        if (
            observation.remove_matching_prefix
            and observation.source_kind is not SourceKind.SPEECH_RECOGNITION
            and prior
        ):
            previous_text, previous_id = prior
            if full == previous_text:
                if newest is not None and newest.line_id == previous_id:
                    return "duplicate_newest", "same full text as immediately previous source payload", None
            elif full.startswith(previous_text):
                suffix = full[len(previous_text) :].lstrip() or None
        processed = suffix if suffix is not None else full
        if newest is not None and self._correlates_frozen_duplicate(newest, observation, processed, now_ns):
            return "duplicate_newest", "correlated with newest frozen record", None
        if (
            current is not None
            and current.state is TextRecordState.PROVISIONAL
            and self._correlates(current, observation, processed, now_ns)
        ):
            if processed == current.text:
                return "duplicate_open", "same speech hypothesis", None
            if _compact(current.text).startswith(_compact(processed)) and not observation.metadata.get("speech_final"):
                return "duplicate_open", "shorter partial speech hypothesis", None
            return "revise", "", None
        return "append", "", suffix

    def _correlates(
        self,
        current: TextRecordSnapshot,
        observation: TextObservation,
        processed: str,
        now_monotonic_ns: int,
    ) -> bool:
        current_text = _compact(current.text)
        incoming_text = _compact(processed)
        if (
            current.source_kind is not SourceKind.SPEECH_RECOGNITION
            or observation.source_kind is not SourceKind.SPEECH_RECOGNITION
        ):
            return False
        if not current_text or not incoming_text:
            return False
        if current.stats_status == "skipped":
            return False
        if current.relay_only != observation.relay_only:
            return False
        incoming_scene = str(observation.metadata.get("scene", "") or "")
        if current.scene and incoming_scene and current.scene != incoming_scene:
            return False
        age_ns = max(0, now_monotonic_ns - current.first_seen_monotonic_ns)
        if observation.source_kind is current.source_kind:
            return bool(
                observation.source_instance == current.source_instance
                and (
                    (
                        incoming_text == current_text
                        and age_ns <= int(self.same_source_dedup_window.total_seconds() * 1_000_000_000)
                    )
                    or (
                        observation.merge_fragments
                        and self._open_deadline_monotonic_ns is not None
                        and now_monotonic_ns <= self._open_deadline_monotonic_ns
                    )
                )
            )
        return False

    def _correlates_frozen_duplicate(
        self,
        newest: TextRecordSnapshot,
        observation: TextObservation,
        processed: str,
        now_monotonic_ns: int,
    ) -> bool:
        if (
            newest.state is not TextRecordState.FROZEN
            or newest.source_kind is SourceKind.SPEECH_RECOGNITION
            or observation.source_kind is SourceKind.SPEECH_RECOGNITION
            or newest.relay_only != observation.relay_only
            or newest.stats_status == "skipped"
            and observation.metadata.get("skip_landing_confirmed")
        ):
            return False
        current_text = _compact(newest.text)
        incoming_text = _compact(processed)
        incoming_scene = str(observation.metadata.get("scene", "") or "")
        if newest.scene and incoming_scene and newest.scene != incoming_scene:
            return False
        if not current_text or not incoming_text:
            return False
        age_ns = max(0, now_monotonic_ns - newest.first_seen_monotonic_ns)
        if observation.source_kind is newest.source_kind:
            return bool(
                observation.source_instance == newest.source_instance
                and incoming_text == current_text
                and age_ns <= int(self.same_source_dedup_window.total_seconds() * 1_000_000_000)
            )
        if age_ns > int(self.cross_source_window.total_seconds() * 1_000_000_000):
            return False
        if incoming_text == current_text:
            return True
        from rapidfuzz import fuzz

        return fuzz.ratio(current_text, incoming_text) >= self.cross_source_similarity

    def _set_deadline(self, observation: TextObservation, now_monotonic_ns: int) -> None:
        delay_seconds = self.freeze_delay_seconds(observation)
        self._open_deadline_monotonic_ns = now_monotonic_ns + int(delay_seconds * 1_000_000_000)

    @staticmethod
    def _source_text_key(observation: TextObservation) -> tuple[str, str, bool, str]:
        return (
            observation.source_kind.value,
            observation.source_instance,
            observation.relay_only,
            str(observation.metadata.get("scene", "") or ""),
        )

    def freeze_delay_seconds(self, observation: TextObservation) -> float:
        """Only speech stays open for corrections; other sources arrive complete."""
        if observation.source_kind is not SourceKind.SPEECH_RECOGNITION:
            return 0.0
        return max(0, int(observation.revision_window_ms)) / 1000

    def freeze(self, line_id: str, *, now: datetime | None = None) -> tuple[TextDomainEvent, ...]:
        record = self.get(line_id)
        if record is None or record.state is not TextRecordState.PROVISIONAL:
            return ()
        frozen = replace(
            record,
            revision=record.revision + 1,
            state=TextRecordState.FROZEN,
            finalized_at_utc=normalize_utc(now or utc_now()),
        )
        self._publish_record(frozen)
        if self._open_line_id == line_id:
            self._open_line_id = None
            self._open_deadline_monotonic_ns = None
        self.metrics.frozen += 1
        return (TextDomainEvent(TextEventKind.FROZEN, frozen),)

    def freeze_due(
        self,
        *,
        now: datetime | None = None,
        now_monotonic_ns: int | None = None,
    ) -> tuple[TextDomainEvent, ...]:
        now = normalize_utc(now or utc_now())
        monotonic_now = time.monotonic_ns() if now_monotonic_ns is None else int(now_monotonic_ns)
        if (
            self._open_line_id
            and self._open_deadline_monotonic_ns is not None
            and monotonic_now >= self._open_deadline_monotonic_ns
        ):
            return self.freeze(self._open_line_id, now=now)
        return ()

    def snapshot(self, max_records: int | None = None) -> TextStreamSnapshot:
        if max_records is not None:
            max_records = max(0, min(max_records, maxsize))
        return TextStreamSnapshot(self.session_id, *self._journal.snapshot(max_records))

    def expire_before(self, cutoff: datetime) -> tuple[TextDomainEvent, ...]:
        return tuple(
            TextDomainEvent(
                TextEventKind.EXPIRED, replace(record, revision=record.revision + 1, state=TextRecordState.EXPIRED)
            )
            for record in self._journal.expire(normalize_utc(cutoff))
        )

    def get(self, line_id: str | None) -> TextRecordSnapshot | None:
        return self._journal.get(line_id)

    def _publish_record(self, record, *, append=False, source=None, observed_ns=None):
        self._journal.publish(
            record.line_id,
            record,
            append,
            (
                record.state is TextRecordState.FROZEN,
                record.stats_status,
                observed_ns if record.stats_status in ("pending", "pending_manual") else None,
            ),
            source,
        )


@dataclass(frozen=True)
class IngestCommand:
    observation: TextObservation


@dataclass(frozen=True)
class FreezeCommand:
    line_id: str


@dataclass(frozen=True)
class SnapshotCommand:
    max_records: int | None = None


@dataclass(frozen=True)
class FinishStatsCommand:
    pass


@dataclass(frozen=True)
class RecoverLandingCommand:
    text: str
    scene: str


TextCommand = IngestCommand | FreezeCommand | SnapshotCommand | FinishStatsCommand | RecoverLandingCommand
TextCommandResult = IngressResult | tuple[TextDomainEvent, ...] | TextStreamSnapshot


class TextCoordinatorActor(Actor[TextCommand, TextCommandResult]):
    def __init__(
        self,
        *,
        state: TextCoordinatorState | None = None,
        subscriber: Callable[[TextDomainEvent], None] | None = None,
        retention_provider: Callable[[], timedelta | None] | None = None,
        schedule_freeze: Callable[[str, float], None] | None = None,
        capacity: int = 2048,
    ) -> None:
        super().__init__(
            "gsm-text-coordinator",
            capacity=capacity,
            policy=MailboxPolicy.ORDERED,
            execution_class=ExecutionClass.LATENCY,
        )
        self.state = state or TextCoordinatorState()
        self._subscribers: list[Callable[[TextDomainEvent], None]] = []
        if subscriber is not None:
            self._subscribers.append(subscriber)
        self._owner_thread_id: int | None = None
        self._retention_provider = retention_provider
        self._schedule_freeze = schedule_freeze
        self._pending_publications: deque[tuple[TextDomainEvent, int]] = deque()
        self._publication_capacity = capacity * 2

    def subscribe(self, subscriber: Callable[[TextDomainEvent], None]) -> None:
        if self.is_alive:
            raise RuntimeError("Text subscribers must be registered before startup")
        self._subscribers.append(subscriber)

    def on_start(self) -> None:
        self._owner_thread_id = threading.get_ident()

    def handle(self, message: TextCommand) -> TextCommandResult:
        if isinstance(message, IngestCommand):
            self._drain_publications()
            if len(self._pending_publications) >= self._publication_capacity:
                return IngressResult(
                    IngressAck(
                        IngressStatus.BACKPRESSURED,
                        message.observation.observation_id,
                        reason="text projection mailbox is backpressured",
                    )
                )
            result = self.state.ingest(message.observation)
            self._publish(result.events)
            if (
                self._schedule_freeze is not None
                and result.ack.status is IngressStatus.ACCEPTED
                and result.ack.line_id is not None
                and self.state.get(result.ack.line_id).state is TextRecordState.PROVISIONAL
            ):
                self._schedule_freeze(
                    result.ack.line_id,
                    self.state.freeze_delay_seconds(message.observation),
                )
            return result
        if isinstance(message, FreezeCommand):
            events = self.state.freeze(message.line_id)
            self._publish(events)
            return events
        if isinstance(message, SnapshotCommand):
            return self.state.snapshot(message.max_records)
        if isinstance(message, (FinishStatsCommand, RecoverLandingCommand)):
            events = (
                self.state.finish_stats()
                if isinstance(message, FinishStatsCommand)
                else self.state.recover_skip_landing(message.text, message.scene)
            )
            self._publish(events)
            return events
        raise TypeError(f"Unsupported text command: {type(message)!r}")

    def on_idle(self) -> None:
        self._drain_publications()
        if len(self._pending_publications) >= self._publication_capacity:
            return
        if self._schedule_freeze is None:
            self._publish(self.state.freeze_due())
        self._publish(self.state.poll_skip_detection())
        if self._retention_provider is not None:
            retention = self._retention_provider()
            if retention is not None:
                self._publish(self.state.expire_before(utc_now() - retention))

    def _publish(self, events: tuple[TextDomainEvent, ...]) -> None:
        for event in events:
            self._pending_publications.append((event, 0))
        self._drain_publications()

    def _drain_publications(self) -> None:
        while self._pending_publications:
            event, subscriber_index = self._pending_publications[0]
            if subscriber_index >= len(self._subscribers):
                self._pending_publications.popleft()
                continue
            try:
                self._subscribers[subscriber_index](event)
            except MailboxFull:
                return
            self._pending_publications[0] = (event, subscriber_index + 1)
