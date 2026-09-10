import asyncio
import json
import queue
import threading
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


def test_textfeed_v2_snapshot_buffers_concurrent_delta_behind_snapshot(monkeypatch):
    intake_queue = queue.Queue()
    server = MultiplexWebsocketServerThread(
        name="test",
        get_port_func=lambda: 0,
        msg_queue=intake_queue,
        is_paused_func=lambda: False,
        endpoint_specs={ID_HOOKER: EndpointSpec(read_mode=True)},
    )
    snapshot_started = threading.Event()
    release_snapshot = threading.Event()

    def build_snapshot(_request):
        snapshot_started.set()
        assert release_snapshot.wait(1)
        return {
            "event": "text_v2_snapshot",
            "snapshot_sequence": 10,
            "lines": [],
        }

    monkeypatch.setattr(
        "GameSentenceMiner.web.gsm_websocket.build_textfeed_v2_snapshot_payload",
        build_snapshot,
    )

    class FakeWebsocket:
        def __init__(self):
            self.sent = []

        async def send(self, message):
            self.sent.append(json.loads(message))

    websocket = FakeWebsocket()
    server._get_clients(ID_HOOKER).add(websocket)

    async def scenario():
        snapshot_task = asyncio.create_task(
            server._handle_incoming_message(
                ID_HOOKER,
                websocket,
                json.dumps({"event": "text_v2_snapshot_request"}),
            )
        )
        await asyncio.to_thread(snapshot_started.wait, 1)
        await server._send_v2_text_coroutine(
            json.dumps({"event": "text_v2_append", "data": {"stream_sequence": 11}}),
        )
        release_snapshot.set()
        await snapshot_task

    asyncio.run(scenario())

    assert [message["event"] for message in websocket.sent] == [
        "text_v2_snapshot",
        "text_v2_append",
    ]


def test_textfeed_v2_delta_is_not_delivered_to_legacy_client():
    server = MultiplexWebsocketServerThread(
        name="test",
        get_port_func=lambda: 0,
        msg_queue=queue.Queue(),
        is_paused_func=lambda: False,
        endpoint_specs={ID_HOOKER: EndpointSpec(read_mode=True)},
    )

    class FakeWebsocket:
        def __init__(self):
            self.closed = None

        async def close(self, **kwargs):
            self.closed = kwargs

    legacy = FakeWebsocket()
    negotiated_v2 = FakeWebsocket()

    async def scenario():
        server._get_clients(ID_HOOKER).update({legacy, negotiated_v2})
        server._v2_clients.add(negotiated_v2)
        server._client_output_queues[legacy] = asyncio.Queue(maxsize=4)
        server._client_output_queues[negotiated_v2] = asyncio.Queue(maxsize=4)

        await server._send_v2_text_coroutine(json.dumps({"event": "text_v2_append", "data": {"stream_sequence": 1}}))

        assert server._client_output_queues[legacy].empty()
        delivered = json.loads(server._client_output_queues[negotiated_v2].get_nowait())
        assert delivered["event"] == "text_v2_append"

    asyncio.run(scenario())


def test_textfeed_legacy_line_is_not_delivered_to_negotiated_v2_client():
    server = MultiplexWebsocketServerThread(
        name="test",
        get_port_func=lambda: 0,
        msg_queue=queue.Queue(),
        is_paused_func=lambda: False,
        endpoint_specs={ID_HOOKER: EndpointSpec(read_mode=True)},
    )

    class FakeWebsocket:
        async def close(self, **_kwargs):
            pass

    legacy = FakeWebsocket()
    negotiated_v2 = FakeWebsocket()

    async def scenario():
        server._get_clients(ID_HOOKER).update({legacy, negotiated_v2})
        server._v2_clients.add(negotiated_v2)
        server._client_output_queues[legacy] = asyncio.Queue(maxsize=4)
        server._client_output_queues[negotiated_v2] = asyncio.Queue(maxsize=4)

        await server._send_legacy_text_coroutine(json.dumps({"event": "text_received"}))

        delivered = json.loads(server._client_output_queues[legacy].get_nowait())
        assert delivered["event"] == "text_received"
        assert server._client_output_queues[negotiated_v2].empty()

    asyncio.run(scenario())


def test_textfeed_legacy_projection_publishes_append_immediately(monkeypatch):
    from datetime import datetime

    from GameSentenceMiner.text_pipeline.models import TextEventKind
    from GameSentenceMiner.web import gsm_websocket, texthooking_page

    calls = []

    class FakeEventManager:
        def __init__(self):
            self.item = None

        def upsert_gameline(self, line):
            self.item = SimpleNamespace(
                text=line.text,
                to_serializable=lambda: {"id": line.id, "text": line.text, "state": "provisional"},
            )

        def get(self, _line_id):
            return self.item

    class FakeWebsocketManager:
        def send_textfeed_v2_nowait(self, message):
            calls.append(("v2", message))

        def send_textfeed_legacy_nowait(self, message):
            calls.append(("legacy", message))

        def send_nowait(self, server_id, message):
            calls.append((server_id, message))

    event_manager = FakeEventManager()
    websocket_manager = FakeWebsocketManager()
    monkeypatch.setattr(texthooking_page, "event_manager", event_manager)
    monkeypatch.setattr(gsm_websocket, "websocket_manager", websocket_manager)

    line = SimpleNamespace(id="line-1", text="clipboard text", time=datetime(2026, 8, 16, 12, 0, 0))
    event = SimpleNamespace(
        kind=TextEventKind.APPENDED,
        record=line,
        to_wire=lambda: {"event": "text_v2_append", "data": {"id": "line-1"}},
    )

    texthooking_page.project_text_domain_event(event, line)

    assert [name for name, _message in calls] == ["v2", "legacy", gsm_websocket.ID_PLAINTEXT]


def test_slow_textfeed_client_is_disconnected_when_output_mailbox_fills():
    server = MultiplexWebsocketServerThread(
        name="test",
        get_port_func=lambda: 0,
        msg_queue=queue.Queue(),
        is_paused_func=lambda: False,
        endpoint_specs={ID_HOOKER: EndpointSpec(read_mode=True)},
    )

    class FakeWebsocket:
        def __init__(self):
            self.closed = None

        async def close(self, **kwargs):
            self.closed = kwargs

    websocket = FakeWebsocket()

    async def scenario():
        clients = server._get_clients(ID_HOOKER)
        clients.add(websocket)
        output = asyncio.Queue(maxsize=1)
        output.put_nowait("already queued")
        server._client_output_queues[websocket] = output
        await server._send_text_coroutine(ID_HOOKER, "next")
        assert websocket not in clients

    asyncio.run(scenario())

    assert websocket.closed == {"code": 1013, "reason": "TextFeed client output queue exceeded"}


def test_configured_direct_websocket_port_replaces_only_the_internal_ingress(monkeypatch):
    from GameSentenceMiner.web import gsm_websocket

    config = SimpleNamespace(
        general=SimpleNamespace(single_port=7275),
        advanced=SimpleNamespace(direct_websocket_port=8383, texthooker_communication_websocket_port=7276),
    )
    monkeypatch.setattr(gsm_websocket, "get_config", lambda: config)
    monkeypatch.setattr(gsm_websocket, "_internal_ws_ingress_port", 49152)

    assert gsm_websocket.get_default_websocket_ingress_port() == 8383

    config.advanced.direct_websocket_port = 7275
    assert gsm_websocket.get_default_websocket_ingress_port() == 49152

    config.advanced.direct_websocket_port = 7276
    assert gsm_websocket.get_default_websocket_ingress_port() == 49152
