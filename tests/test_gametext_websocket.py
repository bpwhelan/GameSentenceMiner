import asyncio
from types import SimpleNamespace

import GameSentenceMiner.gametext as gametext


def _make_config(*, use_websocket: bool):
    return SimpleNamespace(
        general=SimpleNamespace(
            use_websocket=use_websocket,
            use_clipboard=False,
            use_both_clipboard_and_websocket=False,
            websocket_sources=[],
        ),
        advanced=SimpleNamespace(),
    )


def test_listen_on_websocket_pauses_when_general_websocket_disabled(
    monkeypatch,
):
    stop_event = asyncio.Event()
    attempted_urls = []
    sleep_calls = []

    async def fake_sleep(seconds):
        sleep_calls.append(seconds)
        stop_event.set()

    monkeypatch.setattr(gametext, "get_config", lambda: _make_config(use_websocket=False))
    monkeypatch.setattr(
        gametext.websockets,
        "connect",
        lambda url, ping_interval=None: attempted_urls.append(url),
    )
    monkeypatch.setattr(gametext.asyncio, "sleep", fake_sleep)
    monkeypatch.setattr(gametext, "gsm_status", SimpleNamespace(websockets_connected=[]))
    gametext.websocket_connected.clear()

    asyncio.run(gametext.listen_on_websocket("localhost:6677", stop_event=stop_event))

    assert attempted_urls == []
    assert sleep_calls == [5]


def test_listen_on_websocket_accepts_list_backed_status_tracking(monkeypatch):
    stop_event = asyncio.Event()
    attempted_urls = []
    status = SimpleNamespace(websockets_connected=[])

    class SuccessfulConnect:
        def __init__(self, url, ping_interval=None):
            attempted_urls.append(url)

        async def __aenter__(self):
            stop_event.set()
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        def __aiter__(self):
            async def generator():
                if False:
                    yield None

            return generator()

    monkeypatch.setattr(gametext, "get_config", lambda: _make_config(use_websocket=True))
    monkeypatch.setattr(
        gametext.websockets,
        "connect",
        lambda url, ping_interval=None: SuccessfulConnect(url, ping_interval),
    )
    monkeypatch.setattr(gametext, "gsm_status", status)
    gametext.websocket_connected.clear()

    asyncio.run(gametext.listen_on_websocket("localhost:6677", stop_event=stop_event))

    assert attempted_urls == ["ws://localhost:6677"]
    assert status.websockets_connected == ["ws://localhost:6677"]


def test_listen_on_websocket_accepts_dict_backed_status_tracking(monkeypatch):
    stop_event = asyncio.Event()
    attempted_urls = []
    status = SimpleNamespace(websockets_connected={})

    class SuccessfulConnect:
        def __init__(self, url, ping_interval=None):
            attempted_urls.append(url)

        async def __aenter__(self):
            stop_event.set()
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        def __aiter__(self):
            async def generator():
                if False:
                    yield None

            return generator()

    monkeypatch.setattr(gametext, "get_config", lambda: _make_config(use_websocket=True))
    monkeypatch.setattr(
        gametext.websockets,
        "connect",
        lambda url, ping_interval=None: SuccessfulConnect(url, ping_interval),
    )
    monkeypatch.setattr(gametext, "gsm_status", status)
    gametext.websocket_connected.clear()

    asyncio.run(gametext.listen_on_websocket("localhost:6677", stop_event=stop_event))

    assert attempted_urls == ["ws://localhost:6677"]
    assert status.websockets_connected == {
        "ws://localhost:6677": gametext.resolve_websocket_source_name("localhost:6677")
    }


