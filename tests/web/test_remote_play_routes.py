from types import SimpleNamespace

import flask
import pytest

from GameSentenceMiner.web import remote_play_routes


@pytest.fixture()
def client(monkeypatch):
    test_app = flask.Flask(
        __name__,
        template_folder="../../GameSentenceMiner/web/templates",
        static_folder="../../GameSentenceMiner/web/static",
    )
    test_app.config["TESTING"] = True
    remote_play_routes.register_remote_play_routes(test_app)
    return test_app.test_client()


def test_remote_play_page_loads_without_embedding_a_token(client):
    response = client.get("/remote-play")

    assert response.status_code == 200
    assert b'id="remoteVideo"' in response.data
    assert b"/static/js/remote-play.js" in response.data
    assert b"test-token" not in response.data
    assert response.headers["Cache-Control"] == "no-store"


def test_remote_play_browser_uses_stun_servers(client):
    response = client.get("/static/js/remote-play.js")

    assert response.status_code == 200
    assert b"stun:stun.cloudflare.com:3478" in response.data
    assert b"stun:stun.l.google.com:19302" in response.data


def test_pairing_controls_are_removed(client):
    page = client.get("/remote-play").data
    assert b"Copy session code" not in page
    assert b"tokenDialog" not in page
    assert b"Enter a session code" not in page


def test_phone_lookup_without_token_forwards_text(client, monkeypatch):
    upstream = SimpleNamespace(
        status_code=200, content=b'[{"content":"test"}]', headers={"Content-Type": "application/json"}
    )
    post_calls = []

    def fake_post(url, **kwargs):
        post_calls.append((url, kwargs))
        return upstream

    monkeypatch.setattr(remote_play_routes.requests, "post", fake_post)
    headers = {
        "Origin": "http://192.168.1.10:7275",
        "Host": "192.168.1.10:7275",
    }

    denied = client.post("/api/remote-play/lookup", json={"text": "猫"})
    response = client.post(
        "/api/remote-play/lookup",
        json={"text": "猫", "scan_length": 12},
        headers=headers,
        environ_base={"REMOTE_ADDR": "192.168.1.12"},
    )

    assert denied.status_code == 403
    assert response.status_code == 200
    assert response.get_json() == [{"content": "test"}]
    assert post_calls == [
        (
            "http://127.0.0.1:19633/tokenize",
            {"json": {"text": "猫", "scanLength": 12}, "timeout": 3},
        )
    ]
