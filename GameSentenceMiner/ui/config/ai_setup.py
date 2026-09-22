"""Guided provider setup and a connection check using the current form values."""

import threading
from dataclasses import replace
from html import escape

from PyQt6.QtCore import Qt, pyqtSignal
from PyQt6.QtWidgets import QGroupBox, QLabel, QPushButton, QVBoxLayout

from GameSentenceMiner.ai.setup import AI_SETUP_DOCS_URL, ai_error_message
from GameSentenceMiner.util.config.configuration import (
    AI_DEEPL,
    AI_GEMINI,
    AI_GROQ,
    AI_LM_STUDIO,
    AI_OLLAMA,
    AI_OPENAI,
    AI_ZAI,
    OFF,
    Ai,
    logger,
)

PROVIDER_GUIDES = {
    AI_ZAI: (
        "https://z.ai/manage-apikey/apikey-list",
        "https://docs.z.ai/guides/overview/pricing",
        (
            "Sign in or create a Z.ai account, open API Keys, and create a key. Copy it into the Z.ai API Key field below. "
            "The pricing table lists Flash models as free, but requests may be slow or unavailable. FlashX and other models may be paid. "
            "This uses the standard API; a Coding Plan subscription is not required for Flash."
        ),
    ),
    AI_GEMINI: (
        "https://aistudio.google.com/apikey",
        "https://ai.google.dev/gemini-api/docs/pricing",
        (
            "Sign in to Google AI Studio, accept the terms, and create an API key in a project. "
            "Copy the key into the Gemini API Key field below. If no project appears, create or import one in AI Studio. "
            "Free-tier availability and quotas depend on your model, project, and region; check pricing before enabling billing."
        ),
    ),
    AI_GROQ: (
        "https://console.groq.com/keys",
        "https://console.groq.com/docs/rate-limits",
        (
            "Sign in or create a GroqCloud account. Open API Keys, choose Create API Key, name it, and copy the key "
            "into the Groq API Key field below. Select an available text model. Free accounts have request and token limits."
        ),
    ),
    AI_OPENAI: (
        "https://platform.openai.com/api-keys",
        "https://platform.openai.com/docs/pricing",
        (
            "Create an API key with your chosen provider and enter its base URL and model ID below. "
            "For OpenAI, use https://api.openai.com/v1. Other compatible services issue their own keys and URLs. "
            "API billing is separate from chat subscriptions."
        ),
    ),
    AI_OLLAMA: (
        "https://ollama.com/download",
        "https://ollama.com/library",
        (
            "Install Ollama, download a text model, and start its local server. Enter that model's name below. "
            "No cloud account or API key is needed for local models."
        ),
    ),
    AI_LM_STUDIO: (
        "https://lmstudio.ai/",
        "https://lmstudio.ai/docs/developer/core/server",
        (
            "Install LM Studio, download and load a text model, then start the server in its Developer tab. "
            "Enter the server URL and loaded model ID below. Use the server's API key if authentication is enabled."
        ),
    ),
    AI_DEEPL: (
        "https://www.deepl.com/pro-api",
        "https://developers.deepl.com/docs/getting-started/intro",
        (
            "Create a DeepL API account and copy its authentication key into the field below. "
            "A DeepL translator subscription alone does not provide API access. "
            "DeepL translates text; choose another provider for sentence breakdowns and grammar explanations."
        ),
    ),
}


def ai_config_from_form(window) -> Ai:
    values = {"provider": window.ai_provider_combo.currentText()}
    for field, widget in {
        "gemini_api_key": "gemini_api_key_edit",
        "gemini_model": "gemini_model_combo",
        "groq_api_key": "groq_api_key_edit",
        "groq_model": "groq_model_combo",
        "zai_api_key": "zai_api_key_edit",
        "zai_model": "zai_model_combo",
        "open_ai_api_key": "open_ai_api_key_edit",
        "open_ai_model": "open_ai_model_edit",
        "open_ai_url": "open_ai_url_edit",
        "ollama_model": "ollama_model_combo",
        "ollama_url": "ollama_url_edit",
        "lm_studio_model": "lm_studio_model_combo",
        "lm_studio_url": "lm_studio_url_edit",
        "lm_studio_api_key": "lm_studio_api_key_edit",
        "deepl_api_key": "deepl_api_key_edit",
        "deepl_target_lang": "deepl_target_lang_edit",
        "gsm_cloud_access_token": "gsm_cloud_access_token_edit",
        "gsm_cloud_api_url": "gsm_cloud_api_url_edit",
    }.items():
        control = getattr(window, widget)
        value = control.currentText() if hasattr(control, "currentText") else control.text()
        values[field] = value.strip() if value != OFF else ""
    values["gsm_cloud_models"] = window._get_selected_gsm_cloud_models()
    return Ai(**values)