def test_add_line_to_text_log_uses_display_source_name_for_logging(monkeypatch):
    logged_messages = []

    class DummyLogger:
        def opt(self, **_kwargs):
            return self

        def info(self, message):
            logged_messages.append(message)

    monkeypatch.setattr(gametext, "logger", DummyLogger())
    monkeypatch.setattr(
        gametext,
        "get_config",
        lambda: SimpleNamespace(
            text_processing=SimpleNamespace(),
            advanced=SimpleNamespace(dont_collect_stats=False),
        ),
    )
    monkeypatch.setattr(gametext, "apply_text_processing", lambda line, _config: line)
    monkeypatch.setattr(gametext, "live_stats_tracker", SimpleNamespace(add_line=lambda *_args, **_kwargs: None))
    monkeypatch.setattr(gametext, "gsm_status", SimpleNamespace(last_line_received=""))

    asyncio.run(
        gametext.add_line_to_text_log(
            "test line",
            source="secondary",
            source_display_name="Clipboard",
        )
    )

    assert logged_messages == ["<cyan>Line Received from [Clipboard]: test line</cyan>"]


def test_resolve_websocket_source_name_prefers_configured_name(monkeypatch):
    monkeypatch.setattr(
        gametext,
        "get_config",
        lambda: SimpleNamespace(
            general=SimpleNamespace(
                websocket_sources=[SimpleNamespace(uri="localhost:6677", name="Agent", enabled=True)],
            ),
            advanced=SimpleNamespace(),
        ),
    )

    assert gametext.resolve_websocket_source_name("localhost:6677") == "Agent"


def test_handle_new_text_event_is_noop_when_text_intake_paused_and_relay_disabled(monkeypatch):
    add_line_calls = []
    discord_calls = []
    obs_calls = []

    async def fake_add_line_to_text_log(*args, **kwargs):
        add_line_calls.append((args, kwargs))

    monkeypatch.setattr(
        gametext,
        "get_config",
        lambda: SimpleNamespace(
            general=SimpleNamespace(merge_matching_sequential_text=False),
            hotkeys=SimpleNamespace(relay_outputs_when_text_intake_paused=False),
        ),
    )
    monkeypatch.setattr(gametext.obs, "update_current_game", lambda: obs_calls.append(True))
    monkeypatch.setattr(
        gametext.discord_rpc_manager,
        "update",
        lambda *_args, **_kwargs: discord_calls.append(True),
    )
    monkeypatch.setattr(gametext, "add_line_to_text_log", fake_add_line_to_text_log)
    monkeypatch.setattr(gametext.gsm_state, "text_input_paused", True, raising=False)
    monkeypatch.setattr(gametext, "current_line", "")

    asyncio.run(gametext.handle_new_text_event("ignored line"))

    assert gametext.current_line == "ignored line"
    assert obs_calls == []
    assert discord_calls == []
    assert add_line_calls == []


def test_handle_new_text_event_forwards_every_observation_to_authoritative_runtime(monkeypatch):
    """The adapter must not maintain a second first-arrival dedupe cache."""
    handled_lines = []

    async def fake_add_line_to_text_log(line, *_args, **_kwargs):
        handled_lines.append(line)

    monkeypatch.setattr(
        gametext,
        "get_config",
        lambda: SimpleNamespace(
            general=SimpleNamespace(merge_matching_sequential_text=False),
            hotkeys=SimpleNamespace(relay_outputs_when_text_intake_paused=True),
        ),
    )
    monkeypatch.setattr(gametext.obs, "update_current_game", lambda: None)
    monkeypatch.setattr(gametext.obs, "get_current_game", lambda *_a, **_k: "")
    monkeypatch.setattr(gametext.discord_rpc_manager, "update", lambda *_a, **_k: None)
    monkeypatch.setattr(gametext, "add_line_to_text_log", fake_add_line_to_text_log)
    monkeypatch.setattr(gametext.gsm_state, "text_input_paused", False, raising=False)
    asyncio.run(gametext.handle_new_text_event("同じ", source_display_name="Clipboard"))
    asyncio.run(gametext.handle_new_text_event("同じ", source_display_name="GSM OCR"))
    asyncio.run(gametext.handle_new_text_event("違う", source_display_name="GSM OCR"))

    assert handled_lines == ["同じ", "同じ", "違う"]


