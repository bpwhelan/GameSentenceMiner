from __future__ import annotations

import threading
import time
import uuid
from collections import OrderedDict, deque
from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import datetime, timedelta

from rapidfuzz import fuzz

from GameSentenceMiner.util.concurrency.actor import Actor, MailboxFull, MailboxPolicy
from GameSentenceMiner.util.concurrency.resource_qos import ExecutionClass

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

SOURCE_PRIORITY = {
    SourceKind.UNKNOWN: 0,
    SourceKind.OVERLAY: 10,
    SourceKind.OCR: 20,
    SourceKind.OCR_MANUAL: 50,
    SourceKind.SECONDARY: 30,
    SourceKind.WEBSOCKET: 30,
    SourceKind.CLIPBOARD: 35,
    SourceKind.TEXTHOOK: 40,
    SourceKind.SPEECH_RECOGNITION: 40,
    SourceKind.HOTKEY: 50,
    SourceKind.SCREEN_CROPPER: 50,
    SourceKind.MANUAL: 60,
}


@dataclass
class TextCoordinatorMetrics:
    accepted: int = 0
    duplicates: int = 0
    rejected: int = 0
    appended: int = 0
    updated: int = 0
    frozen: int = 0


@dataclass(frozen=True)
class _SourceTextSnapshot:
    text: str
    line_id: str


def _compact(text: str) -> str:
    return "".join(str(text or "").split())


