from types import SimpleNamespace
import wave

import numpy as np
import pytest

from GameSentenceMiner import vad


def _write_pcm16_wav(path, samples, sample_rate=16000, channels=1):
    samples = np.asarray(samples, dtype=np.int16)
    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(channels)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(samples.tobytes())


def test_load_whisper_audio_from_wav_returns_normalized_float32(tmp_path):
    samples = np.array([-32768, -16384, 0, 16384, 32767], dtype=np.int16)
    wav_path = tmp_path / "speech.wav"
    _write_pcm16_wav(wav_path, samples)

    audio = vad._load_whisper_audio_from_wav(str(wav_path))

    assert audio.dtype == np.float32
    np.testing.assert_allclose(audio, samples.astype(np.float32) / 32768.0)


def test_load_whisper_audio_from_wav_rejects_wrong_sample_rate(tmp_path):
    wav_path = tmp_path / "speech.wav"
    _write_pcm16_wav(wav_path, [0, 1, 2], sample_rate=8000)

    with pytest.raises(RuntimeError, match="16 kHz"):
        vad._load_whisper_audio_from_wav(str(wav_path))


def test_whisper_vad_transcribes_decoded_audio_array(monkeypatch):
    decoded_audio = np.array([0.0, 0.5, -0.5], dtype=np.float32)

    class FakeTempWav:
        def __init__(self, input_audio):
            self.input_audio = input_audio

        def __enter__(self):
            return "temp.wav"

        def __exit__(self, exc_type, exc, tb):
            return False

    class FakeModel:
        def __init__(self):
            self.received_audio = None
            self.received_kwargs = None

        def transcribe(self, audio, **kwargs):
            self.received_audio = audio
            self.received_kwargs = kwargs
            # faster-whisper returns (segments_iterable, info)
            return iter([]), SimpleNamespace(language="ja")

    fake_model = FakeModel()
    processor = vad.WhisperVADProcessor()
    processor.vad_model = fake_model

    monkeypatch.setattr(vad, "TempWav", FakeTempWav)
    monkeypatch.setattr(vad, "_load_whisper_audio_from_wav", lambda path: decoded_audio)
    monkeypatch.setattr(
        vad,
        "get_config",
        lambda: SimpleNamespace(
            general=SimpleNamespace(target_language="ja"),
            vad=SimpleNamespace(use_vad_filter_for_whisper=True),
        ),
    )

    result = processor._detect_voice_activity("input.mp3", "")

    assert result.segments == []
    assert fake_model.received_audio is decoded_audio
    assert fake_model.received_kwargs["language"] == "ja"
    assert fake_model.received_kwargs["vad_filter"] is True
    assert fake_model.received_kwargs["word_timestamps"] is True


def test_silero_vad_converts_sample_indices_to_seconds(monkeypatch):
    class FakeTempWav:
        def __init__(self, input_audio):
            pass

        def __enter__(self):
            return "temp.wav"

        def __exit__(self, exc_type, exc, tb):
            return False

    monkeypatch.setattr(vad, "TempWav", FakeTempWav)
    monkeypatch.setattr(vad, "_load_whisper_audio_from_wav", lambda path: np.zeros(16000, dtype=np.float32))

    import faster_whisper.vad as fw_vad

    # faster-whisper returns speech chunks as sample indices; the processor divides by 16 kHz.
    monkeypatch.setattr(
        fw_vad,
        "get_speech_timestamps",
        lambda audio, vad_options=None, sampling_rate=16000: [{"start": 8000, "end": 24000}],
    )

    processor = vad.SileroVADProcessor()
    processor.vad_model = object()  # skip the real ONNX model load in _ensure_model

    result = processor._detect_voice_activity("input.mp3", "")

    assert len(result.segments) == 1
    assert result.segments[0].start == 0.5
    assert result.segments[0].end == 1.5