class AISetupGuide(QGroupBox):
    finished = pyqtSignal(object, bool, str)

    def __init__(self, window):
        super().__init__("Set up translation and sentence help", window)
        self.window = window
        self._busy = False
        self._tested_config = None
        layout = QVBoxLayout(self)
        self.instructions = QLabel()
        self.instructions.setWordWrap(True)
        self.instructions.setOpenExternalLinks(True)
        layout.addWidget(self.instructions)
        self.test_button = QPushButton("3. Test connection", window)
        self.test_button.setToolTip(
            "Send one short test request with the current key and model. Provider usage limits and pricing apply."
        )
        self.test_button.clicked.connect(self.test_connection)
        self.status = QLabel(window)
        self.status.setWordWrap(True)
        self.status.setTextFormat(Qt.TextFormat.PlainText)
        self.finished.connect(self.show_result)
        for name in (
            "ai_provider_combo",
            "gemini_api_key_edit",
            "gemini_model_combo",
            "groq_api_key_edit",
            "groq_model_combo",
            "zai_api_key_edit",
            "zai_model_combo",
            "open_ai_api_key_edit",
            "open_ai_url_edit",
            "open_ai_model_edit",
            "ollama_url_edit",
            "ollama_model_combo",
            "lm_studio_url_edit",
            "lm_studio_model_combo",
            "lm_studio_api_key_edit",
            "deepl_api_key_edit",
            "deepl_target_lang_edit",
            "gsm_cloud_access_token_edit",
            "gsm_cloud_api_url_edit",
        ):
            control = getattr(window, name)
            signal = control.currentTextChanged if hasattr(control, "currentTextChanged") else control.textChanged
            signal.connect(self.refresh)
        self.refresh()

    def refresh(self):
        provider = self.window.ai_provider_combo.currentText()
        account, docs, description = PROVIDER_GUIDES.get(
            provider,
            (AI_SETUP_DOCS_URL, AI_SETUP_DOCS_URL, "Authenticate in the GSM Cloud tab, then select a model below."),
        )
        self.instructions.setText(
            "<b>1. Choose a provider above.</b> Gemini and Groq offer free tiers.<br>"
            f"<b>2. Connect {escape(provider or 'your provider')}.</b> {escape(description)}<br>"
            f'<a href="{account}">Open account / API key page</a> · <a href="{docs}">Pricing, limits and help</a><br>'
            "Paste your key below, then test the connection. Settings save automatically.<br>"
            "After a successful test, retry Translate or Explain in the overlay or text feed. "
            "Adding AI output to Anki is optional. Explanations use your native language from General settings."
        )
        config = ai_config_from_form(self.window)
        self.test_button.setEnabled(not self._busy and config.is_configured())
        if self._busy:
            return
        if self._tested_config == config:
            return
        self.status.setText(
            "Ready to test this key and model."
            if config.is_configured()
            else "Paste an API key and select a model to continue. Local providers need a running server and model."
        )

    def test_connection(self):
        if self._busy:
            return
        from GameSentenceMiner.ai.service import snapshot_config

        config = ai_config_from_form(self.window)
        if not config.is_configured():
            self.refresh()
            return
        snapshot = snapshot_config(config, self.window.settings.general)
        self._busy = True
        self.test_button.setEnabled(False)
        self.status.setText("Testing the current key and model…")

        def run():
            from GameSentenceMiner.ai.service import AIService

            try:
                service = AIService(snapshot, logger)
                prompt = "Hello" if config.provider == AI_DEEPL else "Reply with only OK."
                response = service._execute_request(
                    replace(service._make_request(prompt, "connection_test"), max_tokens=64)
                )
                if not response.text or response.text.startswith("Processing failed:"):
                    raise ValueError(response.text)
                features = "translate" if config.provider == AI_DEEPL else "translate and use sentence help"
                success, message = True, f"Connected to {config.provider} / {response.model}. You can now {features}."
            except Exception as exc:  # noqa: BLE001 - SDK error types vary; never expose their payloads in the UI.
                success, message = False, ai_error_message(exc)
            self.finished.emit(config, success, message)

        threading.Thread(target=run, name="ai-connection-test", daemon=True).start()

    def show_result(self, config, success, message):
        self._busy = False
        if ai_config_from_form(self.window) != config:
            self._tested_config = None
            self.refresh()
            return
        self._tested_config = config if success else None
        self.test_button.setEnabled(True)
        self.status.setText(message)
