from pathlib import Path
from types import SimpleNamespace

import pytest

from GameSentenceMiner import anki
from GameSentenceMiner.util.media.screenshot_selection import ScreenshotMedia, ScreenshotSelectionResult


class ExistingNote:
    noteId = 42

    def __init__(self, fields):
        self.fields = fields

    def get_field(self, name):
        return self.fields.get(name, "")


def _result(tmp_path, names):
    items = []
    for index, name in enumerate(names):
        path = tmp_path / name
        path.write_bytes(b"image")
        items.append(ScreenshotMedia(str(path), float(index)))
    return ScreenshotSelectionResult("recording.mp4", tuple(items))


def _config(append=False):
    return SimpleNamespace(
        anki=SimpleNamespace(
            picture_field="Picture",
            previous_image_field="Previous",
            append=append,
        )
    )


def _field_config(field_key, anki_cfg=None):
    name = "Picture" if field_key == "picture_field" else "Previous"
    return SimpleNamespace(name=name, enabled=True, append=anki_cfg.append, overwrite=not anki_cfg.append)


def test_selected_stills_replace_one_target_and_keep_unrelated_html(tmp_path, monkeypatch):
    monkeypatch.setattr(anki, "_get_anki_field_config", _field_config)
    monkeypatch.setattr(anki, "store_media_file", lambda path, **kwargs: Path(path).name)
    result = _result(tmp_path, ["first.avif", "second.avif", "third.avif", "fourth.avif"])
    assets = anki.MediaAssets(selected_screenshots=result)
    old = '<span>caption</span><img src="old.avif"><em>keep</em><img src="unrelated.avif">'
    note = {"id": 42, "fields": {}}
    anki._process_selected_screenshots(assets, note, _config(), ExistingNote({"Picture": old}))
    html = note["fields"]["Picture"]
    assert html == (
        '<span>caption</span><img src="first.avif"><img src="second.avif">'
        '<img src="third.avif"><img src="fourth.avif"><em>keep</em><img src="unrelated.avif">'
    )
    assert assets.screenshot_media_in_anki == [Path(item.path).name for item in result.items]
    assert assets.screenshot_in_anki == "first.avif"


def test_selection_appends_whole_collection_when_field_policy_appends(tmp_path, monkeypatch):
    monkeypatch.setattr(anki, "_get_anki_field_config", _field_config)
    monkeypatch.setattr(anki, "store_media_file", lambda path, **kwargs: Path(path).name)
    assets = anki.MediaAssets(selected_screenshots=_result(tmp_path, ["one.avif", "two.avif"]))
    note = {"id": 42, "fields": {}}
    anki._process_selected_screenshots(assets, note, _config(append=True), ExistingNote({"Picture": "old text"}))
    assert note["fields"]["Picture"] == 'old text<img src="one.avif"><img src="two.avif">'


def test_upload_failure_leaves_note_fields_unmodified(tmp_path, monkeypatch):
    monkeypatch.setattr(anki, "_get_anki_field_config", _field_config)
    calls = iter(["one.avif", None])
    monkeypatch.setattr(anki, "store_media_file", lambda path, **kwargs: next(calls))
    assets = anki.MediaAssets(selected_screenshots=_result(tmp_path, ["one.avif", "two.avif"]))
    note = {"id": 42, "fields": {}}
    with pytest.raises(RuntimeError, match="not changed"):
        anki._process_selected_screenshots(assets, note, _config(), ExistingNote({"Picture": '<img src="old">'}))
    assert note["fields"] == {}


def test_collection_from_another_recording_is_rejected_before_upload(tmp_path, monkeypatch):
    monkeypatch.setattr(anki, "_get_anki_field_config", _field_config)
    uploads = []
    monkeypatch.setattr(anki, "store_media_file", lambda *args, **kwargs: uploads.append(args))
    assets = anki.MediaAssets(
        source_video_path="the-current-recording.mp4",
        selected_screenshots=_result(tmp_path, ["one.avif"]),
    )
    note = {"id": 42, "fields": {}}
    with pytest.raises(RuntimeError, match="different recording"):
        anki._process_selected_screenshots(assets, note, _config(), ExistingNote({"Picture": "old"}))
    assert uploads == []
    assert note["fields"] == {}


def test_two_collections_sharing_destination_keep_every_item(tmp_path, monkeypatch):
    monkeypatch.setattr(
        anki,
        "_get_anki_field_config",
        lambda field_key, anki_cfg=None: SimpleNamespace(name="Picture", enabled=True, append=False, overwrite=True),
    )
    monkeypatch.setattr(anki, "store_media_file", lambda path, **kwargs: Path(path).name)
    assets = anki.MediaAssets(
        selected_screenshots=_result(tmp_path, ["main-one.avif", "main-two.avif"]),
        selected_prev_screenshots=_result(tmp_path, ["previous-one.avif"]),
    )
    note = {"id": 42, "fields": {}}
    anki._process_selected_screenshots(assets, note, _config(), ExistingNote({"Picture": '<img src="old">'}))
    assert note["fields"]["Picture"] == (
        '<img src="main-one.avif"><img src="main-two.avif"><img src="previous-one.avif">'
    )


def test_hotkey_hands_complete_collection_to_background_update(tmp_path, monkeypatch):
    result = _result(tmp_path, ["one.avif", "two.avif"])
    captures = []
    monkeypatch.setattr(anki, "submit_background_work", lambda callback: callback())
    monkeypatch.setattr(anki, "check_and_update_note", lambda *args, **kwargs: captures.append(kwargs))
    anki.add_image_to_card(ExistingNote({"Picture": '<img src="old">'}), result)
    assert captures[0]["assets"].selected_screenshots is result
    assert captures[0]["assets"].screenshot_path == result.items[0].path
    assert captures[0]["update_picture_flag"] is True


@pytest.mark.parametrize("fail_second", [False, True])
def test_background_note_update_is_atomic_for_selected_collection(tmp_path, monkeypatch, fail_second):
    monkeypatch.setattr(anki, "_get_anki_field_config", _field_config)
    config = _config()
    config.anki.word_field = "Word"
    monkeypatch.setattr(anki, "get_config", lambda: config)
    uploads = []

    def upload(path, **kwargs):
        uploads.append(path)
        return None if fail_second and len(uploads) == 2 else Path(path).name

    monkeypatch.setattr(anki, "store_media_file", upload)
    updates = []
    errors = []
    monkeypatch.setattr(
        anki, "_update_anki_note", lambda last, note, tags, assets, **kwargs: updates.append(note.copy()) or []
    )
    monkeypatch.setattr(anki, "_notify_anki_enhancement_failure", errors.append)
    monkeypatch.setattr(anki, "_perform_post_update_actions", lambda *args: None)
    monkeypatch.setattr(anki, "_trigger_incremental_anki_cache_sync", lambda *args: None)
    assets = anki.MediaAssets(selected_screenshots=_result(tmp_path, ["one.avif", "two.avif"]))
    last_note = ExistingNote({"Picture": '<img src="old.avif">', "Word": ""})
    anki.check_and_update_note(last_note, {"id": 42, "fields": {}}, assets=assets, update_picture_flag=True)
    assert len(uploads) == 2
    if fail_second:
        assert updates == []
        assert errors
    else:
        assert len(updates) == 1
        assert updates[0]["fields"]["Picture"] == '<img src="one.avif"><img src="two.avif">'
