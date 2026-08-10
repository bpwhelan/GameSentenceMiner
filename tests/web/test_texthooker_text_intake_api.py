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
