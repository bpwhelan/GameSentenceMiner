import json
from types import SimpleNamespace

import pytest

from GameSentenceMiner import gametext
from GameSentenceMiner.util import sentence_exclusions
from GameSentenceMiner.util.communication import ocr_ipc


@pytest.fixture
def saved_exclusions(tmp_path, monkeypatch):
    path = tmp_path / "sentence_exclusions.json"
    path.write_text(json.dumps({"version": 1, "games": {"Game A": ["Menu\ntext"]}}), encoding="utf-8")
    monkeypatch.setattr(sentence_exclusions, "_exclusions", sentence_exclusions.SentenceExclusions(path))


def test_excluded_ocr_stays_visible_but_never_enters_backend_outbox(saved_exclusions, monkeypatch):
    events, submissions = [], []
    monkeypatch.setattr(ocr_ipc, "_stopping", False)
    monkeypatch.setattr(ocr_ipc, "_use_bus", lambda: True)
    monkeypatch.setattr(
        ocr_ipc.bus_client, "get_bus", lambda: SimpleNamespace(publish=lambda *args: events.append(args))
    )
    monkeypatch.setattr(
        ocr_ipc,
        "get_text_ingress_outbox",
        lambda: SimpleNamespace(submit=lambda value: submissions.append(value) or True),
    )
    ocr_ipc.announce_ocr_result("Menu\ntext", {"process_path": "Game A"})
    assert len(events) == 1
    assert events[0][0] == ocr_ipc.bus_client.MAIN
    assert events[0][2]["data"]["excluded"] is True
    assert events[0][2]["data"]["exclusion_game"] == "Game A"
    assert submissions == []

    ocr_ipc.announce_ocr_result("Menu\ntext", {"process_path": "Game B"})
    assert len(submissions) == 1
    assert submissions[0]["exclusion_game"] == "Game B"
    assert "excluded" not in events[1][2]["data"]


def test_legacy_ocr_exclusions_are_not_broadcast(saved_exclusions, monkeypatch):
    monkeypatch.setattr(ocr_ipc, "_stopping", False)
    monkeypatch.setattr(ocr_ipc, "_use_bus", lambda: False)
    monkeypatch.setattr(ocr_ipc, "send_event", lambda *_args: pytest.fail("Excluded result must not reach backend"))
    ocr_ipc.announce_ocr_result("Menu\ntext", {"process_path": "Game A"})


@pytest.mark.parametrize("source", ["ocr", "texthook", "clipboard", "websocket", "screen_cropper"])
def test_backend_rejects_exclusions_before_processing_or_projection(saved_exclusions, monkeypatch, source):
    monkeypatch.setattr(gametext.gsm_state, "current_game", "Game A")
    monkeypatch.setattr(
        gametext, "get_config", lambda: SimpleNamespace(general=SimpleNamespace(texthook_max_buffer_size=3000))
    )
    monkeypatch.setattr(
        gametext, "apply_text_processing", lambda *_args: pytest.fail("Excluded text must not be processed")
    )
    monkeypatch.setattr(
        gametext, "get_authoritative_text_runtime", lambda: pytest.fail("Excluded text must not reach runtime")
    )
    ack = gametext.ingest_text_v2_payload({"text": "Menu\ntext", "source": source, "observationId": "excluded"})
    assert ack["status"] == "rejected"
    assert ack["reason"] == "sentence excluded for this game"
