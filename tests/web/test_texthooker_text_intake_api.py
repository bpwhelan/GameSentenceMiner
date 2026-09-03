from types import SimpleNamespace

from GameSentenceMiner import gametext
from GameSentenceMiner.web import texthooking_page


def test_root_redirects_to_texthooker():
    response = texthooking_page.app.test_client().get("/")

    assert response.status_code == 302
    assert response.headers["Location"] == "/texthooker"


def test_get_ids_reports_current_text_intake_state(monkeypatch):
    def no_op_check():
        return None

    monkeypatch.setattr(texthooking_page, "check_for_lines_outside_replay_buffer", no_op_check)
    monkeypatch.setattr(gametext, "is_text_intake_paused", lambda: True)

    response = texthooking_page.app.test_client().get("/get_ids")

    assert response.status_code == 200
    assert response.get_json()["text_intake_paused"] is True
    assert response.get_json()["session_id"] == texthooking_page.event_manager.session_id


def test_get_ids_disables_caching(monkeypatch):
    def no_op_check():
        return None

    monkeypatch.setattr(texthooking_page, "check_for_lines_outside_replay_buffer", no_op_check)

    response = texthooking_page.app.test_client().get("/get_ids")

    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store, no-cache, must-revalidate, max-age=0"
    assert response.headers["Pragma"] == "no-cache"
    assert response.headers["Expires"] == "0"


def test_websocket_port_endpoint_prefers_an_enabled_direct_listener(monkeypatch):
    config = SimpleNamespace(
        general=SimpleNamespace(single_port=7275),
        advanced=SimpleNamespace(direct_websocket_port=8383),
    )
    monkeypatch.setattr(texthooking_page, "get_config", lambda: config)
    monkeypatch.setattr(texthooking_page.websocket_manager, "get_ingress_port", lambda: 8383)
    monkeypatch.setattr(texthooking_page, "_single_port_gateway_active", True)
    monkeypatch.setattr(texthooking_page, "_single_port_gateway_port", 7275)

    response = texthooking_page.app.test_client().get("/get_websocket_port")

    assert response.status_code == 200
    assert response.get_json() == {
        "port": 8383,
        "direct_port": 8383,
        "gateway_port": 7275,
        "gateway_active": True,
    }


def test_websocket_port_endpoint_keeps_gateway_as_default_but_reports_direct_fallback(monkeypatch):
    config = SimpleNamespace(
        general=SimpleNamespace(single_port=7275),
        advanced=SimpleNamespace(direct_websocket_port=0),
    )
    monkeypatch.setattr(texthooking_page, "get_config", lambda: config)
    monkeypatch.setattr(texthooking_page.websocket_manager, "get_ingress_port", lambda: 49152)
    monkeypatch.setattr(texthooking_page, "_single_port_gateway_active", True)
    monkeypatch.setattr(texthooking_page, "_single_port_gateway_port", 7275)

    response = texthooking_page.app.test_client().get("/get_websocket_port")

    assert response.status_code == 200
    assert response.get_json() == {
        "port": 7275,
        "direct_port": 49152,
        "gateway_port": 7275,
        "gateway_active": True,
    }


def test_set_text_intake_paused_requires_an_explicit_boolean(monkeypatch):
    calls = []
    monkeypatch.setattr(gametext, "set_text_intake_paused", lambda paused: calls.append(paused) or paused)
    client = texthooking_page.app.test_client()

    response = client.post("/set_text_intake_paused", json={"paused": True})

    assert response.status_code == 200
    assert response.get_json() == {"paused": True}
    assert calls == [True]


def test_set_text_intake_paused_rejects_implicit_or_missing_state(monkeypatch):
    calls = []
    monkeypatch.setattr(gametext, "set_text_intake_paused", lambda paused: calls.append(paused) or paused)
    client = texthooking_page.app.test_client()

    missing_response = client.post("/set_text_intake_paused", json={})
    string_response = client.post("/set_text_intake_paused", json={"paused": "true"})

    assert missing_response.status_code == 400
    assert string_response.status_code == 400
    assert calls == []


def test_set_stats_gathering_enabled_requires_an_explicit_boolean(monkeypatch):
    from GameSentenceMiner.util.config import configuration

    config = type("Config", (), {"advanced": type("Advanced", (), {"dont_collect_stats": False})()})()
    monkeypatch.setattr(configuration, "get_config", lambda: config)
    client = texthooking_page.app.test_client()

    disable_response = client.post("/set_stats_gathering_enabled", json={"enabled": False})

    assert disable_response.status_code == 200
    assert disable_response.get_json() == {"enabled": False}
    assert config.advanced.dont_collect_stats is True

    enable_response = client.post("/set_stats_gathering_enabled", json={"enabled": True})

    assert enable_response.status_code == 200
    assert enable_response.get_json() == {"enabled": True}
    assert config.advanced.dont_collect_stats is False


def test_set_stats_gathering_enabled_rejects_implicit_or_missing_state(monkeypatch):
    from GameSentenceMiner.util.config import configuration

    config = type("Config", (), {"advanced": type("Advanced", (), {"dont_collect_stats": False})()})()
    monkeypatch.setattr(configuration, "get_config", lambda: config)
    client = texthooking_page.app.test_client()

    missing_response = client.post("/set_stats_gathering_enabled", json={})
    string_response = client.post("/set_stats_gathering_enabled", json={"enabled": "false"})

    assert missing_response.status_code == 400
    assert string_response.status_code == 400
    assert config.advanced.dont_collect_stats is False
