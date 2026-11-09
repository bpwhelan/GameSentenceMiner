from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest

from GameSentenceMiner import anki, session_review
from GameSentenceMiner.util.config.configuration import ProfileConfig
from GameSentenceMiner.util.models.model import AnkiCard, AnkiField, VADResult
from GameSentenceMiner.util.text_log import GameLine
from GameSentenceMiner.vad import Segment


@pytest.fixture
def saved_review(tmp_path, monkeypatch):
    from GameSentenceMiner import session_review_context

    monkeypatch.setattr(session_review_context, "_pending", {})
    config = ProfileConfig()
    config.features.review_after_session.enabled = True
    config.anki.sentence_furigana_field = ""
    monkeypatch.setattr(session_review, "get_review_root", lambda: tmp_path / "reviews")
    monkeypatch.setattr(anki, "get_config", lambda: config)
    monkeypatch.setattr(session_review, "get_config", lambda: config)
    monkeypatch.setattr(anki, "invoke", lambda action, **kwargs: "User 1")
    from GameSentenceMiner.util.media import ffmpeg

    monkeypatch.setattr(ffmpeg, "get_video_duration", lambda path: 10)
    replay = tmp_path / "replay.mkv"
    replay.write_bytes(b"replay")
    audio = tmp_path / "audio.opus"
    audio.write_bytes(b"audio")
    now = datetime.now(UTC).astimezone().replace(tzinfo=None)
    previous = GameLine("previous", "Before", now - timedelta(seconds=4), None, None, scene="Game")
    line = GameLine("selected", "Sentence", now, previous, None, scene="Game", mined_time=now)
    previous.next = line
    fields = {
        name: AnkiField(value, index)
        for index, (name, value) in enumerate(
            [
                (config.anki.word_field, "Expression"),
                (config.anki.sentence_field, "Sentence"),
                (config.anki.picture_field, ""),
                (config.anki.sentence_audio_field, ""),
            ]
        )
        if name
    }
    card = AnkiCard(123, [], fields, [], "Basic")
    assets = anki.MediaAssets(audio_path=str(audio), source_video_path=str(replay))
    entry = session_review.save_pending_review(
        card,
        assets,
        video_path=str(replay),
        game_line=line,
        selected_lines=[],
        sentence="Sentence",
        translation="Meaning",
        ss_time=2,
        start_time=1,
        end_time=3,
        vad_result=VADResult(
            True,
            0,
            2,
            "test",
            segments=[Segment(0.25, 0.75, "こんにちは", -0.2), Segment(1.0, 1.75)],
            output_audio=str(audio),
            trimmed_audio_path=str(audio),
        ),
        config=config,
        replay_context=None,
    )
    session_review.release_entry(entry)
    return entry, config, replay, audio


def test_review_survives_source_cleanup_and_reload(saved_review):
    entry, config, replay, audio = saved_review
    replay.unlink()
    audio.unlink()
    pending = session_review.list_pending_reviews(config)
    assert [item.id for item in pending] == [entry.id]
    prepared = session_review.load_review(entry)
    assert prepared.context.video_path != str(replay)
    assert prepared.context.mined_line.prev.text == "Before"
    assert prepared.context.mined_line.clip is not None
    assert prepared.audio_path and Path(prepared.audio_path).read_bytes() == b"audio"


def test_review_restores_speech_segments_after_reload(saved_review):
    entry, config, replay, audio = saved_review
    replay.unlink()
    audio.unlink()

    reloaded = session_review.list_pending_reviews(config)[0]
    restored = session_review.load_review(reloaded).context.vad_result

    assert reloaded.id == entry.id
    assert restored.segments == [Segment(0.25, 0.75, "こんにちは", -0.2), Segment(1.0, 1.75)]
    assert restored.success and restored.voice_detected
    assert (restored.start, restored.end, restored.model, restored.tts_used) == (0, 2, "test", False)
    assert Path(restored.output_audio).read_bytes() == b"audio"
    assert restored.trimmed_audio_path == restored.output_audio


def test_in_flight_and_other_profile_reviews_are_hidden(saved_review):
    entry, config, *_ = saved_review
    session_review.claim_entry(entry)
    assert session_review.list_pending_reviews(config) == []
    session_review.release_entry(entry)
    config.name = "Other"
    assert session_review.list_pending_reviews(config) == []


