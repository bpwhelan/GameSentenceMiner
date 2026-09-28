from types import SimpleNamespace

from GameSentenceMiner import replay_handler
from GameSentenceMiner.util.media.pause_gaps import AudioTimeline
from GameSentenceMiner.util.models.model import VADResult

Extractor = replay_handler.ReplayAudioExtractor
# 10s of pause silence cut at 2.0s of the video: 1.0-14.0s of the video is 1.0-4.0s of the cleaned audio.
TIMELINE = AudioTimeline(((2.0, 12.0),))


def test_vad_offsets_move_onto_the_video():
    vad = VADResult(True, 0.5, 2.0, "Silero")

    Extractor._rebase_vad_on_video(TIMELINE, 1.0, vad)

    assert (vad.start, vad.end) == (0.5, 12.0)


def test_failed_vad_offsets_are_left_alone():
    vad = VADResult(False, 0.0, 0.0, "Silero")

    Extractor._rebase_vad_on_video(TIMELINE, 3.0, vad)  # a start inside the cut would otherwise invert the window

    assert (vad.start, vad.end) == (0.0, 0.0)


def test_audio_edit_range_is_placed_in_the_cleaned_audio(monkeypatch):
    config = SimpleNamespace(vad=SimpleNamespace(trim_beginning=True, cut_and_splice_segments=False))
    monkeypatch.setattr(replay_handler, "get_config", lambda: config)
    monkeypatch.setattr(replay_handler, "get_audio_length", lambda _path: 30.0)
    vad = VADResult(True, 0.5, 12.0, "Silero")  # already on the video

    context = Extractor._build_audio_edit_context("source.opus", 1.0, 14.0, vad, TIMELINE)

    assert (context.range_start, context.range_end, context.timeline) == (1.5, 3.0, TIMELINE)
