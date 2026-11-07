import json
import wave
from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
from types import SimpleNamespace

import numpy as np
import pytest

from GameSentenceMiner import vad
from GameSentenceMiner.util import vad_debug
from GameSentenceMiner.util.config.configuration import FIRERED, SILERO, ProfileConfig


@pytest.fixture
def capture_setup(tmp_path, monkeypatch):
    recorder = vad_debug.VADDebugRecorder(tmp_path / "library")
    monkeypatch.setattr(vad_debug, "recorder", recorder)
    config = ProfileConfig()
    config.vad.selected_vad_model_v2 = FIRERED
    config.vad.trim_beginning = True
    config.vad.beginning_offset = -0.1
    config.audio.end_offset = 0.2
    monkeypatch.setattr(vad, "get_config", lambda: config)
    source = tmp_path / "source.wav"
    with wave.open(str(source), "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(16000)
        stream.writeframes(np.zeros(32000, dtype=np.int16).tobytes())
    monkeypatch.setattr(vad, "TempWav", lambda _path, **_kwargs: nullcontext(str(source)))
    probabilities = np.full(198, 0.6, dtype=np.float32)
    processor = vad.FireRedVADProcessor()
    processor.vad_model = SimpleNamespace(
        run=lambda *_args: [probabilities], get_providers=lambda: ["CPUExecutionProvider"]
    )
    processor._feature_extractor = SimpleNamespace(extract=lambda _path: (np.zeros((198, 80), dtype=np.float32), 2.0))
    processor._postprocessor = vad.FireRedVADPostprocessor(5, 0.4, 20, 2000, 20, 0, 0)
    monkeypatch.setattr(processor, "_ensure_model", lambda: None)
    system = vad.VADSystem()
    system.firered = processor
    monkeypatch.setattr(system, "ensure_initialized", lambda: None)
    output = tmp_path / "output.wav"

    def trim(_source, _start, _end, destination, **_kwargs):
        destination = type(source)(destination)
        destination.write_bytes(source.read_bytes())

    monkeypatch.setattr(vad.ffmpeg, "trim_audio", trim)
    return recorder, config, system, source, output


def test_disabled_debug_does_not_write_files_or_run_firered(capture_setup, monkeypatch):
    recorder, config, system, source, output = capture_setup
    config.vad.selected_vad_model_v2 = SILERO
    expected = vad.VADResult(True, 0.2, 1.0, SILERO)
    monkeypatch.setattr(system, "_do_vad_processing", lambda *_args: expected)
    monkeypatch.setattr(system, "_get_processor", lambda *_args: pytest.fail("unexpected diagnostic inference"))

    assert system.trim_audio_with_vad(str(source), str(output), None, "line") is expected
    assert not recorder.root.exists()


def test_firered_capture_preserves_audio_scores_offsets_and_review_fields(capture_setup):
    recorder, _config, system, source, output = capture_setup
    recorder.set_enabled(True)

    result = system.trim_audio_with_vad(str(source), str(output), None, "test dialogue")

    directory = next(recorder.root.iterdir())
    report = json.loads((directory / "result.json").read_text(encoding="utf-8"))
    assert report["schema"] == "gsm_vad_debug_v1"
    assert (directory / report["audio"]["pre_vad"]["file"]).read_bytes() == source.read_bytes()
    assert (directory / report["audio"]["post_vad"]["file"]).read_bytes() == output.read_bytes()
    assert (directory / "firered_input.wav").read_bytes() == source.read_bytes()
    assert report["context"]["text"] == "test dialogue"
    assert report["firered"]["raw_probabilities"] == pytest.approx([0.6] * 198)
    assert len(report["firered"]["smoothed_probabilities"]) == 198
    assert report["firered"]["decisions"] == [1] * 198
    assert report["firered"]["reaches_clip_end"] is True
    assert report["firered"]["frame_shift_seconds"] == 0.01
    assert report["firered"]["preprocessing"]["filters"] == []
    assert report["firered"]["postprocessor"]["speech_threshold"] == 0.4
    assert report["firered"]["providers"] == ["CPUExecutionProvider"]
    assert len(report["firered"]["model_sha256"]) == 64
    assert report["attempts"][0]["model"] == FIRERED
    assert report["attempts"][0]["decision"] == [0.0, 2.0]
    assert report["result"]["end"] == result.end == 2.2
    assert report["settings"]["audio"]["end_offset"] == 0.2
    assert report["review"]["expected_speech_end_seconds"] is None
    assert vad_debug.current_capture() is None


def test_silero_output_is_preserved_with_separate_firered_analysis(capture_setup, monkeypatch):
    recorder, config, system, source, output = capture_setup
    config.vad.selected_vad_model_v2 = SILERO
    system.silero = vad.SileroVADProcessor()
    monkeypatch.setattr(
        system.silero, "_detect_voice_activity", lambda *_args: vad.DetectionResult([vad.Segment(0.3, 1.0)])
    )
    recorder.set_enabled(True)

    result = system.trim_audio_with_vad(str(source), str(output), None, "line")

    report = json.loads(next(recorder.root.glob("*/result.json")).read_text(encoding="utf-8"))
    assert result.model == SILERO
    assert result.end == 1.2
    assert report["result"]["model"] == SILERO
    assert [attempt["model"] for attempt in report["attempts"]] == [SILERO]
    assert report["firered"]["analysis_only"] is True
    assert report["firered"]["segments"][-1]["end"] == 2.0


def test_rejected_audio_is_retained_without_claiming_a_post_vad_file(capture_setup, monkeypatch):
    recorder, _config, system, source, output = capture_setup
    monkeypatch.setattr(system.firered, "_detect_voice_activity", lambda *_args: vad.DetectionResult([]))
    recorder.set_enabled(True)
    # A stale destination must never be copied for a rejected result.
    output.write_bytes(b"old output")

    result = system.trim_audio_with_vad(str(source), str(output), None, "line")

    report = json.loads(next(recorder.root.glob("*/result.json")).read_text(encoding="utf-8"))
    assert result.success is False
    assert report["audio"]["post_vad"] is None
    assert report["attempts"][0]["decision"] == "reject"


def test_debug_write_failure_does_not_break_mining(capture_setup, monkeypatch):
    recorder, _config, system, source, output = capture_setup
    recorder.set_enabled(True)
    errors = []
    monkeypatch.setattr(vad_debug, "notify_error", errors.append)
    monkeypatch.setattr(vad_debug.shutil, "copyfile", lambda *_args: (_ for _ in ()).throw(OSError("disk full")))

    assert system.trim_audio_with_vad(str(source), str(output), None, "line").success is True
    assert recorder.status()["enabled"] is False
    assert "disk full" in recorder.status()["error"]
    assert len(errors) == 1
    assert vad_debug.current_capture() is None


def test_capture_directories_are_unique_and_switch_is_session_only(capture_setup):
    recorder, _config, system, source, output = capture_setup
    recorder.set_enabled(True)
    for _ in range(2):
        system.trim_audio_with_vad(str(source), str(output), None, "same line")
    recorder.set_enabled(False)
    system.trim_audio_with_vad(str(source), str(output), None, "not recorded")

    assert len(list(recorder.root.glob("*/result.json"))) == 2
    assert vad_debug.VADDebugRecorder(recorder.root).enabled is False


def test_primary_error_and_successful_backup_are_both_recorded(capture_setup, monkeypatch):
    recorder, config, system, source, output = capture_setup
    config.vad.backup_vad_model = SILERO
    system.silero = vad.SileroVADProcessor()

    def fail(*_args):
        raise RuntimeError("inference failed")

    monkeypatch.setattr(system.firered, "_detect_voice_activity", fail)
    monkeypatch.setattr(
        system.silero, "_detect_voice_activity", lambda *_args: vad.DetectionResult([vad.Segment(0.1, 1.0)])
    )
    recorder.set_enabled(True)

    result = system.trim_audio_with_vad(str(source), str(output), None, "line")

    report = json.loads(next(recorder.root.glob("*/result.json")).read_text(encoding="utf-8"))
    assert result.model == SILERO
    assert [a["model"] for a in report["attempts"]] == [FIRERED, SILERO]
    assert report["attempts"][0]["error"] == "inference failed"
    assert report["firered"]["error"] == "inference failed"
    assert report["audio"]["post_vad"] is not None


def test_reference_firered_failure_keeps_selected_audio(capture_setup, monkeypatch):
    recorder, config, system, source, output = capture_setup
    config.vad.selected_vad_model_v2 = SILERO
    system.silero = vad.SileroVADProcessor()
    monkeypatch.setattr(
        system.silero, "_detect_voice_activity", lambda *_args: vad.DetectionResult([vad.Segment(0.1, 1.0)])
    )

    def fail(*_args):
        raise RuntimeError("FireRed unavailable")

    monkeypatch.setattr(system.firered, "_detect_voice_activity", fail)
    recorder.set_enabled(True)

    result = system.trim_audio_with_vad(str(source), str(output), None, "line")

    report = json.loads(next(recorder.root.glob("*/result.json")).read_text(encoding="utf-8"))
    assert result.success is True
    assert result.model == SILERO
    assert report["firered"]["error"] == "FireRed unavailable"


def test_concurrent_captures_keep_their_own_audio_and_metadata(capture_setup):
    recorder, _config, system, source, output = capture_setup
    recorder.set_enabled(True)

    def run(index):
        assert system.trim_audio_with_vad(
            str(source), str(output.with_stem(f"output_{index}")), None, f"line {index}"
        ).success

    with ThreadPoolExecutor(max_workers=3) as pool:
        list(pool.map(run, range(6)))
    reports = [json.loads(path.read_text(encoding="utf-8")) for path in recorder.root.glob("*/result.json")]
    assert {r["context"]["text"] for r in reports} == {f"line {i}" for i in range(6)}
    assert all(len(r["attempts"]) == 1 and r["audio"]["post_vad"] is not None for r in reports)
    assert vad_debug.current_capture() is None


def test_disable_finishes_an_inflight_capture(capture_setup):
    recorder, config, _system, source, _output = capture_setup
    recorder.set_enabled(True)
    with recorder.capture(str(source), config, None, "line"):
        assert vad_debug.current_capture() is not None
        recorder.set_enabled(False)
    assert len(list(recorder.root.glob("*/result.json"))) == 1
    assert vad_debug.current_capture() is None


def test_empty_firered_features_are_recorded_as_no_speech(capture_setup, monkeypatch):
    recorder, _config, system, source, output = capture_setup
    monkeypatch.setattr(system.firered._feature_extractor, "extract", lambda _path: (np.zeros((0, 80)), 0.01))
    recorder.set_enabled(True)

    assert system.trim_audio_with_vad(str(source), str(output), None, "line").success is False

    report = json.loads(next(recorder.root.glob("*/result.json")).read_text(encoding="utf-8"))
    assert report["firered"]["frame_count"] == 0
    assert report["firered"]["segments"] == []
    assert recorder.enabled is True