def test_completed_review_cleans_only_its_own_files(saved_review):
    entry, config, replay, audio = saved_review
    session_review.finish_review(entry, config.features.review_after_session)
    assert not entry.folder.exists()
    assert replay.exists() and audio.exists()
    assert session_review.list_pending_reviews(config) == []


def test_game_close_requires_known_active_session_and_delay():
    gate = session_review.SessionCloseGate()
    assert gate.observe({"sceneName": "Game", "active": False}, 0, 3) is None
    assert gate.observe({"sceneName": "Game", "active": True}, 1, 3) is None
    assert gate.observe({"sceneName": "Game", "active": None}, 2, 3) is None
    assert gate.observe({"sceneName": "Game", "active": False}, 3, 3) is None
    assert gate.observe({"sceneName": "Game", "active": True}, 4, 3) is None
    assert gate.observe({"sceneName": "Game", "active": False}, 5, 3) is None
    assert gate.observe({"sceneName": "Game", "active": False}, 8, 3) == "Game"
    assert gate.observe({"sceneName": "Game", "active": False}, 9, 3) is None


def test_deferred_mode_skips_live_confirmation():
    config = ProfileConfig()
    config.features.review_after_session.enabled = True
    assert not anki._should_show_confirmation_dialog(config, VADResult(True, 0, 1, "test"))


def test_open_review_in_anki_verifies_collection_and_only_opens_editor(saved_review, monkeypatch):
    entry, *_ = saved_review
    _, calls = mock_note_api(monkeypatch, entry)
    session_review.open_in_anki(entry)
    assert calls[-1] == ("guiEditNote", {"note": 123})
    assert all(action in {"getActiveProfile", "notesInfo", "guiEditNote"} for action, _ in calls)
    assert entry.folder.exists()


def test_startup_notification_counts_pending_reviews_and_respects_preference(saved_review, monkeypatch):
    from GameSentenceMiner.util.platform import notification

    entry, config, *_ = saved_review
    sent = []
    monkeypatch.setattr(notification, "send_pending_reviews_notification", lambda count: sent.append(count))
    assert session_review.notify_pending_on_startup()
    assert sent == [1]
    config.features.review_after_session.notify_on_startup = False
    assert not session_review.notify_pending_on_startup()
    assert sent == [1]
    config.features.review_after_session.notify_on_startup = True
    session_review.finish_review(entry, config.features.review_after_session)
    assert not session_review.notify_pending_on_startup()
    assert sent == [1]


def test_cleanup_keeps_shared_media_and_uses_ankiconnect(monkeypatch):
    calls = []

    def invoke(action, **kwargs):
        calls.append((action, kwargs))
        if action == "findNotes":
            return [42] if "shared.opus" in kwargs["query"] else []
        if action == "modelNames":
            return []

    monkeypatch.setattr(anki, "invoke", invoke)
    assert session_review.cleanup_unused_media(["old.opus", "shared.opus"]) == []
    assert [(action, args) for action, args in calls if action == "deleteMediaFile"] == [
        ("deleteMediaFile", {"filename": "old.opus"})
    ]


def test_cleanup_failure_keeps_media_for_retry(monkeypatch):
    monkeypatch.setattr(anki, "invoke", lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("offline")))
    assert session_review.cleanup_unused_media(["old.opus"]) == ["old.opus"]


def mock_note_api(monkeypatch, entry, *, fail_update=False):
    fields = dict(entry.data["fields"])
    calls = []

    def invoke(action, **kwargs):
        calls.append((action, kwargs))
        if action == "getActiveProfile":
            return "User 1"
        if action == "notesInfo":
            return [
                {
                    "noteId": entry.data["note_id"],
                    "modelName": "Basic",
                    "tags": [],
                    "cards": [],
                    "fields": {
                        key: {"value": value, "order": index} for index, (key, value) in enumerate(fields.items())
                    },
                }
            ]
        if action == "updateNoteFields":
            if fail_update:
                raise RuntimeError("offline")
            fields.update(kwargs["note"]["fields"])
        if action in ("modelNames", "guiSelectedNotes", "findNotes"):
            return []

    monkeypatch.setattr(anki, "invoke", invoke)
    monkeypatch.setattr(anki, "_trigger_incremental_anki_cache_sync", lambda ids: None)
    return fields, calls