def test_handle_new_text_event_does_not_run_background_integrations_before_admission(monkeypatch):
    """OBS/Discord adapters must never sit in front of latency-critical ingress."""
    handled_lines = []

    async def fake_add_line_to_text_log(line, *_args, **_kwargs):
        handled_lines.append(line)

    monkeypatch.setattr(
        gametext,
        "get_config",
        lambda: SimpleNamespace(
            general=SimpleNamespace(merge_matching_sequential_text=False),
            hotkeys=SimpleNamespace(relay_outputs_when_text_intake_paused=True),
        ),
    )
    monkeypatch.setattr(
        gametext.obs,
        "update_current_game",
        lambda: (_ for _ in ()).throw(AssertionError("OBS refresh ran before ingress")),
    )
    monkeypatch.setattr(
        gametext.discord_rpc_manager,
        "update",
        lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("Discord update ran before ingress")),
    )
    monkeypatch.setattr(gametext, "add_line_to_text_log", fake_add_line_to_text_log)
    monkeypatch.setattr(gametext.gsm_state, "text_input_paused", False, raising=False)

    asyncio.run(gametext.handle_new_text_event("latency critical"))

    assert handled_lines == ["latency critical"]


def test_v2_ingress_does_not_run_background_integrations_before_admission(monkeypatch):
    integration_calls = []

    monkeypatch.setattr(gametext.obs, "update_current_game", lambda: integration_calls.append("obs"))
    monkeypatch.setattr(
        gametext.discord_rpc_manager,
        "update",
        lambda *_a, **_k: integration_calls.append("discord"),
    )
    monkeypatch.setattr(
        gametext,
        "_ingest_line_sync",
        lambda *_a, **_k: SimpleNamespace(to_dict=lambda: {"status": "accepted"}),
    )

    result = gametext.ingest_text_v2_payload({"text": "latency critical", "source": "texthook"})

    assert result == {"status": "accepted"}
    assert integration_calls == []


def test_text_input_guard_truncates_to_the_texthook_limit(monkeypatch):
    monkeypatch.setattr(
        gametext,
        "get_config",
        lambda: SimpleNamespace(general=SimpleNamespace(texthook_max_buffer_size=3)),
    )

    guarded = gametext.guard_text_input("abcdef")

    assert guarded == ("abc", "truncated")


def test_text_input_guard_blocks_excessive_japanese_quote_pairs(monkeypatch):
    monkeypatch.setattr(
        gametext,
        "get_config",
        lambda: SimpleNamespace(general=SimpleNamespace(texthook_max_buffer_size=3000)),
    )

    guarded = gametext.guard_text_input("「text」" * 11)

    assert guarded == (None, "too many Japanese quote pairs")


def test_repeated_ocr_hook_echoes_warn_once(monkeypatch):
    """Coordinator-classified auto-OCR hook echoes trigger one warning."""
    monkeypatch.setenv("GSM_ELECTRON", "1")

    sent = []
    monkeypatch.setattr(gametext, "send_message", lambda fn, data=None: sent.append((fn, data)))

    gametext._ocr_hook_redundancy_count = 0
    gametext._ocr_hook_redundancy_warned = False

    for _ in range(gametext._OCR_HOOK_REDUNDANCY_THRESHOLD + 2):
        gametext._note_authoritative_duplicate(gametext.SourceKind.OCR, gametext.SourceKind.TEXTHOOK.value)

    assert [fn for fn, _ in sent] == ["ocr_hook_redundant"]


