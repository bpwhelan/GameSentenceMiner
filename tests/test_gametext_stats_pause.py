import asyncio
import sys
from dataclasses import replace
from datetime import datetime, timedelta
from types import ModuleType, SimpleNamespace

import pytest

from GameSentenceMiner import gametext
from GameSentenceMiner.text_pipeline.models import TextDomainEvent, TextEventKind, TextRecordState
from GameSentenceMiner.util import text_log


@pytest.fixture
def text_pipeline(monkeypatch):
    config = SimpleNamespace(
        general=SimpleNamespace(
            merge_matching_sequential_text=False,
            remove_matching_prefix_on_subsequent_lines=False,
        ),
        text_processing=SimpleNamespace(),
        hotkeys=SimpleNamespace(relay_outputs_when_text_intake_paused=True),
        advanced=SimpleNamespace(dont_collect_stats=False),
        anki=SimpleNamespace(sentence_field="Sentence"),
    )
    state = SimpleNamespace(text_input_paused=False, current_game="Paused Game", replay_buffer_length=300)
    history = text_log.GameText()
    outputs = SimpleNamespace(events=[], overlay=[], stats=[], discord=[], database=[], subtitles=[])
    text_feed = ModuleType("GameSentenceMiner.web.texthooking_page")
    text_feed.project_text_domain_event = lambda event, line: outputs.events.append(event)
    monkeypatch.setitem(sys.modules, text_feed.__name__, text_feed)
    for module in (gametext, text_log):
        monkeypatch.setattr(module, "get_config", lambda: config)
        monkeypatch.setattr(module, "gsm_state", state)
        monkeypatch.setattr(module, "game_log", history)
    monkeypatch.setattr(gametext, "gsm_status", SimpleNamespace(last_line_received=""))
    monkeypatch.setattr(gametext, "current_line", "")
    monkeypatch.setattr(gametext, "current_line_time", datetime.now().astimezone().replace(tzinfo=None))
    monkeypatch.setattr(gametext, "is_message_rate_limited", lambda _source: False)
    monkeypatch.setattr(gametext, "apply_text_processing", lambda text, _config: text)
    monkeypatch.setattr(gametext, "_send_text_received_preview_event", lambda *_args: None)
    monkeypatch.setattr(gametext, "_expire_live_stats_session", lambda: None)
    monkeypatch.setattr(gametext, "_get_overlay_dispatcher", lambda: SimpleNamespace(submit=outputs.overlay.append))
    monkeypatch.setattr(
        gametext,
        "live_stats_tracker",
        SimpleNamespace(add_line=lambda text, *_args, **_kwargs: outputs.stats.append(text)),
    )
    monkeypatch.setattr(gametext, "_notify_discord_activity", outputs.discord.append)
    monkeypatch.setattr(gametext, "_persist_game_line_async", outputs.database.append)
    monkeypatch.setattr(gametext.obs, "add_longplay_srt_line", lambda _time, line: outputs.subtitles.append(line))
    yield SimpleNamespace(state=state, history=history, outputs=outputs)
    assert gametext.stop_authoritative_text_runtime()


@pytest.mark.parametrize("ingress", ["async", "v2"])
def test_paused_text_is_available_for_card_matching_and_media_timing(text_pipeline, ingress):
    text_pipeline.state.text_input_paused = True
    captured_at = datetime.now().astimezone().replace(tzinfo=None) - timedelta(seconds=3)
    sentence = "それすらも夢だったのかもしれない。"

    def ingest(text, timestamp):
        if ingress == "async":
            asyncio.run(gametext.handle_new_text_event(text, line_time=timestamp, source="texthook"))
        else:
            result = gametext.ingest_text_v2_payload(
                {"text": text, "captured_at": timestamp.isoformat(), "source": "texthook"}
            )
            assert result["status"] == "accepted"
            assert gametext.get_authoritative_text_runtime().wait_projected()

    ingest(sentence, captured_at)
    ingest("え？", captured_at + timedelta(seconds=2))
    note = SimpleNamespace(get_field=lambda _field: sentence)
    mined_line = text_log.get_mined_line(note, search_saved_clips=False)

    assert mined_line is text_pipeline.history[0]
    assert mined_line.text == sentence
    assert mined_line.time == captured_at
    assert mined_line.excluded_from_stats is True
    assert mined_line.state == "frozen"
    assert mined_line.next is text_pipeline.history[1]
    assert mined_line.next.prev is mined_line
    mined_line.mined_time = datetime.now().astimezone().replace(tzinfo=None)
    assert mined_line.get_next_time() == captured_at + timedelta(seconds=2)

    # Expiry must remove paused lines from the same history and detach their links.
    snapshot = gametext.get_text_stream_snapshot()
    record = next(record for record in snapshot.records if record.line_id == mined_line.id)
    gametext._project_text_domain_event(
        TextDomainEvent(TextEventKind.EXPIRED, replace(record, state=TextRecordState.EXPIRED))
    )
    assert text_pipeline.history.get_by_id(mined_line.id) is None
    assert text_pipeline.history[0].prev is None


@pytest.mark.parametrize("paused", [False, True])
def test_stats_pause_controls_stats_discord_and_database_only(text_pipeline, paused):
    text_pipeline.state.text_input_paused = paused
    first = gametext._ingest_line_sync("そんな音を", source="texthook", merge_fragments=True, revision_window_ms=5000)
    revised = gametext._ingest_line_sync(
        "そんな音を聞きながら、わたしは眠りに落ちていく。",
        source="texthook",
        merge_fragments=True,
        revision_window_ms=5000,
    )
    assert first.line_id == revised.line_id
    assert gametext.freeze_authoritative_text_line(first.line_id)
    outputs = text_pipeline.outputs

    assert [event.kind for event in outputs.events] == [
        TextEventKind.APPENDED,
        TextEventKind.UPDATED,
        TextEventKind.FROZEN,
    ]
    assert len(outputs.overlay) == 2
    assert [command.line.excluded_from_stats for command in outputs.overlay] == [paused, paused]
    assert len(outputs.subtitles) == 1
    assert outputs.subtitles[0].text == "そんな音を聞きながら、わたしは眠りに落ちていく。"
    assert len(outputs.stats) == (0 if paused else 2)
    assert len(outputs.discord) == (0 if paused else 2)
    assert len(outputs.database) == (0 if paused else 1)


def test_resuming_intake_does_not_reclassify_paused_history(text_pipeline):
    text_pipeline.state.text_input_paused = True
    paused = gametext._ingest_line_sync("夢だったのかもしれない。", source="texthook", revision_window_ms=5000)
    text_pipeline.state.text_input_paused = False
    resumed = gametext._ingest_line_sync("今日からは離れないようにしよう。", source="texthook")
    gametext.freeze_authoritative_text_line(resumed.line_id)

    assert paused.line_id != resumed.line_id
    assert text_pipeline.history.get_by_id(paused.line_id).excluded_from_stats is True
    assert text_pipeline.history.get_by_id(resumed.line_id).excluded_from_stats is False
    assert len(text_pipeline.outputs.stats) == 1
    assert len(text_pipeline.outputs.discord) == 1
    assert [line.id for line in text_pipeline.outputs.database] == [resumed.line_id]
