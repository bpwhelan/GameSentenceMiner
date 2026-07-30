import asyncio
import json
import queue
from types import SimpleNamespace

from GameSentenceMiner.web.events import EventManager
from GameSentenceMiner.web.gsm_websocket import (
    EndpointSpec,
    ID_HOOKER,
    MultiplexWebsocketServerThread,
    build_gsm_profile_state_payload,
    build_textfeed_session_sync_payload,
)


def _line(line_id: str, text: str):
    from datetime import datetime

    return SimpleNamespace(id=line_id, text=text, time=datetime(2026, 7, 25, 12, 0, 0))


def test_build_gsm_profile_state_payload_serializes_current_profile_and_scenes():
    master_config = SimpleNamespace(
        current_profile="Visual Novel",
        configs={
            "Default": SimpleNamespace(scenes=[]),
            "Visual Novel": SimpleNamespace(scenes=["Game", " Reading ", ""]),
        },
    )

    assert build_gsm_profile_state_payload(master_config) == {
        "type": "gsm-profile-state-updated",
        "currentProfileName": "Visual Novel",
        "profiles": [
            {"name": "Default", "scenes": []},
            {"name": "Visual Novel", "scenes": ["Game", "Reading"]},
        ],
    }


def test_build_gsm_profile_state_payload_falls_back_to_available_profile():
    master_config = SimpleNamespace(
        current_profile="Missing",
        configs={"Default": SimpleNamespace(scenes=["Fallback"])},
    )

    payload = build_gsm_profile_state_payload(master_config)

    assert payload["currentProfileName"] == "Default"
    assert payload["profiles"] == [{"name": "Default", "scenes": ["Fallback"]}]


def test_textfeed_session_sync_uses_only_ids_from_current_server_session():
    manager = EventManager()
    manager.add_gameline(_line("one", "一"))
    manager.add_gameline(_line("two", "二"))
    manager.add_gameline(_line("three", "三"))
    manager.remove_lines_by_ids(["one"], timed_out=True)

    payload = build_textfeed_session_sync_payload(
        {
            "event": "textfeed_session_sync_request",
            "sessions": {
                "some-previous-session": ["one", "three"],
                manager.session_id: ["two"],
            },
        },
        manager,
    )

    assert payload["event"] == "textfeed_session_sync"
    assert payload["session_id"] == manager.session_id
    assert payload["ordered_ids"] == ["one", "two", "three"]
    assert payload["active_ids"] == ["two", "three"]
    assert payload["timed_out_ids"] == ["one"]
    assert [line["data"]["id"] for line in payload["lines"]] == ["one", "three"]
    assert [line["sentence"] for line in payload["lines"]] == ["一", "三"]


def test_textfeed_session_sync_is_bounded_to_requested_tail():
    manager = EventManager()
    for line_id in ("one", "two", "three", "four", "five"):
        manager.add_gameline(_line(line_id, line_id))
    manager.remove_lines_by_ids(["four"], timed_out=True)

    payload = build_textfeed_session_sync_payload(
        {
            "event": "textfeed_session_sync_request",
            "sessions": {manager.session_id: ["five"]},
            "max_lines": 2,
        },
        manager,
    )

    assert payload["ordered_ids"] == ["four", "five"]
    assert payload["active_ids"] == ["five"]
    assert payload["timed_out_ids"] == ["four"]
    assert [line["data"]["id"] for line in payload["lines"]] == ["four"]


def test_textfeed_session_sync_request_is_not_forwarded_as_game_text():
    intake_queue = queue.Queue()
    server = MultiplexWebsocketServerThread(
        name="test",
        get_port_func=lambda: 0,
        msg_queue=intake_queue,
        is_paused_func=lambda: False,
        endpoint_specs={ID_HOOKER: EndpointSpec(read_mode=True)},
    )

    class FakeWebsocket:
        def __init__(self):
            self.sent = []

        async def send(self, message):
            self.sent.append(json.loads(message))

    websocket = FakeWebsocket()
    asyncio.run(
        server._handle_incoming_message(
            ID_HOOKER,
            websocket,
            json.dumps({"event": "textfeed_session_sync_request", "sessions": {}}),
        )
    )

    assert intake_queue.empty()
    assert websocket.sent[0]["event"] == "textfeed_session_sync"