def saved_media(entry, config):
    config.anki.previous_image_field = "PreviousPicture"
    config.anki.video_field = "Video"
    config.anki.field_grouping_enabled = True
    entry.data["anki_config"] = config.anki.to_dict()
    entry.data["translation_field"] = "Meaning"
    entry.data["fields"].update(
        SentenceAudio="[sound:old.opus]",
        Picture='<img src="old.png">',
        PreviousPicture='<img src="previous.png">',
        Video="old.mp4",
        Meaning="Meaning",
    )
    for key, filename in (("screenshot", "preview.png"), ("previous_screenshot", "previous-preview.png")):
        entry.data[key] = filename
        (entry.folder / filename).write_bytes(b"preview")
    entry.data["owned_media"] = ["old.opus", "old.png", "previous.png", "old.mp4"]
    entry.data["pending_animated"] = entry.data["pending_video"] = True
    entry.save()


def unchanged_result(entry, prepared, **changes):
    values = {
        "voice": True,
        "sentence": entry.data["sentence"],
        "translation": entry.data["translation"],
        "screenshot": prepared.screenshot_path,
        "previous": prepared.previous_screenshot_path,
        "nsfw": False,
        "audio": prepared.audio_path,
        "metadata": {},
    }
    values.update(changes)
    return tuple(values.values())


def forbid_media_work(monkeypatch, *, except_processors=()):
    for name in (
        "_process_audio",
        "_process_screenshot",
        "_process_previous_screenshot",
        "_process_selected_screenshots",
        "_process_animated_screenshot",
        "_process_video",
        "_synchronize_deferred_media_metadata",
        "_resolve_field_grouping_decision",
    ):
        if name not in except_processors:
            monkeypatch.setattr(anki, name, lambda *args, _name=name, **kwargs: pytest.fail(f"Unexpected {_name}"))


@pytest.mark.parametrize("with_audio", [True, False])
def test_unchanged_confirmation_only_removes_local_queue_entry(saved_review, monkeypatch, with_audio):
    entry, config, *_ = saved_review
    saved_media(entry, config)
    if not with_audio:
        entry.data["fields"][config.anki.sentence_audio_field] = ""
    prepared = session_review.load_review(entry)
    forbid_media_work(monkeypatch)
    monkeypatch.setattr(anki, "invoke", lambda *args, **kwargs: pytest.fail("Unchanged confirmation contacted Anki"))
    monkeypatch.setattr(session_review, "cleanup_unused_media", lambda *args: pytest.fail("Unchanged media cleanup"))
    session_review.apply_review(entry, prepared, unchanged_result(entry, prepared, voice=with_audio))
    assert not entry.folder.exists()


@pytest.mark.parametrize(("changed", "field"), [("sentence", "Sentence"), ("translation", "Meaning")])
def test_text_only_edit_never_processes_or_uploads_media(saved_review, monkeypatch, changed, field):
    from GameSentenceMiner.util.database.db import GameLinesTable

    entry, config, *_ = saved_review
    saved_media(entry, config)
    fields, calls = mock_note_api(monkeypatch, entry)
    prepared = session_review.load_review(entry)
    original_media = {key: fields[key] for key in ("SentenceAudio", "Picture", "PreviousPicture", "Video")}
    # Edits made independently in Anki to an untouched field must also survive.
    fields["SentenceAudio"] = original_media["SentenceAudio"] = "[sound:external.opus]"
    forbid_media_work(monkeypatch)
    history_writes = []
    monkeypatch.setattr(GameLinesTable, "update", lambda **kwargs: history_writes.append(kwargs))
    monkeypatch.setattr(session_review, "cleanup_unused_media", lambda *args: pytest.fail("Text edit cleaned media"))
    session_review.apply_review(entry, prepared, unchanged_result(entry, prepared, **{changed: "Edited text"}))
    writes = [args["note"]["fields"] for action, args in calls if action == "updateNoteFields"]
    assert writes == [{field: "Edited text"}]
    assert {key: fields[key] for key in original_media} == original_media
    assert not any(action in ("addTags", "removeTags", "deleteMediaFile", "storeMediaFile") for action, _ in calls)
    assert history_writes == (
        [{"line_id": entry.data["line_id"], "translation": "Edited text"}] if changed == "translation" else []
    )


