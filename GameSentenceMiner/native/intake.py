"""Projection client for the desktop-owned dialogue stream."""

import asyncio
import base64
import json
import os
import threading
import time
import uuid
from dataclasses import asdict
from datetime import UTC, datetime

from GameSentenceMiner.native.runtime import backend_manages
from GameSentenceMiner.text_pipeline.models import (
    SourceKind,
    TextDomainEvent,
    TextEventKind,
    TextRecordSnapshot,
    TextRecordState,
    TextStreamSnapshot,
)


def managed():
    return backend_manages("GSM_NATIVE_TEXT_INTAKE")


def native_reader():
    return os.environ.get("GSM_NATIVE_READER") == "1" and managed()


def native_controls():
    return os.environ.get("GSM_NATIVE_INTAKE_CONTROLS") == "1" and native_reader()


def request(action, **fields):
    from GameSentenceMiner.util.communication import bus_client

    bus = bus_client.get_bus()
    result = bus.request(bus_client.MAIN, "text.intake", {"action": action, **fields}, timeout=5)
    if isinstance(result, dict) and "transfer" in result:
        raw = bytearray()
        while len(raw) < result["size"]:
            part = bus.request(
                bus_client.MAIN,
                "text.intake",
                {"action": "chunk", "transfer": result["transfer"], "offset": len(raw)},
                timeout=5,
            )
            raw.extend(base64.b64decode(part, validate=True))
        return json.loads(raw)
    return result


def _record(data):
    fields = dict(data)
    for key in ("captured_at_utc", "first_seen_at_utc", "finalized_at_utc"):
        if fields[key] is not None:
            fields[key] = datetime.fromisoformat(fields[key])
    fields["source_kind"] = SourceKind(fields["source_kind"])
    fields["state"] = TextRecordState(fields["state"])
    fields["observation_ids"] = tuple(fields["observation_ids"])
    return TextRecordSnapshot(**fields)


def _configuration():
    from GameSentenceMiner import gametext as gt

    config = gt.get_config()
    general = config.general
    from GameSentenceMiner.tokenizer import get_sudachi_dictionary
    from GameSentenceMiner.util.config.configuration import get_master_config, get_stats_config
    from GameSentenceMiner.util.config.feature_flags import is_tokenization_enabled

    stats = get_stats_config()
    return {
        "projection": {
            "collect": not config.advanced.dont_collect_stats,
            "dictionary": get_sudachi_dictionary() if is_tokenization_enabled() else None,
            "longplay": config.features.generate_longplay,
            "gap": stats.session_gap_seconds,
            "punctuation": stats.extra_punctuation_regex,
            "repetitions": stats.regex_out_repetitions,
            "discord": asdict(get_master_config().discord),
        },
        "policy": {
            "max_chars": gt.get_texthook_max_buffer_size(),
            "processing": asdict(config.text_processing),
            "language": general.target_language,
            "scene": gt.gsm_state.current_game or "",
            "remove_prefix": general.remove_matching_prefix_on_subsequent_lines,
            "paused": bool(gt.gsm_state.text_input_paused) if native_controls() else gt.is_text_intake_paused(),
            "relay": gt.should_relay_outputs_when_text_intake_paused(),
            "benchmark": gt.ocr_benchmark.recorder.enabled,
        },
        "sources": {
            "clipboard": general.use_clipboard,
            "both": general.use_both_clipboard_and_websocket,
            "inhouse": gt.is_inhouse_source_active(),
            "websockets": {uri: gt.resolve_websocket_source_name(uri) for uri in gt._get_enabled_websocket_uris()}
            if general.use_websocket
            else {},
            "output_ports": [int(p) for p in gt.get_output_websocket_ports() if p.isdigit()],
        },
        "retention": int(max(0, gt.gsm_state.replay_buffer_length or 0)) + 5,
    }


def _local_time(epoch):
    return datetime.fromtimestamp(epoch, UTC).astimezone().replace(tzinfo=None)


