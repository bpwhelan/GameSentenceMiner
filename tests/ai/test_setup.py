from types import SimpleNamespace
from unittest.mock import Mock

from GameSentenceMiner.ai import setup


def test_manual_setup_opens_ai_tab_and_debounces(monkeypatch):
    window = Mock()
    monkeypatch.setattr(setup, "gsm_state", SimpleNamespace(config_app=window))
    monkeypatch.setattr(setup, "_last_opened", float("-inf"))
    monkeypatch.setattr(setup.time, "monotonic", lambda: 10)
    first = setup.ai_setup_required()
    second = setup.ai_setup_required()
    window.show_window.assert_called_once_with(root_tab_key="ai", subtab_key="general")
    assert first["code"] == "ai_setup_required"
    assert first["settings_opened"] and second["settings_opened"]


def test_automatic_requests_never_open_settings(monkeypatch):
    window = Mock()
    monkeypatch.setattr(setup, "gsm_state", SimpleNamespace(config_app=window))
    assert not setup.ai_setup_required(automatic=True)["settings_opened"]
    window.show_window.assert_not_called()


def test_headless_setup_still_returns_actionable_instructions(monkeypatch):
    monkeypatch.setattr(setup, "gsm_state", SimpleNamespace(config_app=None))
    monkeypatch.setattr(setup, "_last_opened", float("-inf"))
    result = setup.ai_setup_required()
    assert not result["settings_opened"]
    assert "AI / Translation" in result["error"]
    assert result["href"].startswith("https://docs.gamesentenceminer.com/")