def test_tag_only_edit_does_not_rewrite_fields_or_media(saved_review, monkeypatch):
    entry, config, *_ = saved_review
    saved_media(entry, config)
    _, calls = mock_note_api(monkeypatch, entry)
    prepared = session_review.load_review(entry)
    forbid_media_work(monkeypatch)
    session_review.apply_review(entry, prepared, unchanged_result(entry, prepared, nsfw=True))
    assert ("addTags", {"notes": [123], "tags": "NSFW"}) in calls
    assert not any(action in ("updateNoteFields", "removeTags", "deleteMediaFile") for action, _ in calls)


@pytest.mark.parametrize(
    ("changed", "field", "processor", "old_name", "new_name"),
    [
        ("audio", "SentenceAudio", "_process_audio", "old.opus", "new.opus"),
        ("screenshot", "Picture", "_process_screenshot", "old.png", "new.png"),
        ("previous", "PreviousPicture", "_process_previous_screenshot", "previous.png", "new-previous.png"),
    ],
)
def test_media_edit_only_processes_and_cleans_the_changed_media(
    saved_review, monkeypatch, tmp_path, changed, field, processor, old_name, new_name
):
    entry, config, *_ = saved_review
    saved_media(entry, config)
    _, calls = mock_note_api(monkeypatch, entry)
    prepared = session_review.load_review(entry)
    selected = tmp_path / new_name
    selected.write_bytes(b"new media")
    forbid_media_work(monkeypatch, except_processors=(processor,))
    cleaned = []
    monkeypatch.setattr(session_review, "cleanup_unused_media", lambda names: cleaned.extend(names) or [])
    asset_field = {"audio": "audio_in_anki", "screenshot": "screenshot_in_anki", "previous": "prev_screenshot_in_anki"}[
        changed
    ]
    value = f"[sound:{new_name}]" if changed == "audio" else f'<img src="{new_name}">'

    def process(assets, note, *args, **kwargs):
        setattr(assets, asset_field, new_name)
        note["fields"][field] = value

    monkeypatch.setattr(anki, processor, process)
    session_review.apply_review(entry, prepared, unchanged_result(entry, prepared, **{changed: str(selected)}))
    assert [args["note"]["fields"] for action, args in calls if action == "updateNoteFields"] == [{field: value}]
    assert cleaned == [old_name]
    assert set(entry.data["owned_media"]) == ({"old.opus", "old.png", "previous.png", "old.mp4"} - {old_name}) | {
        new_name
    }


def test_removing_audio_does_not_upload_or_change_other_media(saved_review, monkeypatch):
    entry, config, *_ = saved_review
    saved_media(entry, config)
    _, calls = mock_note_api(monkeypatch, entry)
    prepared = session_review.load_review(entry)
    forbid_media_work(monkeypatch)
    cleaned = []
    monkeypatch.setattr(session_review, "cleanup_unused_media", lambda names: cleaned.extend(names) or [])
    session_review.apply_review(entry, prepared, unchanged_result(entry, prepared, voice=False))
    assert [args["note"]["fields"] for action, args in calls if action == "updateNoteFields"] == [{"SentenceAudio": ""}]
    assert cleaned == ["old.opus"]


def test_audio_cuts_export_only_audio_and_failure_keeps_review(saved_review, monkeypatch):
    from GameSentenceMiner.util.media import ffmpeg

    entry, config, *_ = saved_review
    saved_media(entry, config)
    _, calls = mock_note_api(monkeypatch, entry)
    prepared = session_review.load_review(entry)
    forbid_media_work(monkeypatch, except_processors=("_process_audio",))
    edit = session_review.ReviewAudioEdit(prepared.audio_path, 2, ((0, 0.5), (0.8, 2)))
    exported = []

    def splice(**kwargs):
        exported.append(kwargs)
        raise RuntimeError("encoder unavailable")

    monkeypatch.setattr(ffmpeg, "splice_audio", splice)
    with pytest.raises(RuntimeError, match="encoder unavailable"):
        session_review.apply_review(
            entry, prepared, unchanged_result(entry, prepared, metadata={"review_audio_edit": edit})
        )
    assert exported[0]["keep_ranges"] == [(0, 0.5), (0.8, 2)]
    assert not any(action in ("updateNoteFields", "storeMediaFile", "deleteMediaFile") for action, _ in calls)
    assert entry.folder.exists()
    assert not list(entry.folder.glob("work-*"))
    assert session_review.list_pending_reviews(config)


