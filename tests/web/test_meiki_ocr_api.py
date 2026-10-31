from flask import Flask

from GameSentenceMiner.web import meiki_ocr_api


def test_overlay_endpoint_uses_shared_selector(monkeypatch):
    requests = []
    monkeypatch.setattr(
        meiki_ocr_api, "handle_model_request", lambda message: requests.append(message) or {"model": "large"}
    )
    app = Flask(__name__)
    app.register_blueprint(meiki_ocr_api.meiki_ocr_api)
    client = app.test_client()
    assert client.get("/api/ocr/meiki-model").json == {"model": "large"}
    assert client.post("/api/ocr/meiki-model", json={"model": "large"}).status_code == 200
    assert requests == [{"data": {}}, {"data": {"model": "large"}}]
    assert client.post("/api/ocr/meiki-model", data="model=large").status_code == 415
    assert (
        client.post(
            "/api/ocr/meiki-model", json={"model": "small"}, headers={"Origin": "https://example.com"}
        ).status_code
        == 403
    )
    assert client.get("/api/ocr/meiki-model", environ_overrides={"REMOTE_ADDR": "192.0.2.1"}).status_code == 403
    assert len(requests) == 2
