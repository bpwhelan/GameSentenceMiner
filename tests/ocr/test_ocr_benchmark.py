import csv
import json
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

from GameSentenceMiner import gametext
from GameSentenceMiner.ocr.benchmark import OCRBenchmarkRecorder, handle_benchmark_request
from GameSentenceMiner.text_pipeline.models import IngressAck, IngressStatus, SourceKind


def read_rows(recorder):
    with open(recorder.status()["csv_path"], encoding="utf-8-sig", newline="") as stream:
        return list(csv.DictReader(stream))


def test_session_streams_both_sources_and_preserves_multiline_text(tmp_path):
    recorder = OCRBenchmarkRecorder(tmp_path)
    status = recorder.set_enabled(True, settings={"ocr2": "vitaocr"})
    captured = datetime(2026, 10, 28, 14, 1, tzinfo=UTC)
    assert (
        recorder.observe(
            SourceKind.TEXTHOOK,
            '日本語,"台詞"\n続き',
            captured_at=captured,
            scene="VN",
            source_instance="hook-1",
            metadata={"engine": "luna"},
        )
        is False
    )
    assert (
        recorder.observe(
            SourceKind.OCR, "日本語の台詞", captured_at=captured, scene="VN", metadata={"ocr_engine": "vitaocr"}
        )
        is True
    )
    # Flushed rows must be readable during an ongoing long session.
    rows = read_rows(recorder)
    assert [row["source"] for row in rows] == ["texthook", "ocr"]
    assert rows[0]["text"] == '日本語,"台詞"\n続き'
    assert rows[1]["engine"] == "vitaocr"
    assert rows[1]["suppressed"] == "true"
    assert rows[0]["captured_at_utc"] == captured.isoformat()
    assert status["enabled"] is True
    recorder.set_enabled(False)
    summary = json.loads((recorder.directory / "session.json").read_text(encoding="utf-8"))
    assert summary["counts"] == {"texthook": 1, "ocr": 1}
    assert summary["settings"] == {"ocr2": "vitaocr"}
    assert summary["ended_at_utc"]


def test_each_row_keeps_actual_model_when_selection_changes_mid_session(tmp_path):
    recorder = OCRBenchmarkRecorder(tmp_path)
    recorder.set_enabled(True)
    for source, tier in [(SourceKind.OCR, "normal"), (SourceKind.OVERLAY, "large")]:
        recorder.observe(
            source, "日本語", metadata={"ocr_engine": "vitaocr", "ocr_model": {"size": tier, "revision": "pinned"}}
        )
    rows = read_rows(recorder)
    assert [row["model"] for row in rows] == ["normal", "large"]
    assert [row["model_revision"] for row in rows] == ["pinned", "pinned"]
    recorder.set_enabled(False)


@pytest.mark.parametrize(
    "source",
    [SourceKind.OCR_MANUAL, SourceKind.SCREEN_CROPPER, SourceKind.SECONDARY, SourceKind.MANUAL, SourceKind.HOTKEY],
)
def test_manual_and_area_select_results_are_never_suppressed(tmp_path, source):
    recorder = OCRBenchmarkRecorder(tmp_path)
    recorder.set_enabled(True)
    assert recorder.observe(source, "手動", captured_at=datetime.now(UTC)) is False
    recorder.set_enabled(False)


def test_disabled_mode_does_not_write_and_reenable_creates_new_session(tmp_path):
    recorder = OCRBenchmarkRecorder(tmp_path)
    assert recorder.observe(SourceKind.OCR, "ignored") is False
    assert not list(tmp_path.iterdir())
    first = recorder.set_enabled(True)["csv_path"]
    assert recorder.set_enabled(True)["csv_path"] == first
    recorder.set_enabled(False)
    assert recorder.observe(SourceKind.OCR, "normal delivery resumes") is False
    assert recorder.set_enabled(True)["csv_path"] != first
    recorder.set_enabled(False)


