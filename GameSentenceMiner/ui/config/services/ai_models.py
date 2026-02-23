from __future__ import annotations

from PyQt6.QtCore import QObject, pyqtSignal

from GameSentenceMiner.util.config.configuration import get_config, logger, normalize_gemini_model_name
from GameSentenceMiner.util.database.db import AIModelsTable

RECOMMENDED_GROQ_MODELS = [
    "meta-llama/llama-4-maverick-17b-128e-instruct",
    "meta-llama/llama-4-scout-17b-16e-instruct",
    "llama-3.1-8b-instant",
    "qwen/qwen3-32b",
    "openai/gpt-oss-120b",
]
RECOMMENDED_GEMINI_MODELS = [
    "gemini-3-flash-preview",
    "gemini-3-pro-preview",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemma-3-27b-it",
]

EXCLUDED_GEMINI_MODEL_TOKENS = (
    "image",
    "tts",
    "computer-use",
    "robotics",
    "deep-research",
    "nano-banana",
)


def _is_supported_gemini_model_name(name: str) -> bool:
    lowered = (name or "").lower()
    if not lowered:
        return False
    if not (lowered.startswith("gemini") or lowered.startswith("gemma")):
        return False
    if lowered.startswith("gemini-exp"):
        return False
    if lowered.endswith("-001"):
        return False
    if any(token in lowered for token in EXCLUDED_GEMINI_MODEL_TOKENS):
        return False
    return True


class AIModelFetcher(QObject):
    """Worker object to fetch AI models in a background thread."""

    models_fetched = pyqtSignal(list, list, list, list)

    def __init__(self, groq_api_key: str):
        super().__init__()
        self.groq_api_key = groq_api_key

    def fetch(self) -> None:
        """Fetch models and emit a signal when done."""
        groq_models = self._get_groq_models()
        gemini_models = self._get_gemini_models()
        ollama_models = self._get_ollama_models()
        lm_studio_models = self._get_lm_studio_models()

        try:
            AIModelsTable.update_models(gemini_models, groq_models, ollama_models, lm_studio_models)
        except Exception as exc:
            logger.error(f"Failed to update AI Models table: {exc}")

        self.models_fetched.emit(gemini_models, groq_models, ollama_models, lm_studio_models)

    def _get_lm_studio_models(self) -> list[str]:
        models: list[str] = []
        try:
            import openai

            client = openai.OpenAI(
                base_url=get_config().ai.lm_studio_url,
                api_key=get_config().ai.lm_studio_api_key,
            )
            model_list = client.models.list()
            models = [model.id for model in model_list.data]
        except Exception as exc:
            logger.debug(f"Error fetching LM Studio models: {exc}")
        return models if models else []

    def _get_ollama_models(self) -> list[str]:
        models: list[str] = []
        try:
            import ollama

            client = ollama.Client(host=get_config().ai.ollama_url)
            ollama_list = client.list()
            models = [model.model for model in ollama_list.models]
        except Exception as exc:
            logger.debug(f"Error fetching Ollama models: {exc}", exc_info=True)
        return models if models else []

    def _get_groq_models(self) -> list[str]:
        models = ["RECOMMENDED"] + RECOMMENDED_GROQ_MODELS + ["OTHER"]
        try:
            from groq import Groq

            if not self.groq_api_key:
                return models
            client = Groq(api_key=self.groq_api_key)
            for model in client.models.list().data:
                if model.active and model.id not in models and not any(
                    token in model.id for token in ["guard", "tts", "whisper"]
                ):
                    models.append(model.id)
        except Exception as exc:
            logger.debug(f"Error fetching Groq models: {exc}")
        return models

    def _get_gemini_models(self) -> list[str]:
        models = ["RECOMMENDED"] + RECOMMENDED_GEMINI_MODELS + ["OTHER"]
        try:
            from google import genai

            api_key = get_config().ai.gemini_api_key
            if not api_key:
                return models
            client = genai.Client(api_key=api_key)
            for model in client.models.list():
                name = normalize_gemini_model_name(model.name.replace("models/", ""))
                supported_actions = list(getattr(model, "supported_actions", []) or [])
                if "generateContent" not in supported_actions:
                    continue
                if not _is_supported_gemini_model_name(name):
                    continue
                if name not in models:
                    models.append(name)
        except Exception as exc:
            logger.debug(f"Error fetching Gemini models: {exc}")
        return models