def test_review_updates_existing_note_and_removes_audio(saved_review, monkeypatch):
    entry, config, *_ = saved_review
    entry.data["fields"][config.anki.sentence_audio_field] = "[sound:old.opus]"
    entry.data["owned_media"] = ["old.opus"]
    fields, calls = mock_note_api(monkeypatch, entry)
    prepared = session_review.load_review(entry)
    result = (False, "Edited sentence", "Edited meaning", "", "", True, None, {})
    session_review.apply_review(entry, prepared, result)
    assert fields[config.anki.sentence_field] == "Edited sentence"
    assert fields[config.anki.sentence_audio_field] == ""
    assert any(action == "updateNoteFields" and args["note"]["id"] == 123 for action, args in calls)
    assert not any(action == "addNote" for action, _ in calls)
    assert not entry.folder.exists()


def test_failed_save_retains_queue_and_never_deletes_media(saved_review, monkeypatch):
    entry, config, *_ = saved_review
    _, calls = mock_note_api(monkeypatch, entry, fail_update=True)
    prepared = session_review.load_review(entry)
    with pytest.raises(RuntimeError, match="offline"):
        session_review.apply_review(entry, prepared, (False, "Edit", "", "", "", False, None, {}))
    assert [item.id for item in session_review.list_pending_reviews(config)] == [entry.id]
    assert Path(prepared.context.video_path).is_file()
    assert not any(action == "deleteMediaFile" for action, _ in calls)


def test_review_refuses_to_overwrite_external_field_edits(saved_review, monkeypatch):
    entry, *_ = saved_review
    fields, calls = mock_note_api(monkeypatch, entry)
    fields["Sentence"] = "Changed in Anki"
    prepared = session_review.load_review(entry)
    with pytest.raises(RuntimeError, match="changed in Anki"):
        session_review.apply_review(entry, prepared, (False, "Review edit", "", "", "", False, None, {}))
    assert not any(action == "updateNoteFields" for action, _ in calls)


def test_review_checks_collection_before_writing(saved_review, monkeypatch):
    entry, *_ = saved_review
    prepared = session_review.load_review(entry)
    monkeypatch.setattr(anki, "invoke", lambda action, **kwargs: "Wrong profile")
    with pytest.raises(RuntimeError, match="Open Anki profile"):
        session_review.apply_review(entry, prepared, (False, "Edit", "", "", "", False, None, {}))


def test_review_replaces_media_and_translation_using_original_field_mapping(saved_review, monkeypatch, tmp_path):
    from GameSentenceMiner.util.media.screenshot_selection import ScreenshotMedia, ScreenshotSelectionResult

    entry, config, *_ = saved_review
    config.anki.picture.append = True
    config.anki.picture.overwrite = False
    entry.data["anki_config"] = config.anki.to_dict()
    entry.data["translation_field"] = "Meaning"
    entry.data["fields"]["Meaning"] = "Old translation"
    entry.data["fields"]["Picture"] = '<img src="old.png">'
    fields, _ = mock_note_api(monkeypatch, entry)
    prepared = session_review.load_review(entry)
    image = tmp_path / "chosen.webp"
    image.write_bytes(b"test image")
    selected = ScreenshotSelectionResult(prepared.context.video_path, (ScreenshotMedia(str(image), 1),))
    monkeypatch.setattr(
        anki,
        "_store_asset_media_file",
        lambda assets, path, **kwargs: "review.webp" if kwargs["media_kind"] == "screenshot" else "review.opus",
    )
    # Use the real scoped getter here: the active mining config appends, but an explicit review replaces.
    from GameSentenceMiner.util.config.configuration import get_config as scoped_config

    monkeypatch.setattr(anki, "get_config", scoped_config)
    prepared.config.audio.ffmpeg_reencode_options = ""
    session_review.apply_review(
        entry, prepared, (True, "Edited", "New translation", selected, "", False, prepared.audio_path, {})
    )
    assert fields["Picture"] == '<img src="review.webp">'
    assert fields["SentenceAudio"] == "[sound:review.opus]"
    assert fields["Meaning"] == "New translation"
    assert image.exists()