def test_overlay_raw_scans_are_recorded_and_only_automatic_injection_is_suppressed(tmp_path):
    recorder = OCRBenchmarkRecorder(tmp_path)
    recorder.set_enabled(True)
    assert recorder.observe(SourceKind.OVERLAY, "raw OCR", metadata={"overlay_stage": "raw"}) is True
    assert recorder.observe(SourceKind.OVERLAY, "corrected OCR", metadata={"overlay_stage": "injection"}) is True
    assert recorder.observe(SourceKind.OVERLAY, "manual OCR", metadata={"overlay_manual": True}) is False
    assert (
        recorder.observe(
            SourceKind.OVERLAY, "manual injection", metadata={"overlay_stage": "injection", "overlay_manual": True}
        )
        is False
    )
    rows = read_rows(recorder)
    assert [row["text"] for row in rows] == ["raw OCR", "manual OCR"]
    assert [row["suppressed"] for row in rows] == ["true", "false"]
    recorder.set_enabled(False)


def test_csv_failure_keeps_auto_ocr_suppressed_but_allows_texthook(tmp_path, monkeypatch):
    errors = []
    recorder = OCRBenchmarkRecorder(tmp_path, on_error=errors.append)
    recorder.set_enabled(True)

    def fail(_row):
        raise OSError("disk full")

    monkeypatch.setattr(recorder, "_write_row", fail)
    assert recorder.observe(SourceKind.OCR, "automatic") is True
    assert recorder.observe(SourceKind.TEXTHOOK, "hook") is False
    assert "disk full" in recorder.status()["error"]
    assert recorder.status()["dropped_rows"] == 2
    assert len(errors) == 1
    recorder.set_enabled(False)


def test_backend_request_is_dev_only_and_requires_a_boolean(monkeypatch):
    from GameSentenceMiner.util.config import configuration

    monkeypatch.setattr(configuration, "is_dev", False)
    with pytest.raises(PermissionError):
        handle_benchmark_request({"data": {"enabled": True}})
    monkeypatch.setattr(configuration, "is_dev", True)
    with pytest.raises(TypeError, match="boolean"):
        handle_benchmark_request({"data": {"enabled": "false"}})


def test_shared_ingress_records_and_rejects_auto_before_normal_pipeline(monkeypatch, tmp_path):
    from GameSentenceMiner.ocr import benchmark

    recorder = OCRBenchmarkRecorder(tmp_path)
    recorder.set_enabled(True)
    monkeypatch.setattr(benchmark, "recorder", recorder)
    monkeypatch.setattr(gametext, "is_message_rate_limited", lambda _source: pytest.fail("Auto OCR reached intake"))
    ack = gametext.ingest_text_v2_payload(
        {"text": "台詞", "source": "ocr", "observationId": "ocr-1", "ocr_engine": "vitaocr"}
    )
    assert ack["status"] == "rejected"
    assert "benchmark" in ack["reason"]
    assert read_rows(recorder)[0]["engine"] == "vitaocr"
    recorder.set_enabled(False)


@pytest.mark.parametrize("source", ["texthook", "ocr_manual", "screen_cropper", "secondary", "hotkey", "manual"])
def test_shared_ingress_still_accepts_hook_and_manual_sources(monkeypatch, tmp_path, source):
    from GameSentenceMiner.ocr import benchmark

    recorder = OCRBenchmarkRecorder(tmp_path)
    recorder.set_enabled(True)
    monkeypatch.setattr(benchmark, "recorder", recorder)
    monkeypatch.setattr(gametext, "is_message_rate_limited", lambda _source: False)
    observed = []

    def ingest(observation):
        observed.append(observation)
        return SimpleNamespace(ack=IngressAck(IngressStatus.ACCEPTED, observation.observation_id))

    monkeypatch.setattr(gametext, "get_authoritative_text_runtime", lambda: SimpleNamespace(ingest=ingest))
    ack = gametext.ingest_text_v2_payload({"text": "台詞", "source": source})
    assert ack["status"] == "accepted"
    assert len(observed) == 1
    recorder.set_enabled(False)


def test_concurrent_streams_keep_ordered_complete_csv_rows(tmp_path):
    from concurrent.futures import ThreadPoolExecutor

    recorder = OCRBenchmarkRecorder(tmp_path)
    recorder.set_enabled(True)

    def record(index):
        return recorder.observe(SourceKind.OCR if index % 2 else SourceKind.TEXTHOOK, f"台詞{index}")

    with ThreadPoolExecutor(max_workers=4) as workers:
        results = list(workers.map(record, range(100)))
    rows = read_rows(recorder)
    assert len(rows) == 100
    assert [int(row["sequence"]) for row in rows] == list(range(1, 101))
    assert sum(results) == 50
    assert recorder.status()["counts"] == {"texthook": 50, "ocr": 50}
    recorder.set_enabled(False)
