import asyncio
import uuid
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from GameSentenceMiner.util.config.configuration import Ai, General
from GameSentenceMiner.web import overlay_handler, texthooking_page


@pytest.fixture
def translation_api(monkeypatch):
    from GameSentenceMiner.ai import ai_prompting
    from GameSentenceMiner.ai.contracts import AIResponse
    from GameSentenceMiner.ai.features.character_context import CharacterContextProvider
    from GameSentenceMiner.ai.service import AIService
    from GameSentenceMiner.util.text_log import GameLine

    line = GameLine(id=str(uuid.uuid4()), text="例文", time=datetime.now(UTC), prev=None, next=None)
    lines = {line.id: line}
    config = SimpleNamespace(ai=Ai(gemini_api_key="key", gemini_backup_model=""), general=General())
    monkeypatch.setattr(texthooking_page, "get_config", lambda: config)
    monkeypatch.setattr(ai_prompting, "get_config", lambda: config)
    monkeypatch.setattr(texthooking_page, "get_event_line_by_id", lines.get)
    monkeypatch.setattr(texthooking_page, "get_all_lines", lambda: list(lines.values()))
    monkeypatch.setattr(texthooking_page, "get_current_game", lambda: "Game")
    monkeypatch.setattr(AIService, "_ensure_connectivity", lambda self: True)
    monkeypatch.setattr(CharacterContextProvider, "get_character_context", lambda *args, **kwargs: "")
    execute = Mock(return_value=AIResponse("Gemini", "model", "Translation", "Translation", 1))
    monkeypatch.setattr(AIService, "_execute_request", execute)
    return texthooking_page.app.test_client(), lines, line, execute


def test_textfeed_auto_and_manual_translation_share_a_result(translation_api):
    api, _, line, execute = translation_api
    for automatic in (True, True, False):
        response = api.post("/translate-line", json={"id": line.id, "automatic": automatic})
        assert response.status_code == 200
        assert response.json == {"TL": "Translation"}
    execute.assert_called_once()
    assert line.translation == line.TL == "Translation"


def test_textfeed_explicit_refresh_replaces_the_cached_result(translation_api):
    api, _, line, execute = translation_api
    api.post("/translate-line", json={"id": line.id})
    assert api.post("/translate-line", json={"id": line.id, "force_refresh": True}).status_code == 200
    assert api.post("/translate-line", json={"id": line.id}).status_code == 200
    assert execute.call_count == 2


def test_textfeed_text_override_cannot_replace_the_original_lines_translation(translation_api):
    from GameSentenceMiner.ai.contracts import AIResponse

    api, _, line, execute = translation_api
    api.post("/translate-line", json={"id": line.id})
    execute.return_value = AIResponse("Gemini", "model", "Edited translation", "Edited translation", 1)
    response = api.post("/translate-line", json={"id": line.id, "text": "Edited source"})
    assert response.json == {"TL": "Edited translation"}
    assert line.translation == line.TL == "Translation"
    assert api.post("/translate-line", json={"id": line.id}).json == {"TL": "Translation"}
    assert execute.call_count == 2


def test_textfeed_batch_does_not_poison_the_first_lines_cached_translation(translation_api):
    from dataclasses import replace

    from GameSentenceMiner.ai.contracts import AIResponse

    api, lines, line, execute = translation_api
    other = replace(line, id=str(uuid.uuid4()), text="次の台詞。")
    lines[other.id] = other
    api.post("/translate-line", json={"id": line.id})
    execute.return_value = AIResponse("Gemini", "model", "Combined translation", "Combined translation", 1)
    assert api.post("/translate-multiple", json={"ids": [line.id, other.id]}).status_code == 200
    assert line.translation == line.TL == "Translation"
    assert api.post("/translate-line", json={"id": line.id}).json == {"TL": "Translation"}
    assert execute.call_count == 2


def test_overlay_reuses_the_textfeeds_translation_for_the_same_game_line(translation_api, monkeypatch):
    api, _, line, execute = translation_api
    assert api.post("/translate-line", json={"id": line.id}).status_code == 200
    monkeypatch.setattr(overlay_handler, "get_config", texthooking_page.get_config)
    monkeypatch.setattr(overlay_handler, "get_all_lines", lambda: [line])
    monkeypatch.setattr(overlay_handler, "get_current_game", lambda **kwargs: "Game")
    monkeypatch.setattr(
        overlay_handler,
        "get_overlay_processor",
        lambda: SimpleNamespace(last_oneocr_result=line.text, last_lens_result=""),
    )
    sent = []

    async def send(_id, message):
        sent.append(message)

    monkeypatch.setattr(overlay_handler.websocket_manager, "send", send)
    asyncio.run(overlay_handler.OverlayRequestHandler().handle_translation_request({"request_id": "reuse"}))
    assert sent[-1]["data"] == {"request_id": "reuse", "text": "Translation"}
    execute.assert_called_once()


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
    analysis.assert_called_once_with([], "例文", None, "Game", "grammar", "")