def test_failed_media_upload_never_updates_note(saved_review, monkeypatch):
    entry, config, *_ = saved_review
    _, calls = mock_note_api(monkeypatch, entry)
    prepared = session_review.load_review(entry)
    monkeypatch.setattr(anki, "_store_asset_media_file", lambda *args, **kwargs: None)
    monkeypatch.setattr(anki, "_notify_anki_enhancement_failure", lambda *args: None)
    with pytest.raises(RuntimeError, match="could not be uploaded"):
        session_review.apply_review(entry, prepared, (True, "Edit", "", "", "", False, prepared.audio_path, {}))
    assert not any(action == "updateNoteFields" for action, _ in calls)
    assert session_review.list_pending_reviews(config)


def test_template_reference_prevents_media_deletion(monkeypatch):
    calls = []

    def invoke(action, **kwargs):
        calls.append(action)
        return {
            "modelNames": ["Basic"],
            "modelTemplates": {"Card": {"Front": '<img src="template.png">'}},
            "modelStyling": {"css": ""},
            "findNotes": [],
        }.get(action)

    monkeypatch.setattr(anki, "invoke", invoke)
    assert session_review.cleanup_unused_media(["template.png"]) == []
    assert "deleteMediaFile" not in calls


def test_replaced_media_is_removed_from_reuse_cache(monkeypatch):
    monkeypatch.setattr(
        anki,
        "anki_results",
        {"line": SimpleNamespace(audio_in_anki="old.opus"), "unrelated": SimpleNamespace(audio_in_anki="keep.opus")},
    )
    monkeypatch.setattr(
        anki,
        "sentence_audio_cache",
        {"cached": SimpleNamespace(line_id="line"), "other": SimpleNamespace(line_id="unrelated")},
    )
    session_review._invalidate_media_reuse("line", {"old.opus"})
    assert set(anki.anki_results) == {"unrelated"}
    assert set(anki.sentence_audio_cache) == {"other"}


def test_live_pipeline_queues_review_without_blocking_for_confirmation(saved_review, monkeypatch):
    from GameSentenceMiner.ui import qt_main

    entry, config, replay, audio = saved_review
    prepared = session_review.load_review(entry)
    line = prepared.context.mined_line
    line.excluded_from_stats = True
    monkeypatch.setattr(anki, "_determine_update_conditions", lambda card: (False, False))
    monkeypatch.setattr(anki, "_synchronize_deferred_media_metadata", lambda *args, **kwargs: None)
    monkeypatch.setattr(anki, "_prepare_anki_note_fields", lambda note, *args: note)
    monkeypatch.setattr(anki, "_prepare_anki_tags", lambda *args: [])
    monkeypatch.setattr(anki, "_handle_file_management", lambda *args, **kwargs: None)
    monkeypatch.setattr(
        qt_main, "launch_anki_confirmation", lambda *args, **kwargs: pytest.fail("Immediate confirmation opened")
    )
    workers = []
    monkeypatch.setattr(anki, "submit_background_work", workers.append)
    completed = []

    def update(*args, **kwargs):
        assert kwargs["deferred_review"]
        args[7](args[3])
        completed.append(True)

    monkeypatch.setattr(anki, "check_and_update_note", update)
    assert anki.update_anki_card(
        prepared.context.last_note,
        note={"id": 123, "fields": {"Sentence": "Sentence"}},
        game_line=line,
        video_path=str(replay),
        audio_path=str(audio),
        precomputed_assets=anki.MediaAssets(),
        should_update_audio=False,
    )
    assert [item.id for item in session_review.list_pending_reviews(config)] == [entry.id]
    assert len(workers) == 1
    workers[0]()
    assert completed
    assert len(session_review.list_pending_reviews(config)) == 2
