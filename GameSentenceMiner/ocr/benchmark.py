"""Session-only OCR versus texthook recording, owned by the backend.

Record emitted text observations before authoritative intake can correlate or
deduplicate them. Automatic OCR is rejected while recording; hook and explicit
manual sources continue through the normal pipeline. No history is held in RAM.
"""

import atexit
import csv
import json
import os
import threading
import time
import uuid
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path

from GameSentenceMiner.text_pipeline.models import SourceKind, normalize_utc
from GameSentenceMiner.util.data_directory import get_app_directory

BENCHMARK_TOPIC = "dev.ocr_benchmark"
FIELDS = (
    "sequence",
    "recorded_at_utc",
    "captured_at_utc",
    "elapsed_ms",
    "source",
    "source_instance",
    "engine",
    "model",
    "model_revision",
    "scene",
    "observation_id",
    "suppressed",
    "text",
    "metadata_json",
)
RECORDED_SOURCES = frozenset(
    {
        SourceKind.TEXTHOOK,
        SourceKind.OCR,
        SourceKind.OVERLAY,
        SourceKind.OCR_MANUAL,
        SourceKind.SCREEN_CROPPER,
        SourceKind.SECONDARY,
        SourceKind.HOTKEY,
        SourceKind.MANUAL,
    }
)


class OCRBenchmarkRecorder:
    def __init__(self, root=None, *, on_error=None):
        self.root = Path(root) if root is not None else None
        self.directory = None
        self._lock = threading.RLock()
        self._enabled = False
        self._file = None
        self._writer = None
        self._error = ""
        self._counts = Counter()
        self._dropped = 0
        self._sequence = 0
        self._session = {}
        self._started_monotonic = 0.0
        self._on_error = on_error

    @property
    def enabled(self):
        with self._lock:
            return self._enabled

    def status(self):
        with self._lock:
            return {
                "enabled": self._enabled,
                "directory": str(self.directory) if self.directory else "",
                "csv_path": str(self.directory / "events.csv") if self.directory else "",
                "counts": dict(self._counts),
                "dropped_rows": self._dropped,
                "error": self._error,
            }

    def set_enabled(self, enabled, *, settings=None):
        with self._lock:
            if enabled == self._enabled:
                return self.status()
            if enabled:
                root = self.root if self.root is not None else Path(get_app_directory()) / "ocr-benchmarks"
                now = datetime.now(UTC)
                self.directory = root / f"{now:%Y%m%dT%H%M%SZ}_{uuid.uuid4().hex[:8]}"
                self.directory.mkdir(parents=True, exist_ok=False)
                self._error = ""
                self._counts.clear()
                self._dropped = self._sequence = 0
                self._session = {
                    "schema": "gsm_ocr_benchmark_v1",
                    "started_at_utc": now.isoformat(),
                    "pid": os.getpid(),
                    "settings": settings or {},
                    "notes": "Text candidates before backend deduplication, plus raw overlay OCR attempts. Automatic OCR text intake is suppressed.",
                }
                try:
                    self._file = (self.directory / "events.csv").open("x", encoding="utf-8-sig", newline="")
                    self._writer = csv.DictWriter(self._file, fieldnames=FIELDS)
                    self._writer.writeheader()
                    self._file.flush()
                    self._write_summary()
                except OSError:
                    self._close()
                    raise
                self._started_monotonic = time.monotonic()
                self._enabled = True
            else:
                self._enabled = False
                self._close()
                self._session["ended_at_utc"] = datetime.now(UTC).isoformat()
                try:
                    self._write_summary()
                except OSError as error:
                    self._report_error(error)
            return self.status()

    def _write_summary(self):
        summary = {**self._session, "counts": dict(self._counts), "dropped_rows": self._dropped, "error": self._error}
        temporary = self.directory / "session.json.tmp"
        temporary.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary.replace(self.directory / "session.json")

    def _close(self):
        if self._file is not None:
            try:
                self._file.close()
            except OSError as error:
                self._report_error(error)
        self._file = self._writer = None

    def _report_error(self, error):
        if not self._error:
            self._error = str(error)
            if self._on_error:
                self._on_error(self._error)

    def _write_row(self, row):
        self._writer.writerow(row)
        # Keep the CSV usable while recording and preserve completed rows if
        # GSM crashes. fsync per observation would distort a timing benchmark.
        self._file.flush()

    def observe(
        self, source, text, *, captured_at=None, source_instance="", scene="", observation_id="", metadata=None
    ):
        with self._lock:
            if not self._enabled:
                return False
            metadata = metadata or {}
            suppressed = source is SourceKind.OCR or (
                source is SourceKind.OVERLAY and metadata.get("overlay_manual") is not True
            )
            # Overlay recognition is recorded at the engine boundary, before
            # hook-based corrections. Its optional text injection only needs
            # the intake gate; logging it again would count corrected text.
            if source is SourceKind.OVERLAY and metadata.get("overlay_stage") == "injection":
                return suppressed
            if source not in RECORDED_SOURCES:
                return suppressed
            if self._error:
                self._dropped += 1
                return suppressed
            now = datetime.now(UTC)
            self._sequence += 1
            model = metadata.get("ocr_model")
            model = model if isinstance(model, dict) else {}
            row = {
                "sequence": self._sequence,
                "recorded_at_utc": now.isoformat(),
                "captured_at_utc": normalize_utc(captured_at).isoformat() if captured_at else now.isoformat(),
                "elapsed_ms": round((time.monotonic() - self._started_monotonic) * 1000, 3),
                "source": source.value,
                "source_instance": source_instance,
                "engine": metadata.get("ocr_engine") or metadata.get("engine") or "",
                "model": model.get("size", ""),
                "model_revision": model.get("revision", ""),
                "scene": metadata.get("ocr_scene") or scene,
                "observation_id": observation_id,
                "suppressed": "true" if suppressed else "false",
                "text": text,
                "metadata_json": json.dumps(metadata, ensure_ascii=False, default=str),
            }
            try:
                self._write_row(row)
                self._counts[source.value] += 1
            except OSError as error:
                # Keep rejecting auto OCR even if the disk fills up, while
                # allowing hooked/manual text to continue normally.
                self._dropped += 1
                self._report_error(error)
            return suppressed


