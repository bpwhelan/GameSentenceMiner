import os
import shutil
import subprocess
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PyQt6.QtWidgets import QApplication

from GameSentenceMiner import replay_handler
from GameSentenceMiner.ui import anki_confirmation_qt
from GameSentenceMiner.ui.audio_waveform_widget import AudioWaveformWidget
from GameSentenceMiner.util.media import ffmpeg
from GameSentenceMiner.util.media.pause_gaps import AudioTimeline


@pytest.mark.skipif(not (shutil.which("ffmpeg") and shutil.which("ffprobe")), reason="ffmpeg/ffprobe unavailable")
def test_overlay_empty_guess_recovers_decodable_nearby_audio_for_manual_trimming(monkeypatch, tmp_path):
    config = SimpleNamespace(
        audio=SimpleNamespace(extension="opus", beginning_offset=0.0, pre_vad_end_offset=0.0),
        vad=SimpleNamespace(do_vad_postprocessing=True, trim_beginning=True),
        anki=SimpleNamespace(show_update_confirmation_dialog_v2=False, skip_confirmation_for_unvoiced=True),
    )
    monkeypatch.setattr(ffmpeg, "get_config", lambda: config)
    monkeypatch.setattr(replay_handler, "get_config", lambda: config)
    monkeypatch.setattr(ffmpeg.configuration, "get_temporary_directory", lambda: str(tmp_path))
    monkeypatch.setattr(replay_handler, "get_temporary_directory", lambda: str(tmp_path))
    monkeypatch.setattr(anki_confirmation_qt, "get_temporary_directory", lambda: str(tmp_path))
    monkeypatch.setattr(anki_confirmation_qt.gsm_state, "current_game", "game")
    monkeypatch.setattr(ffmpeg, "extract_audio_without_pauses", lambda *args: None)
    monkeypatch.setattr(ffmpeg, "ffmpeg_base_command_list", [shutil.which("ffmpeg"), "-v", "error", "-nostdin"])
    monkeypatch.setattr(ffmpeg, "get_ffprobe_path", lambda: shutil.which("ffprobe"))
    monkeypatch.setattr(replay_handler.obs, "get_current_game", lambda **kwargs: "game")
    monkeypatch.setattr(replay_handler.vad_processor, "initialized", True)
    monkeypatch.setattr(
        replay_handler.vad_processor,
        "trim_audio_with_vad",
        lambda *args: pytest.fail("fallback audio must remain untrimmed for the user to review"),
    )
    replay = tmp_path / "replay.mp4"
    subprocess.run(
        [
            shutil.which("ffmpeg"),
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=size=32x32:rate=1:duration=12",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=4",
            "-c:v",
            "libx264",
            "-c:a",
            "aac",
            str(replay),
        ],
        check=True,
    )
    captured_at = datetime(2026, 10, 27, 12)  # noqa: DTZ001 - GSM line times are local and naive.
    line = SimpleNamespace(time=captured_at - timedelta(seconds=1), text="line", source="overlay", source_padding=3)

    result = replay_handler.ReplayAudioExtractor.get_audio(line, None, str(replay), captured_at)

    app = QApplication.instance() or QApplication([])
    waveform = AudioWaveformWidget()
    assert waveform.load_audio(result.final_audio_output)
    assert waveform.duration == pytest.approx(4.0, abs=0.1)
    waveform.start_time = 0.5
    waveform.end_time = 2.5
    dialog = SimpleNamespace(
        audio_path=result.final_audio_output,
        waveform_widget=waveform,
        _sync_audio_edit_selection_to_current_clip=lambda start, end: None,
    )
    saved = anki_confirmation_qt.AnkiConfirmationDialog._save_trimmed_audio(dialog)
    assert saved != result.final_audio_output
    assert ffmpeg.get_audio_length(saved) == pytest.approx(2.0, abs=0.1)
    waveform.deleteLater()
    app.processEvents()
    assert result.audio_edit_context.timing_fallback is True
    assert result.audio_edit_context.range_start == pytest.approx(0.0, abs=0.1)
    assert result.audio_edit_context.range_end == pytest.approx(4.0, abs=0.1)


def test_recovered_audio_preserves_the_pause_cleaned_source_timeline(monkeypatch, tmp_path):
    source = tmp_path / "source.opus"
    source.write_bytes(b"source")
    monkeypatch.setattr(replay_handler, "get_audio_length", lambda path: 8.0)
    monkeypatch.setattr(replay_handler, "get_temporary_directory", lambda: str(tmp_path))
    monkeypatch.setattr(replay_handler, "get_config", lambda: SimpleNamespace(audio=SimpleNamespace(extension="opus")))
    commands = []

    def trim_audio(**kwargs):
        commands.append(kwargs)
        with open(kwargs["output_audio"], "wb") as output:
            output.write(b"audio")

    monkeypatch.setattr(replay_handler.ffmpeg, "trim_audio", trim_audio)

    recovered, video_start, video_end = replay_handler.ReplayAudioExtractor._recover_overlay_audio(
        str(source), 15.0, 0.0, AudioTimeline(((2.0, 5.0),))
    )

    assert commands[0]["start_time"] == 0.0
    assert commands[0]["end_time"] == 8.0
    assert (video_start, video_end) == (0.0, 11.0)
    assert os.path.isfile(recovered)