def reader_lines(scope="active", line_id=""):
    """Materialize linked GameLines only for a clip, review or other explicit Python request."""
    from GameSentenceMiner.util.text_log import GameLine

    result = request("readerLines", scope=scope, id=str(line_id))
    lines = {}
    for row in result["lines"]:
        line = GameLine(
            id=row["id"],
            text=row["text"],
            time=_local_time(row["time_epoch"]),
            prev=None,
            next=None,
            index=row["index"],
            scene=row["scene"],
            source=row["source"],
            source_padding=row["source_padding"],
            session_id=row["session_id"],
            revision=row["revision"],
            stream_sequence=row["stream_sequence"],
            source_instance=row["source_instance"],
            state=row["state"],
            first_seen_time=_local_time(row["first_seen_time_epoch"]),
            finalized_time=datetime.fromisoformat(row["finalized_at"]).astimezone().replace(tzinfo=None)
            if row["finalized_at"]
            else None,
            excluded_from_stats=row["excluded_from_stats"],
            translation=row["translation"],
            TL=row["translation"],
        )
        if row["mined_time_epoch"] is not None:
            line.mined_time = _local_time(row["mined_time_epoch"])
        lines[line.id] = line
    for row in result["lines"]:
        line = lines[row["id"]]
        line.prev = lines.get(row["prev_id"])
        line.next = lines.get(row["next_id"])
    return [lines[key] for key in result["ids"]]


def overlay_scan():
    from GameSentenceMiner.util.config.configuration import gsm_state
    from GameSentenceMiner.util.text_log import GameLine

    if not native_reader():
        return gsm_state.last_overlay_scan_line
    row = request("readerScan")
    if row:
        return GameLine(
            id=row["id"],
            text=row["text"],
            time=_local_time(row["time_epoch"]),
            prev=None,
            next=None,
            index=-1,
            scene=row["scene"],
            source="overlay",
            source_padding=row["source_padding"],
            excluded_from_stats=True,
        )
    return None


