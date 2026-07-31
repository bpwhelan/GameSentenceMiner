from types import SimpleNamespace
import wave

import numpy as np
import pytest

from GameSentenceMiner import vad
from GameSentenceMiner.util.config.configuration import FIRERED, WHISPER, VAD


def _write_pcm16_wav(path, samples, sample_rate=16000, channels=1):
    samples = np.asarray(samples, dtype=np.int16)
    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(channels)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(samples.tobytes())


def test_vad_system_uses_forced_v2_model_instead_of_legacy_selection(monkeypatch):
    vad_config = VAD(selected_vad_model=WHISPER)
    system = vad.VADSystem()
    selected_models = []

    monkeypatch.setattr(vad, "get_config", lambda: SimpleNamespace(vad=vad_config))
    monkeypatch.setattr(system, "ensure_initialized", lambda: None)
    monkeypatch.setattr(
        system,
        "_do_vad_processing",
        lambda model, *_args: selected_models.append(model) or SimpleNamespace(success=True),
    )

    system.trim_audio_with_vad("input.wav", "output.wav", None, "text")

    assert selected_models == [FIRERED]


def test_adaptive_preroll_config_defaults_off_and_round_trips():
    assert VAD().adaptive_preroll is False

    restored = VAD.from_dict(VAD(adaptive_preroll=True).to_dict())

    assert restored.adaptive_preroll is True


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


def test_select_clean_preroll_start_moves_past_leading_residue():
    sample_rate = 16000
    audio = np.full(sample_rate, 0.001, dtype=np.float32)
    residue_start = int(0.06 * sample_rate)
    residue_end = int(0.12 * sample_rate)
    residue_phase = np.linspace(0, 10 * np.pi, residue_end - residue_start, endpoint=False)
    audio[residue_start:residue_end] += 0.05 * np.sin(residue_phase)

    selected_start = vad._select_clean_preroll_start(
        audio,
        sample_rate=sample_rate,
        requested_start=0.06,
        detected_start=0.31,
    )

    assert selected_start == pytest.approx(0.12)


def test_select_clean_preroll_start_keeps_uniform_preroll():
    audio = np.full(16000, 0.005, dtype=np.float32)

    selected_start = vad._select_clean_preroll_start(
        audio,
        sample_rate=16000,
        requested_start=0.06,
        detected_start=0.31,
    )

    assert selected_start == 0.06


def test_render_decision_uses_clean_preroll_when_enabled(monkeypatch):
    processor = vad.SileroVADProcessor()
    detection = vad.DetectionResult(segments=[vad.Segment(start=0.31, end=1.0)])
    trim_calls = []

    monkeypatch.setattr(
        vad,
        "get_config",
        lambda: SimpleNamespace(
            audio=SimpleNamespace(end_offset=0.2),
            vad=SimpleNamespace(
                adaptive_preroll=True,
                beginning_offset=-0.25,
                cut_and_splice_segments=False,
                trim_beginning=True,
            ),
        ),
    )
    monkeypatch.setattr(vad, "_find_clean_preroll_start", lambda *_args: 0.22)
    monkeypatch.setattr(vad.ffmpeg, "trim_audio", lambda *args, **kwargs: trim_calls.append((args, kwargs)))

    result = processor._render_decision((0.31, 1.0), detection, "input.opus", "output.opus")

    assert trim_calls[0][0][1] == 0.22
    assert trim_calls[0][1]["fade_in_duration"] == 0.01
    assert result.start == 0.22


def test_render_decision_keeps_configured_preroll_when_experiment_is_disabled(monkeypatch):
    processor = vad.SileroVADProcessor()
    detection = vad.DetectionResult(segments=[vad.Segment(start=0.31, end=1.0)])
    trim_calls = []

    monkeypatch.setattr(
        vad,
        "get_config",
        lambda: SimpleNamespace(
            audio=SimpleNamespace(end_offset=0.2),
            vad=SimpleNamespace(
                adaptive_preroll=False,
                beginning_offset=-0.25,
                cut_and_splice_segments=False,
                trim_beginning=True,
            ),
        ),
    )
    monkeypatch.setattr(
        vad,
        "_find_clean_preroll_start",
        lambda *_args: pytest.fail("clean pre-roll analysis should remain disabled"),
    )
    monkeypatch.setattr(vad.ffmpeg, "trim_audio", lambda *args, **kwargs: trim_calls.append((args, kwargs)))

    result = processor._render_decision((0.31, 1.0), detection, "input.opus", "output.opus")

    assert trim_calls[0][0][1] == pytest.approx(0.06)
    assert trim_calls[0][1]["fade_in_duration"] == 0.05
    assert result.start == pytest.approx(0.06)


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


def test_firered_vad_always_loads_with_cpu_provider(monkeypatch):
    import onnxruntime as ort

    requested_providers = []

    class FakeModel:
        def __init__(self, _model_path, providers):
            requested_providers.append(providers)

        def get_providers(self):
            return requested_providers[-1]

    monkeypatch.setattr(
        ort,
        "get_available_providers",
        lambda: pytest.fail("FireRedVAD should not probe GPU providers"),
    )
    monkeypatch.setattr(ort, "InferenceSession", FakeModel)
    monkeypatch.setattr(vad, "FireRedFeatureExtractor", lambda _cmvn_path: object())
    monkeypatch.setattr(
        vad,
        "get_config",
        lambda: SimpleNamespace(vad=SimpleNamespace(use_cpu_for_inference_v2=False)),
    )

    processor = vad.FireRedVADProcessor()
    processor._ensure_model()

    assert requested_providers == [["CPUExecutionProvider"]]


