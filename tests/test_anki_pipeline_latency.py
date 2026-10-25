from concurrent.futures import Future
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from GameSentenceMiner import replay_handler


@pytest.mark.parametrize("translate", [False, True])
def test_replay_starts_audio_before_screenshot_probe_and_does_not_join_translation(monkeypatch, tmp_path, translate):
    events = []
    pending_translation = Future()
    config = SimpleNamespace(
        anki=SimpleNamespace(
            enabled=True, sentence_audio_field="Audio", word_field="Word", show_update_confirmation_dialog_v2=True
        ),
        audio=SimpleNamespace(enabled=True),
        ai=SimpleNamespace(add_to_anki=translate),
        paths=SimpleNamespace(remove_video=False),
    )
    monkeypatch.setattr(replay_handler, "get_config", lambda: config)
    monkeypatch.setattr(replay_handler, "_notify_anki_enhancement_failure", lambda *args: None)
    monkeypatch.setattr(
        replay_handler.anki, "get_initial_card_info", lambda card, *args, **kwargs: ({"fields": {}}, card)
    )
    monkeypatch.setattr(
        replay_handler.ReplayAudioExtractor, "_resolve_sentence_for_translation", staticmethod(lambda *args: "sentence")
    )
    monkeypatch.setattr(
        replay_handler.anki, "prefetch_animated_screenshot_for_confirmation", lambda *args, **kwargs: None
    )
    monkeypatch.setattr(
        replay_handler.anki, "prefetch_media_assets_for_card", lambda **kwargs: events.append("media") or object()
    )
    monkeypatch.setattr(
        replay_handler.anki, "prefetch_ai_translation", lambda *args: pytest.fail("translation joined card prep")
    )
    monkeypatch.setattr(
        replay_handler.anki, "translation_prefetch_executor", SimpleNamespace(submit=lambda *args: pending_translation)
    )
    audio = replay_handler.ReplayAudioResult("", None, "", 0, 0)
    monkeypatch.setattr(
        replay_handler.ReplayAudioExtractor,
        "get_audio",
        staticmethod(lambda *args, **kwargs: events.append("audio") or audio),
    )

    def screenshot_time(*args, **kwargs):
        assert "audio" in events, "audio must start before probing the screenshot timestamp"
        events.append("screenshot_time")
        return 1

    monkeypatch.setattr(replay_handler.ffmpeg, "get_screenshot_time", screenshot_time)

    class CardPrepExecutor:
        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def submit(self, fn, *args, **kwargs):
            result = Future()
            result.set_result(fn(*args, **kwargs))
            return result

    monkeypatch.setattr(replay_handler, "ThreadPoolExecutor", CardPrepExecutor)
    updates = []
    monkeypatch.setattr(replay_handler.anki, "update_anki_card", lambda *args, **kwargs: updates.append(kwargs) or True)
    line = SimpleNamespace(id="line", text="sentence", next_line=lambda: None)
    card = SimpleNamespace(noteId=42, get_field=lambda field: "word", pretty_print=lambda: "card")

    replay_handler.ReplayAudioExtractor().process_replay(
        str(tmp_path / "Replay.mkv"), queued_job=(card, datetime.now(timezone.utc), [], line)
    )

    assert events == ["audio", "screenshot_time", "media"]
    assert len(updates) == 1
    assert updates[0]["ss_time"] == 1
    assert updates[0]["translation_future"] is (pending_translation if translate else None)
