import asyncio
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from GameSentenceMiner.util.config.configuration import Ai, General
from GameSentenceMiner.web import overlay_handler, texthooking_page


@pytest.mark.parametrize(
    "path,payload",
    [
        ("/translate-line", {"id": "1"}),
        ("/translate-multiple", {"ids": ["1"]}),
        ("/analyze-line", {"id": "1", "mode": "grammar"}),
    ],
)
def test_textfeed_manual_requests_open_setup(monkeypatch, path, payload):
    monkeypatch.setattr(texthooking_page, "get_config", lambda: SimpleNamespace(ai=Ai(), general=General()))
    setup = Mock(return_value={"code": "ai_setup_required", "error": "Open AI settings", "settings_opened": True})
    monkeypatch.setattr(texthooking_page, "ai_setup_required", setup)
    response = texthooking_page.app.test_client().post(path, json=payload)
    assert response.status_code == 400
    assert response.json["settings_opened"]
    setup.assert_called_once_with(automatic=False)


def test_textfeed_analysis_does_not_write_translation(monkeypatch):
    line = SimpleNamespace(text="例", translation="Original", set_TL=Mock())
    monkeypatch.setattr(texthooking_page, "get_event_line_by_id", lambda _id: line)
    monkeypatch.setattr(
        texthooking_page, "get_config", lambda: SimpleNamespace(ai=Ai(gemini_api_key="key"), general=General())
    )
    monkeypatch.setattr(texthooking_page, "get_all_lines", lambda: [line])
    monkeypatch.setattr(texthooking_page, "get_current_game", lambda: "Game")
    analyze = Mock(return_value="Explanation")
    monkeypatch.setattr(texthooking_page, "get_sentence_analysis", analyze)
    response = texthooking_page.app.test_client().post("/analyze-line", json={"id": "1", "mode": "grammar"})
    assert response.status_code == 200
    assert response.json["analysis"] == "Explanation"
    line.set_TL.assert_not_called()
    assert line.translation == "Original"


def test_overlay_unconfigured_request_opens_settings_and_keeps_request_id(monkeypatch):
    monkeypatch.setattr(overlay_handler, "get_config", lambda: SimpleNamespace(ai=Ai()))
    setup = Mock(return_value={"code": "ai_setup_required", "error": "Setup opened", "settings_opened": True})
    monkeypatch.setattr(overlay_handler, "ai_setup_required", setup)
    sent = []

    async def send(_id, message):
        sent.append(message)

    monkeypatch.setattr(overlay_handler.websocket_manager, "send", send)
    handler = overlay_handler.OverlayRequestHandler()
    asyncio.run(handler.handle_translation_request({"request_id": "frame"}))
    assert sent[0]["request_id"] == "frame"
    assert sent[0]["code"] == "ai_setup_required"
    assert not handler.processing


def test_textfeed_auto_translation_does_not_request_focus(monkeypatch):
    monkeypatch.setattr(texthooking_page, "get_config", lambda: SimpleNamespace(ai=Ai(), general=General()))
    setup = Mock(return_value={"code": "ai_setup_required", "error": "Configure AI", "settings_opened": False})
    monkeypatch.setattr(texthooking_page, "ai_setup_required", setup)
    response = texthooking_page.app.test_client().post("/translate-line", json={"id": "1", "automatic": True})
    assert response.status_code == 400
    setup.assert_called_once_with(automatic=True)


def test_overlay_study_uses_renderer_blocks_and_returns_separate_output(monkeypatch):
    monkeypatch.setattr(overlay_handler, "get_config", lambda: SimpleNamespace(ai=Ai(gemini_api_key="key")))
    monkeypatch.setattr(overlay_handler, "get_all_lines", list)
    monkeypatch.setattr(overlay_handler, "get_current_game", lambda **kwargs: "Game")
    analysis = Mock(return_value="Explanation")
    monkeypatch.setattr(overlay_handler, "get_sentence_analysis", analysis)
    sent = []

    async def send(_id, message):
        sent.append(message)

    monkeypatch.setattr(overlay_handler.websocket_manager, "send", send)
    handler = overlay_handler.OverlayRequestHandler()
    asyncio.run(
        handler.handle_translation_request(
            {"request_id": "study", "mode": "grammar", "blocks": [{"id": "0", "text": "例文"}]}
        )
    )
    assert sent == [
        {"type": "translation-result", "data": {"request_id": "study", "text": "Explanation", "mode": "grammar"}}
    ]
    analysis.assert_called_once_with([], "例文", None, "Game", "grammar")