class DesktopTextRuntime:
    def __init__(self, projector, idle_callback):
        self._projector = projector
        self._idle = idle_callback
        self._session = str(uuid.uuid4())
        self.desktop_outputs = False
        self._accepted_lines = None
        self._ready = threading.Event()
        self._stopping = threading.Event()
        self._progress = threading.Condition()
        self._cursor = self._target = 0
        self._producer_locks = {}
        self._thread = None
        self._error = ""

    def start(self):
        if self._thread is None:
            self._thread = threading.Thread(target=self._run, name="gsm-text-projection", daemon=True)
            self._thread.start()

    @property
    def ready(self):
        return self._ready.is_set()

    def wait_ready(self):
        while not self._stopping.is_set() and not self._ready.wait(1):
            pass

    def _run(self):
        from GameSentenceMiner import gametext as gt

        previous = None
        refresh = idle = 0
        while not self._stopping.is_set():
            try:
                now = time.monotonic()
                if now >= refresh or previous is None:
                    config = _configuration()
                    if previous is None:
                        reply = request(
                            "start",
                            session=self._session,
                            desktop_outputs=True,
                            native_reader=native_reader(),
                            **config,
                        )
                        self.desktop_outputs = isinstance(reply, dict) and reply.get("desktop_outputs") is True
                        self._ready.set()
                    elif config != previous:
                        request("configure", **config)
                    previous = config
                    refresh = now + 1
                batch = request("next", after=self._cursor)
                if "paused" in batch:
                    gt.gsm_state.text_input_paused = batch["paused"]
                previous_count = self._accepted_lines
                self._accepted_lines = batch.get("accepted_lines")
                if native_reader():
                    if batch.get("last_line_received"):
                        gt.gsm_status.last_line_received = batch["last_line_received"]
                    if previous_count != self._accepted_lines:
                        from GameSentenceMiner.web.live_goals import schedule_live_goals_update

                        schedule_live_goals_update()
                status = batch["sources"]
                gt.gsm_status.clipboard_enabled = status["clipboard"]
                gt.gsm_status.websockets_connected = status["websockets"]
                for event in batch["events"]:
                    self._project(event)
                    with self._progress:
                        self._cursor += 1
                        self._progress.notify_all()
                if now >= idle:
                    if not native_reader():
                        self._idle()
                    idle = now + 1
                self._error = ""
            except Exception as exc:  # noqa: BLE001 - reconnect without losing the last delivered cursor
                previous = None
                self._ready.clear()
                if self._error != str(exc):
                    gt.logger.warning(f"Desktop text projection interrupted: {exc}")
                self._error = str(exc)
                self._stopping.wait(0.25)

    def _project(self, event):
        from GameSentenceMiner import gametext as gt

        if event["kind"] == "benchmark":
            row = event["record"]
            gt.ocr_benchmark.recorder.observe(
                SourceKind(row["source"]),
                row["text"],
                captured_at=datetime.fromisoformat(row["captured_at"]),
                source_instance=row["source_instance"],
                scene=row["scene"],
                observation_id=row["observation_id"],
                metadata=row["metadata"],
            )
        elif event["kind"] == "redundant":
            if os.environ.get("GSM_ELECTRON"):
                gt.send_message("ocr_hook_redundant", {})
        elif native_reader():
            # Longplay alone opts into ordered finalized-line callbacks.
            lines = reader_lines("line", event["record"]["line_id"])
            if lines:
                gt.obs.add_longplay_srt_line(lines[0].time, lines[0])
        else:
            self._projector(
                TextDomainEvent(TextEventKind(event["kind"]), _record(event["record"])),
                desktop_outputs=self.desktop_outputs,
            )

    async def from_async_producer(self, submit):
        # Recognizers enqueue partials and finals on their event loop in order.
        # Parallel blocking bus requests could otherwise admit the final first.
        loop = asyncio.get_running_loop()
        with self._progress:
            if loop not in self._producer_locks:
                self._producer_locks[loop] = asyncio.Lock()
            lane = self._producer_locks[loop]
        async with lane:
            return await asyncio.to_thread(submit)

    def submit(self, payload, wait=False):
        observation_id = payload.get("observation_id") or payload.get("observationId") or str(uuid.uuid4())
        payload = {**payload, "observation_id": observation_id}
        if not self._ready.wait(1):
            return {
                "status": "backpressured",
                "observation_id": observation_id,
                "reason": "desktop text intake is starting",
            }
        ack = request("submit", payload=payload)
        self._track(ack.pop("cursor", 0), wait)
        return ack

    def _track(self, cursor, wait):
        with self._progress:
            self._target = max(self._target, cursor)
            return not wait or self._progress.wait_for(lambda: self._cursor >= cursor, 2)

    def wait_projected(self, timeout=1):
        with self._progress:
            return self._progress.wait_for(lambda: self._cursor >= self._target, timeout)

    def freeze(self, line_id, *, timeout=None):
        result = request("freeze", id=line_id)
        self._track(result["cursor"], True)
        return result["changed"]

    def recover_skip_landing(self, text, scene):
        return request("recover", text=text, scene=scene)["changed"]

    def snapshot(self, *, timeout=None, max_records=None):
        if not self._ready.wait(2):
            raise RuntimeError("Desktop text intake is starting")
        data = request("snapshot", limit=max_records)
        return TextStreamSnapshot(data["session_id"], data["snapshot_sequence"], tuple(map(_record, data["records"])))

    def health_snapshot(self):
        return {
            "state": "running" if self._ready.is_set() else "connecting",
            "healthy": not self._error,
            "owner": "desktop",
            "projected": self._cursor,
            "accepted_lines": self._accepted_lines,
            "receipt_log_owner": "desktop" if self.desktop_outputs else "python",
            "error": self._error,
        }

    def set_benchmark(self, enabled):
        if self._ready.wait(2):
            self._track(request("benchmark", enabled=enabled), not enabled)

    def stop(self):
        drained = False
        try:
            if self._ready.is_set():
                drained = self._track(request("finish")["cursor"], True)
        finally:
            self._stopping.set()
            if self._thread:
                self._thread.join(6)
        return drained and not self._thread.is_alive()