def test_set_text_intake_paused_announces_state_and_notifies(monkeypatch):
    announced_states = []
    paused_notifications = []
    resumed_notifications = []

    monkeypatch.setattr(
        gametext,
        "get_config",
        lambda: SimpleNamespace(
            hotkeys=SimpleNamespace(relay_outputs_when_text_intake_paused=True),
        ),
    )
    monkeypatch.setattr(gametext, "announce_text_intake_state", lambda paused: announced_states.append(paused))
    monkeypatch.setattr(
        gametext,
        "send_text_intake_paused_notification",
        lambda relay_enabled: paused_notifications.append(relay_enabled),
    )
    monkeypatch.setattr(
        gametext,
        "send_text_intake_resumed_notification",
        lambda: resumed_notifications.append(True),
    )
    monkeypatch.setattr(gametext.gsm_state, "text_input_paused", False, raising=False)

    assert gametext.set_text_intake_paused(True) is True
    assert gametext.set_text_intake_paused(False) is False

    assert announced_states == [True, False]
    assert paused_notifications == [True]
    assert resumed_notifications == [True]


def test_add_line_to_text_log_relays_only_to_outputs_when_text_intake_paused(monkeypatch):
    observations = []

    class FakeRuntime:
        def ingest(self, observation):
            from GameSentenceMiner.text_pipeline.models import IngressAck, IngressResult, IngressStatus

            observations.append(observation)
            return IngressResult(IngressAck(IngressStatus.ACCEPTED, observation.observation_id))

        def wait_projected(self, timeout):
            return True

    class DummyLogger:
        def opt(self, **_kwargs):
            return self

        def info(self, _message):
            return None

    monkeypatch.setattr(
        gametext,
        "get_config",
        lambda: SimpleNamespace(
            text_processing=SimpleNamespace(),
            hotkeys=SimpleNamespace(relay_outputs_when_text_intake_paused=True),
            advanced=SimpleNamespace(dont_collect_stats=False),
        ),
    )
    monkeypatch.setattr(gametext, "apply_text_processing", lambda line, _config: f"processed:{line}")
    monkeypatch.setattr(gametext, "logger", DummyLogger())
    monkeypatch.setattr(gametext, "gsm_status", SimpleNamespace(last_line_received=""))
    monkeypatch.setattr(gametext, "get_authoritative_text_runtime", lambda: FakeRuntime())
    monkeypatch.setattr(gametext.gsm_state, "text_input_paused", True, raising=False)
    monkeypatch.setattr(gametext.gsm_state, "current_game", "Paused Game", raising=False)

    asyncio.run(gametext.add_line_to_text_log("raw line", source="secondary"))

    assert len(observations) == 1
    assert observations[0].processed_text == "processed:raw line"
    assert observations[0].relay_only is True
    assert observations[0].excluded_from_stats is True


def test_add_line_to_text_log_enqueues_immediately_without_running_subscribers_inline(monkeypatch):
    observations = []

    class FakeRuntime:
        def ingest(self, observation):
            from GameSentenceMiner.text_pipeline.models import IngressAck, IngressResult, IngressStatus

            observations.append(observation)
            return IngressResult(IngressAck(IngressStatus.ACCEPTED, observation.observation_id))

        def wait_projected(self, timeout):
            return True

    class DummyLogger:
        def opt(self, **_kwargs):
            return self

        def info(self, _message):
            return None

    monkeypatch.setattr(
        gametext,
        "get_config",
        lambda: SimpleNamespace(
            text_processing=SimpleNamespace(),
            overlay=SimpleNamespace(check_previous_lines_for_recycled_indicator=True),
            advanced=SimpleNamespace(dont_collect_stats=False),
        ),
    )
    monkeypatch.setattr(gametext, "apply_text_processing", lambda line, _config: line)
    monkeypatch.setattr(gametext, "logger", DummyLogger())
    monkeypatch.setattr(gametext, "gsm_status", SimpleNamespace(last_line_received=""))
    monkeypatch.setattr(gametext.gsm_state, "text_input_paused", False, raising=False)
    monkeypatch.setattr(gametext, "get_authoritative_text_runtime", lambda: FakeRuntime())

    asyncio.run(gametext.add_line_to_text_log("Hello, World!", source="secondary"))

    assert len(observations) == 1
    assert observations[0].raw_text == "Hello, World!"
    assert observations[0].revision_window_ms == 100