def test_firered_vad_converts_onnx_probabilities_to_segments(monkeypatch):
    class FakeTempWav:
        def __init__(self, input_audio):
            self.input_audio = input_audio

        def __enter__(self):
            return "temp.wav"

        def __exit__(self, exc_type, exc, tb):
            return False

    class FakeModel:
        def run(self, _output_names, feeds):
            assert feeds["feat"].shape == (1, 5, 80)
            return [np.array([[[0.1], [0.8], [0.9], [0.1], [0.1]]], dtype=np.float32)]

    class FakeFeatureExtractor:
        def extract(self, path):
            assert path == "temp.wav"
            return np.zeros((5, 80), dtype=np.float32), 0.05

    processor = vad.FireRedVADProcessor()
    processor.vad_model = FakeModel()
    processor._feature_extractor = FakeFeatureExtractor()
    processor._postprocessor = vad.FireRedVADPostprocessor(
        smooth_window_size=1,
        speech_threshold=0.5,
        min_speech_frame=1,
        max_speech_frame=2000,
        min_silence_frame=1,
        merge_silence_frame=0,
        extend_speech_frame=0,
    )

    monkeypatch.setattr(vad, "TempWav", FakeTempWav)

    result = processor._detect_voice_activity("input.mp3", "")

    assert len(result.segments) == 1
    assert result.segments[0].start == pytest.approx(0.0)
    assert result.segments[0].end == pytest.approx(0.03)


def test_firered_vad_removes_confirmed_trailing_silence_from_segment():
    postprocessor = vad.FireRedVADPostprocessor(
        smooth_window_size=1,
        speech_threshold=0.5,
        min_speech_frame=1,
        max_speech_frame=2000,
        min_silence_frame=3,
        merge_silence_frame=0,
        extend_speech_frame=0,
    )

    decisions = postprocessor.process([0.9, 0.9, 0.1, 0.1, 0.1, 0.1])

    # The three-frame silence window confirms speech ended at frame two; it is
    # not part of the extracted speech segment.
    assert decisions == [1, 1, 0, 0, 0, 0]


def test_firered_vad_corroborates_suspicious_clip_boundary_with_silero(monkeypatch):
    processor = vad.FireRedVADProcessor()
    processor._postprocessor = vad.FireRedVADPostprocessor(
        smooth_window_size=1,
        speech_threshold=0.4,
        min_speech_frame=20,
        max_speech_frame=2000,
        min_silence_frame=20,
        merge_silence_frame=0,
        extend_speech_frame=0,
    )
    firered_segments = [
        vad.Segment(start=0.2, end=2.0),
        vad.Segment(start=3.1, end=4.1),
        vad.Segment(start=4.36, end=7.4),
    ]
    probabilities = np.full(740, 0.6, dtype=np.float32)
    probabilities[20:200] = 0.99
    probabilities[310:410] = 0.99
    probabilities[436:495] = 0.99
    decoded_audio = np.zeros(740 * 160, dtype=np.float32)

    monkeypatch.setattr(
        vad,
        "_detect_silero_segments_from_audio",
        lambda audio: [
            vad.Segment(start=0.2, end=2.0),
            vad.Segment(start=3.1, end=4.1),
            vad.Segment(start=4.4, end=5.0),
        ],
    )

    segments = processor._corroborate_trailing_boundary(
        firered_segments,
        probabilities,
        wav_duration=7.4,
        decoded_audio=decoded_audio,
    )

    assert segments == [
        vad.Segment(start=0.2, end=2.0),
        vad.Segment(start=3.1, end=4.1),
        vad.Segment(start=4.36, end=5.0),
    ]


def test_firered_vad_keeps_boundary_when_it_has_later_high_confidence_speech(monkeypatch):
    processor = vad.FireRedVADProcessor()
    processor._postprocessor = vad.FireRedVADPostprocessor(
        smooth_window_size=1,
        speech_threshold=0.4,
        min_speech_frame=20,
        max_speech_frame=2000,
        min_silence_frame=20,
        merge_silence_frame=0,
        extend_speech_frame=0,
    )
    firered_segments = [vad.Segment(start=0.2, end=2.0), vad.Segment(start=4.0, end=7.4)]
    probabilities = np.full(740, 0.6, dtype=np.float32)
    probabilities[600:625] = 0.99

    monkeypatch.setattr(
        vad,
        "_detect_silero_segments_from_audio",
        lambda audio: [vad.Segment(start=0.2, end=2.0), vad.Segment(start=4.0, end=5.0)],
    )

    segments = processor._corroborate_trailing_boundary(
        firered_segments,
        probabilities,
        wav_duration=7.4,
        decoded_audio=np.zeros(740 * 160, dtype=np.float32),
    )

    assert segments == firered_segments


def test_firered_cmvn_parser_reads_bundled_stats():
    means, inverse_std_variances = vad._load_firered_cmvn(vad._get_firered_asset_path("cmvn.ark"))

    assert means.shape == (80,)
    assert inverse_std_variances.shape == (80,)
    assert means.dtype == np.float32
    assert inverse_std_variances.dtype == np.float32
