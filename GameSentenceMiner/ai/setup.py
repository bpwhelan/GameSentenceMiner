"""Shared, credential-free setup guidance for the desktop and request surfaces."""

import threading
import time

from GameSentenceMiner.util.config.configuration import gsm_state, logger
from GameSentenceMiner.util.docs import DOCS_URLS

AI_SETUP_DOCS_URL = DOCS_URLS["ai_features"]
_open_lock = threading.Lock()
_last_opened = float("-inf")


def open_ai_settings() -> bool:
    global _last_opened
    with _open_lock:
        now = time.monotonic()
        if now - _last_opened < 5:
            return True
        try:
            window = getattr(gsm_state, "config_app", None)
            if window is None:
                factory = getattr(gsm_state, "config_app_factory", None)
                window = factory() if callable(factory) else None
            if window is None:
                return False
            # ConfigWindow.show_window dispatches through its Qt signal.
            window.show_window(root_tab_key="ai", subtab_key="general")
            _last_opened = now
            return True
        except Exception:  # noqa: BLE001 - Settings may be unavailable in a headless or shutting-down runtime.
            logger.debug("Unable to open AI settings", exc_info=True)
            return False


def ai_setup_required(*, automatic: bool = False) -> dict:
    opened = False if automatic else open_ai_settings()
    return {
        "code": "ai_setup_required",
        "error": (
            ("AI setup is open. " if opened else "Open Config → AI / Translation. ")
            + "Choose a provider, follow the account and API key steps, then test the connection and retry. "
            + "You do not need to enable adding AI output to Anki to translate or explain sentences."
        ),
        "settings_opened": opened,
        "href": AI_SETUP_DOCS_URL,
    }


def ai_error_message(error) -> str:
    """Actionable UI errors without forwarding SDK payloads or credentials."""
    detail = str(error).lower()
    if any(token in detail for token in ("401", "403", "api key", "api_key", "unauthorized", "permission_denied")):
        return (
            "The provider rejected access. Create or check your API key and model access in AI / Translation settings."
        )
    if any(token in detail for token in ("429", "quota", "rate limit", "resource_exhausted")):
        return (
            "The provider's rate limit or quota was reached. Wait and retry, or check your account's usage and limits."
        )
    if any(token in detail for token in ("404", "not found", "not_found")):
        return "The selected model is unavailable. Choose a supported model in AI / Translation settings."
    if "deepl supports translation only" in detail:
        return "DeepL supports translation only. Choose Gemini, Groq, or another AI provider for explanations."
    if "cut off" in detail:
        return "The answer was cut off. Increase Max Output Tokens in AI / Translation settings."
    return (
        "The AI request failed. Check your connection, API key, model, and account limits in AI / Translation settings."
    )
