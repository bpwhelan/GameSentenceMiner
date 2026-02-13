from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Dict, Optional
from urllib.parse import urlparse

from GameSentenceMiner.ai.providers.base import ProviderClient
from GameSentenceMiner.ai.providers.gemini_client import GeminiClient
from GameSentenceMiner.ai.providers.groq_client import GroqClient
from GameSentenceMiner.ai.providers.ollama_client import OllamaClient
from GameSentenceMiner.ai.providers.openai_client import OpenAIClient
from GameSentenceMiner.util.config.configuration import AI_GEMINI, AI_GROQ, AI_GSM_CLOUD, AI_LM_STUDIO, AI_OLLAMA, AI_OPENAI, Ai


@dataclass(frozen=True)
class ProviderKey:
    provider: str
    model: str
    api_url: str
    api_key_fingerprint: str


def _normalize_url(url: Optional[str]) -> str:
    if not url:
        return ""
    trimmed = url.strip()
    parsed = urlparse(trimmed)
    if parsed.scheme and parsed.netloc:
        return f"{parsed.scheme}://{parsed.netloc}{parsed.path}".rstrip("/")
    return trimmed.rstrip("/")


def _fingerprint_api_key(api_key: Optional[str]) -> str:
    if not api_key:
        return ""
    return hashlib.sha256(api_key.encode("utf-8")).hexdigest()[:8]


class ProviderRegistry:
    def __init__(self, logger):
        self.logger = logger
        self._clients: Dict[ProviderKey, ProviderClient] = {}

    def _build_key(self, provider: str, model: str, api_url: Optional[str], api_key: Optional[str]) -> ProviderKey:
        return ProviderKey(
            provider=provider,
            model=model,
            api_url=_normalize_url(api_url),
            api_key_fingerprint=_fingerprint_api_key(api_key),
        )

    def get_client(self, config: Ai) -> ProviderClient:
        if config.provider == AI_GEMINI:
            key = self._build_key(config.provider, config.gemini_model, None, config.gemini_api_key)
            if key not in self._clients:
                self._clients[key] = GeminiClient(
                    api_key=config.gemini_api_key,
                    model_name=config.gemini_model,
                    logger=self.logger,
                )
            return self._clients[key]

        if config.provider == AI_GROQ:
            key = self._build_key(config.provider, config.groq_model, None, config.groq_api_key)
            if key not in self._clients:
                self._clients[key] = GroqClient(
                    api_key=config.groq_api_key,
                    logger=self.logger,
                )
            return self._clients[key]

        if config.provider == AI_OPENAI:
            key = self._build_key(config.provider, config.open_ai_model, config.open_ai_url, config.open_ai_api_key)
            if key not in self._clients:
                self._clients[key] = OpenAIClient(
                    api_url=config.open_ai_url,
                    api_key=config.open_ai_api_key,
                    logger=self.logger,
                )
            return self._clients[key]

        if config.provider == AI_GSM_CLOUD:
            gsm_cloud_url = config.get_gsm_cloud_openai_base_url()
            gsm_cloud_model = config.get_gsm_cloud_primary_model()
            key = self._build_key(
                config.provider,
                gsm_cloud_model,
                gsm_cloud_url,
                config.gsm_cloud_access_token,
            )
            if key not in self._clients:
                self._clients[key] = OpenAIClient(
                    api_url=gsm_cloud_url,
                    api_key=config.gsm_cloud_access_token,
                    logger=self.logger,
                )
            return self._clients[key]

        if config.provider == AI_OLLAMA:
            key = self._build_key(config.provider, config.ollama_model, config.ollama_url, None)
            if key not in self._clients:
                self._clients[key] = OllamaClient(
                    api_url=config.ollama_url,
                    logger=self.logger,
                )
            return self._clients[key]

        if config.provider == AI_LM_STUDIO:
            key = self._build_key(config.provider, config.lm_studio_model, config.lm_studio_url, config.lm_studio_api_key)
            if key not in self._clients:
                self._clients[key] = OpenAIClient(
                    api_url=config.lm_studio_url,
                    api_key=config.lm_studio_api_key,
                    logger=self.logger,
                )
            return self._clients[key]

        raise ValueError(f"Unsupported AI provider: {config.provider}")