class TextCoordinatorState:
    """Single-thread-owned state machine for identity, order, revision, and freeze."""

    def __init__(
        self,
        *,
        session_id: str | None = None,
        cross_source_window: timedelta = timedelta(seconds=5),
        cross_source_similarity: int = 70,
        same_source_dedup_window: timedelta = timedelta(seconds=2),
        max_observation_ids: int = 20_000,
    ) -> None:
        self.session_id = session_id or str(uuid.uuid4())
        self.cross_source_window = cross_source_window
        self.cross_source_similarity = cross_source_similarity
        self.same_source_dedup_window = same_source_dedup_window
        self.max_observation_ids = max_observation_ids
        self.metrics = TextCoordinatorMetrics()
        self._records: list[TextRecordSnapshot] = []
        self._by_id: dict[str, TextRecordSnapshot] = {}
        self._seen_observations: OrderedDict[str, None] = OrderedDict()
        self._stream_sequence = 0
        self._record_sequence_offset = 0
        self._open_line_id: str | None = None
        self._open_deadline_monotonic_ns: int | None = None
        self._last_full_text_by_source: OrderedDict[tuple[SourceKind, str, bool, str], _SourceTextSnapshot] = (
            OrderedDict()
        )
        self._max_prefix_sources = 512

    def ingest(
        self,
        observation: TextObservation,
        *,
        now: datetime | None = None,
        now_monotonic_ns: int | None = None,
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
        if observation.observation_id in self._seen_observations:
            self.metrics.duplicates += 1
            return IngressResult(
                IngressAck(IngressStatus.DUPLICATE, observation.observation_id, reason="idempotent retry")
            )
        self._remember_observation(observation.observation_id)

        full_processed = observation.processed_text if observation.processed_text is not None else observation.raw_text
        if not full_processed:
            self.metrics.rejected += 1
            return IngressResult(
                IngressAck(IngressStatus.REJECTED, observation.observation_id, reason="empty processed text")
            )

        newest = self._records[-1] if self._records else None
        if newest is not None and _compact(newest.text) == _compact(full_processed):
            self.metrics.duplicates += 1
            return IngressResult(
                IngressAck(
                    IngressStatus.DUPLICATE,
                    observation.observation_id,
                    line_id=newest.line_id,
                    stream_sequence=newest.stream_sequence,
                    revision=newest.revision,
                    reason="same text as immediately previous record",
                    matched_source=newest.source_kind.value,
                )
            )

        processed = full_processed
        source_text_key = self._source_text_key(observation)
        previous_full_text = self._last_full_text_by_source.get(source_text_key)
        if observation.remove_matching_prefix and previous_full_text is not None:
            if full_processed == previous_full_text.text:
                previous_record = self._by_id.get(previous_full_text.line_id)
                if previous_record is not None and newest is not None and previous_record.line_id == newest.line_id:
                    self.metrics.duplicates += 1
                    return IngressResult(
                        IngressAck(
                            IngressStatus.DUPLICATE,
                            observation.observation_id,
                            line_id=previous_record.line_id,
                            stream_sequence=previous_record.stream_sequence,
                            revision=previous_record.revision,
                            reason="same full text as immediately previous source payload",
                            matched_source=previous_record.source_kind.value,
                        )
                    )
            elif full_processed.startswith(previous_full_text.text):
                suffix = full_processed[len(previous_full_text.text) :].lstrip()
                if suffix:
                    processed = suffix

        current = self._by_id.get(self._open_line_id or "")
        if (
            current is None
            and newest is not None
            and self._correlates_frozen_duplicate(
                newest,
                observation,
                processed,
                now_monotonic_ns,
            )
        ):
            self.metrics.duplicates += 1
            return IngressResult(
                IngressAck(
                    IngressStatus.DUPLICATE,
                    observation.observation_id,
                    line_id=newest.line_id,
                    stream_sequence=newest.stream_sequence,
                    revision=newest.revision,
                    reason="correlated with newest frozen record",
                    matched_source=newest.source_kind.value,
                )
            )
        if current is not None and current.state is TextRecordState.PROVISIONAL:
            correlation = self._correlates(current, observation, processed, now_monotonic_ns)
            if correlation:
                current_priority = SOURCE_PRIORITY[current.source_kind]
                incoming_priority = SOURCE_PRIORITY[observation.source_kind]
                if processed == current.text or incoming_priority < current_priority:
                    self.metrics.duplicates += 1
                    return IngressResult(
                        IngressAck(
                            IngressStatus.DUPLICATE,
                            observation.observation_id,
                            line_id=current.line_id,
                            stream_sequence=current.stream_sequence,
                            revision=current.revision,
                            reason="correlated lower-or-equal-quality observation",
                            matched_source=current.source_kind.value,
                        )
                    )
                updated_text = processed
                updated_raw_text = observation.raw_text
                if observation.source_kind is current.source_kind and observation.merge_fragments:
                    current_compact = _compact(current.text)
                    incoming_compact = _compact(processed)
                    # Recognizer hypotheses revise one utterance in place; they
                    # are not independent fragments like texthook emissions.
                    speech_hypothesis = observation.source_kind is SourceKind.SPEECH_RECOGNITION
                    final_speech_result = speech_hypothesis and bool(observation.metadata.get("speech_final"))
                    if current_compact.startswith(incoming_compact) and not final_speech_result:
                        self.metrics.duplicates += 1
                        return IngressResult(
                            IngressAck(
                                IngressStatus.DUPLICATE,
                                observation.observation_id,
                                line_id=current.line_id,
                                stream_sequence=current.stream_sequence,
                                revision=current.revision,
                                reason="shorter fragment of current provisional line",
                                matched_source=current.source_kind.value,
                            )
                        )
                    should_join_fragments = observation.source_kind is SourceKind.TEXTHOOK or (
                        not speech_hypothesis and fuzz.ratio(current_compact, incoming_compact) <= 50
                    )
                    if not incoming_compact.startswith(current_compact) and should_join_fragments:
                        updated_text = f"{current.text}\n{processed}"
                        updated_raw_text = f"{current.raw_text}\n{observation.raw_text}"

                updated = replace(
                    current,
                    revision=current.revision + 1,
                    raw_text=updated_raw_text,
                    text=updated_text,
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
                self._replace(updated)
                self._remember_full_source_text(source_text_key, full_processed, updated)
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
        if current is not None and current.state is TextRecordState.PROVISIONAL:
            events.extend(self.freeze(current.line_id, now=now))

        self._stream_sequence += 1
        record = TextRecordSnapshot(
            line_id=str(uuid.uuid4()),
            session_id=self.session_id,
            stream_sequence=self._stream_sequence,
            revision=1,
            state=TextRecordState.PROVISIONAL,
            raw_text=observation.raw_text,
            text=processed,
            source_kind=observation.source_kind,
            source_instance=observation.source_instance,
            source_display_name=observation.source_display_name,
            observation_ids=(observation.observation_id,),
            captured_at_utc=observation.captured_at_utc,
            first_seen_at_utc=now,
            first_seen_monotonic_ns=observation.received_monotonic_ns,
            copy_to_clipboard=observation.copy_to_clipboard,
            excluded_from_stats=observation.excluded_from_stats,
            relay_only=observation.relay_only,
            skip_overlay=observation.skip_overlay,
            metadata=observation.metadata,
            scene=str(observation.metadata.get("scene", "") or ""),
        )
        self._records.append(record)
        self._by_id[record.line_id] = record
        self._remember_full_source_text(source_text_key, full_processed, record)
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

    def _correlates(
        self,
        current: TextRecordSnapshot,
        observation: TextObservation,
        processed: str,
        now_monotonic_ns: int,
    ) -> bool:
        current_text = _compact(current.text)
        incoming_text = _compact(processed)
        if not current_text or not incoming_text:
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
        return bool(
            age_ns <= int(self.cross_source_window.total_seconds() * 1_000_000_000)
            and (
                incoming_text == current_text or fuzz.ratio(current_text, incoming_text) >= self.cross_source_similarity
            )
        )

    def _correlates_frozen_duplicate(
        self,
        newest: TextRecordSnapshot,
        observation: TextObservation,
        processed: str,
        now_monotonic_ns: int,
    ) -> bool:
        if newest.state is not TextRecordState.FROZEN or newest.relay_only != observation.relay_only:
            return False
        current_text = _compact(newest.text)
        incoming_text = _compact(processed)
        if not current_text or not incoming_text:
            return False
        age_ns = max(0, now_monotonic_ns - newest.first_seen_monotonic_ns)
        if observation.source_kind is newest.source_kind:
            return bool(
                observation.source_instance == newest.source_instance
                and incoming_text == current_text
                and age_ns <= int(self.same_source_dedup_window.total_seconds() * 1_000_000_000)
            )
        incoming_priority = SOURCE_PRIORITY[observation.source_kind]
        current_priority = SOURCE_PRIORITY[newest.source_kind]
        return bool(
            incoming_priority <= current_priority
            and age_ns <= int(self.cross_source_window.total_seconds() * 1_000_000_000)
            and (
                incoming_text == current_text or fuzz.ratio(current_text, incoming_text) >= self.cross_source_similarity
            )
        )

    def _set_deadline(self, observation: TextObservation, now_monotonic_ns: int) -> None:
        delay_seconds = self.freeze_delay_seconds(observation)
        self._open_deadline_monotonic_ns = now_monotonic_ns + int(delay_seconds * 1_000_000_000)

    @staticmethod
    def _source_text_key(observation: TextObservation) -> tuple[SourceKind, str, bool, str]:
        return (
            observation.source_kind,
            observation.source_instance,
            observation.relay_only,
            str(observation.metadata.get("scene", "") or ""),
        )

    def _remember_full_source_text(
        self,
        source_text_key: tuple[SourceKind, str, bool, str],
        text: str,
        record: TextRecordSnapshot,
    ) -> None:
        self._last_full_text_by_source[source_text_key] = _SourceTextSnapshot(text=text, line_id=record.line_id)
        self._last_full_text_by_source.move_to_end(source_text_key)
        while len(self._last_full_text_by_source) > self._max_prefix_sources:
            self._last_full_text_by_source.popitem(last=False)

    def freeze_delay_seconds(self, observation: TextObservation) -> float:
        """Return the full correlation window the coordinator promises for an observation."""
        window_ms = max(0, int(observation.revision_window_ms))
        if SOURCE_PRIORITY[observation.source_kind] < SOURCE_PRIORITY[SourceKind.TEXTHOOK]:
            window_ms = max(window_ms, int(self.cross_source_window.total_seconds() * 1000))
        return window_ms / 1000

    def freeze(self, line_id: str, *, now: datetime | None = None) -> tuple[TextDomainEvent, ...]:
        record = self._by_id.get(line_id)
        if record is None or record.state is not TextRecordState.PROVISIONAL:
            return ()
        frozen = replace(
            record,
            revision=record.revision + 1,
            state=TextRecordState.FROZEN,
            finalized_at_utc=normalize_utc(now or utc_now()),
        )
        self._replace(frozen)
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

    def snapshot(self) -> TextStreamSnapshot:
        return TextStreamSnapshot(self.session_id, self._stream_sequence, tuple(self._records))

    def expire_before(self, cutoff: datetime) -> tuple[TextDomainEvent, ...]:
        cutoff = normalize_utc(cutoff)
        events = []
        remove_count = 0
        for record in self._records:
            if record.first_seen_at_utc >= cutoff or record.state is TextRecordState.PROVISIONAL:
                break
            remove_count += 1
            if record.state is TextRecordState.FROZEN:
                expired = replace(record, revision=record.revision + 1, state=TextRecordState.EXPIRED)
                events.append(TextDomainEvent(TextEventKind.EXPIRED, expired))
        if remove_count:
            removed = self._records[:remove_count]
            del self._records[:remove_count]
            self._record_sequence_offset += remove_count
            for record in removed:
                self._by_id.pop(record.line_id, None)
        return tuple(events)

    def get(self, line_id: str) -> TextRecordSnapshot | None:
        return self._by_id.get(line_id)

    def _replace(self, record: TextRecordSnapshot) -> None:
        index = record.stream_sequence - self._record_sequence_offset - 1
        self._records[index] = record
        self._by_id[record.line_id] = record

    def _remember_observation(self, observation_id: str) -> None:
        self._seen_observations[observation_id] = None
        self._seen_observations.move_to_end(observation_id)
        while len(self._seen_observations) > self.max_observation_ids:
            self._seen_observations.popitem(last=False)


@dataclass(frozen=True)
class IngestCommand:
    observation: TextObservation


@dataclass(frozen=True)
class FreezeCommand:
    line_id: str


@dataclass(frozen=True)
class SnapshotCommand:
    pass


TextCommand = IngestCommand | FreezeCommand | SnapshotCommand
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
            return self.state.snapshot()
        raise TypeError(f"Unsupported text command: {type(message)!r}")

    def on_idle(self) -> None:
        self._drain_publications()
        if len(self._pending_publications) >= self._publication_capacity:
            return
        if self._schedule_freeze is None:
            self._publish(self.state.freeze_due())
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