def _announce_error(error):
    from GameSentenceMiner.util.communication.electron_ipc import send_message
    from GameSentenceMiner.util.logging_config import logger

    logger.error(f"OCR benchmark recording failed: {error}. Automatic OCR remains suppressed until recording stops.")
    send_message("ocr_benchmark_error", {"error": error})


recorder = OCRBenchmarkRecorder(on_error=_announce_error)


def handle_benchmark_request(message):
    from GameSentenceMiner.util.config import configuration, electron_config

    if not configuration.is_dev:
        raise PermissionError("OCR benchmarking is only available in development builds")
    payload = message.get("data") or {}
    if "enabled" not in payload:
        return recorder.status()
    enabled = payload["enabled"]
    if not isinstance(enabled, bool):
        raise TypeError("enabled must be a boolean")
    settings = (
        {
            "ocr1": electron_config.get_ocr_ocr1(),
            "ocr2": electron_config.get_ocr_ocr2(),
            "two_pass": electron_config.get_ocr_two_pass_ocr(),
            "language": electron_config.get_ocr_language(),
            "scan_rate": electron_config.get_ocr_scan_rate(),
        }
        if enabled
        else None
    )
    if enabled:
        from GameSentenceMiner.ocr.vita_model_manager import get_model_status

        settings["vita_ocr"] = get_model_status()
        overlay = configuration.get_overlay_config()
        settings["overlay"] = {
            "engine": overlay.engine_v2,
            "inject_scanned_lines": overlay.inject_scanned_lines,
            "use_text_filtering": overlay.use_text_filtering,
            "adaptive_ocr_retries": overlay.adaptive_ocr_retries,
        }
    result = recorder.set_enabled(enabled, settings=settings)
    configuration.logger.info(f"OCR benchmark {'started' if enabled else 'stopped'}: {result['csv_path']}")
    return result


def stop_benchmark():
    recorder.set_enabled(False)


atexit.register(stop_benchmark)
