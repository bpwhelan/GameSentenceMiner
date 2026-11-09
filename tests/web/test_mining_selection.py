import asyncio
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from GameSentenceMiner.util.text_log import GameLine
from GameSentenceMiner.web import texthooking_page
from GameSentenceMiner.web.events import EventManager


@pytest.fixture
def selection_api(monkeypatch):
    from GameSentenceMiner import gametext

    manager = EventManager()
    for line_id in ("a", "b", "c"):
        manager.add_gameline(GameLine(id=line_id, text=line_id, time=datetime.now(UTC), prev=None, next=None))
    monkeypatch.setattr(texthooking_page, "event_manager", manager)
    monkeypatch.setattr(texthooking_page.websocket_manager, "send_nowait", Mock())
    freeze = Mock()
    monkeypatch.setattr(gametext, "freeze_authoritative_text_line", freeze)
    return texthooking_page.app.test_client(), manager, freeze


def test_batch_selection_is_idempotent_and_preserves_line_order(selection_api):
    api, manager, freeze = selection_api
    payload = {"updates": [{"id": "c", "checked": True}, {"id": "a", "checked": True}]}
    for _ in range(2):
        response = api.post("/update_checkboxes", json=payload)
        assert response.status_code == 200
        assert response.json["selected_ids"] == ["a", "c"]
    assert [event.id for event in manager if event.checked] == ["a", "c"]
    freeze.assert_not_called()


def test_selection_can_clear_a_range_and_skips_expired_or_missing_ids(selection_api):
    api, manager, _ = selection_api
    api.post("/update_checkboxes", json={"updates": [{"id": "a", "checked": True}, {"id": "b", "checked": True}]})
    response = api.post(
        "/update_checkboxes", json={"updates": [{"id": "a", "checked": False}, {"id": "missing", "checked": True}]}
    )
    assert response.status_code == 200
    assert response.json["selected_ids"] == ["b"]
    assert manager.get_state()["selected_ids"] == ["b"]


@pytest.mark.parametrize("updates", [None, "a", [{"id": "a", "checked": "true"}], [{"id": "a", "checked": True}, {}]])
def test_invalid_batches_do_not_partially_change_selection(selection_api, updates):
    api, manager, _ = selection_api
    assert api.post("/update_checkboxes", json={"updates": updates}).status_code == 400
    assert not any(event.checked for event in manager)


def test_selecting_speech_finalizes_it_once(selection_api):
    api, manager, freeze = selection_api
    manager.get("a").state = "provisional"
    assert api.post("/update_checkboxes", json={"updates": [{"id": "a", "checked": True}]}).status_code == 200
    freeze.assert_called_once_with("a")


def test_legacy_checkbox_endpoint_accepts_an_explicit_state(selection_api):
    api, manager, _ = selection_api
    for _ in range(2):
        assert api.post("/update_checkbox", json={"id": "a", "checked": True}).status_code == 200
    assert manager.get("a").checked


def _new_line(line_id, revision=1):
    line = GameLine(id=line_id, text=line_id, time=datetime.now(UTC), prev=None, next=None)
    line.revision = revision
    return line


def test_mining_selection_survives_one_new_line_and_expires_on_the_second(selection_api):
    api, manager, _ = selection_api
    api.post("/update_checkboxes", json={"updates": [{"id": "a", "checked": True}, {"id": "c", "checked": True}]})
    manager.add_gameline(_new_line("d"))
    assert manager.get_state()["selected_ids"] == ["a", "c"]
    manager.add_gameline(_new_line("e"))
    assert manager.get_state()["selected_ids"] == []
    assert texthooking_page.get_selected_lines() == []
    assert not texthooking_page.are_lines_selected()


def test_only_new_records_age_a_selection(selection_api):
    api, manager, _ = selection_api
    api.post("/update_checkboxes", json={"updates": [{"id": "a", "checked": True}]})
    manager.upsert_gameline(_new_line("d"))
    manager.upsert_gameline(_new_line("a", revision=2))
    manager.add_gameline(_new_line("d", revision=2))
    manager.upsert_gameline(_new_line("unknown-update"), age_selection=False)
    assert manager.get_state()["selected_ids"] == ["a"]
    manager.upsert_gameline(_new_line("e"))
    assert manager.get_state()["selected_ids"] == []


def test_changing_selection_starts_another_two_line_window(selection_api):
    api, manager, _ = selection_api
    api.post("/update_checkboxes", json={"updates": [{"id": "a", "checked": True}]})
    manager.add_gameline(_new_line("d"))
    api.post("/update_checkboxes", json={"updates": [{"id": "c", "checked": True}]})
    manager.add_gameline(_new_line("e"))
    assert manager.get_state()["selected_ids"] == ["a", "c"]
    manager.add_gameline(_new_line("f"))
    assert manager.get_state()["selected_ids"] == []


def test_retries_and_missing_ids_do_not_extend_selection_lifetime(selection_api):
    api, manager, _ = selection_api
    payload = {"updates": [{"id": "a", "checked": True}]}
    api.post("/update_checkboxes", json=payload)
    manager.add_gameline(_new_line("d"))
    api.post("/update_checkboxes", json=payload)
    api.post("/update_checkboxes", json={"updates": [{"id": "missing", "checked": True}]})
    manager.add_gameline(_new_line("e"))
    assert manager.get_state()["selected_ids"] == []


@pytest.mark.parametrize("authoritative", [False, True])
def test_feed_notifies_readers_once_when_selection_expires(selection_api, monkeypatch, authoritative):
    from GameSentenceMiner.text_pipeline.models import TextEventKind

    api, manager, _ = selection_api
    api.post("/update_checkboxes", json={"updates": [{"id": "a", "checked": True}]})
    broadcaster = texthooking_page.websocket_manager
    monkeypatch.setattr(broadcaster, "send", AsyncMock())
    monkeypatch.setattr(broadcaster, "send_textfeed_v2_nowait", Mock())
    monkeypatch.setattr(broadcaster, "send_textfeed_legacy_nowait", Mock())
    monkeypatch.setattr(texthooking_page, "check_for_lines_outside_replay_buffer", Mock())
    for line_id in ("d", "e", "f"):
        line = _new_line(line_id)
        if authoritative:
            event = SimpleNamespace(kind=TextEventKind.APPENDED, to_wire=lambda: {"event": "text_v2_append"})
            texthooking_page.project_text_domain_event(event, line)
        else:
            asyncio.run(texthooking_page.add_event_to_texthooker(line))
    resets = [call for call in broadcaster.send_nowait.call_args_list if call.args[1] == {"event": "reset_checkboxes"}]
    assert len(resets) == 1
    assert manager.get_state()["selected_ids"] == []
