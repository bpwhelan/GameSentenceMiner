import json
import shutil
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from GameSentenceMiner import vad
from GameSentenceMiner.util.config.configuration import FIRERED, VAD

ASSETS = Path(__file__).parent / "assets" / "firered"
CASES = json.loads((ASSETS / "cases.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["file"])
def test_firered_ignores_long_background_after_dialogue(case, tmp_path, monkeypatch):
    executable = shutil.which("ffmpeg")
    if not executable:
        pytest.skip("FFmpeg is required for the real-audio FireRed regression")
    config = SimpleNamespace(vad=VAD(selected_vad_model_v2=FIRERED))
    monkeypatch.setattr(vad, "get_config", lambda: config)
    monkeypatch.setattr(vad, "get_temporary_directory", lambda: str(tmp_path))
    monkeypatch.setattr(vad, "gpu_enabled", lambda _engine: False)
    monkeypatch.setattr(
        vad,
        "create_onnx_session",
        lambda path, _engine, *, ort_module: ort_module.InferenceSession(path, providers=["CPUExecutionProvider"]),
    )
    monkeypatch.setattr(vad.ffmpeg, "ffmpeg_base_command_list", [executable, *vad.ffmpeg.ffmpeg_base_command_list[1:]])

    detection = vad.FireRedVADProcessor()._detect_voice_activity(str(ASSETS / case["file"]), "")

    assert detection.segments
    assert detection.segments[-1].end == pytest.approx(case["expected_unfiltered_end_seconds"], abs=0.1)
    assert all(segment.end < 5 for segment in detection.segments)


@pytest.mark.parametrize("use_filters", [False, True])
def test_temp_wav_forwards_filter_choice_and_cleans_up(use_filters, tmp_path, monkeypatch):
    import wave

    source = tmp_path / "input.wav"
    source.write_bytes(b"source audio")
    calls = []

    def convert(_input, output, *, use_filters):
        calls.append(use_filters)
        with wave.open(output, "wb") as stream:
            stream.setnchannels(1)
            stream.setsampwidth(2)
            stream.setframerate(16000)
            stream.writeframes(np.zeros(160, dtype=np.int16).tobytes())
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(vad, "get_temporary_directory", lambda: str(tmp_path))
    monkeypatch.setattr(vad.ffmpeg, "convert_audio_to_wav", convert)

    with vad.TempWav(str(source), use_filters=use_filters) as wav_path:
        assert Path(wav_path).is_file()

    assert calls == [use_filters]
    assert not Path(wav_path).exists()
