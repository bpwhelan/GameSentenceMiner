from __future__ import annotations

import time
from typing import Any, Dict, Optional

from google import genai
from google.genai import types

from GameSentenceMiner.ai.contracts import AIRequest, AIResponse, AIError
from GameSentenceMiner.util.config.configuration import normalize_gemini_model_name

LOW_LATENCY_TOKEN_LIMITS = {
    "translation": 128,
    "context": 192,
}

# Later Flash models (3.7+) only support LOW and above. Keep MINIMAL scoped
# to the families that support it instead of assuming every Gemini 3 does.
# https://ai.google.dev/gemini-api/docs/thinking
MINIMAL_THINKING_MODEL_PREFIXES = (
    "gemini-3-flash",
    "gemini-3.1-flash-lite",
    "gemini-3.5-flash",
    "gemini-3.6-flash",
    "gemma-4",
)


class GeminiClient:
    def __init__(self, api_key: str, model_name: str, logger):
        self.api_key = api_key
        self.model_name = model_name
        self.logger = logger
        self.client = None
        self._safety_settings = [
            types.SafetySetting(
                category=types.HarmCategory.HARM_CATEGORY_HARASSMENT,
                threshold=types.HarmBlockThreshold.BLOCK_NONE,
            ),
            types.SafetySetting(
                category=types.HarmCategory.HARM_CATEGORY_HATE_SPEECH,
                threshold=types.HarmBlockThreshold.BLOCK_NONE,
            ),
            types.SafetySetting(
                category=types.HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
                threshold=types.HarmBlockThreshold.BLOCK_NONE,
            ),
            types.SafetySetting(
                category=types.HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
                threshold=types.HarmBlockThreshold.BLOCK_NONE,
            ),
        ]
        try:
            self.client = genai.Client(
                api_key=self.api_key,
                http_options=types.HttpOptions(
                    retry_options=types.HttpRetryOptions(
                        # Retry a temporary server failure once. Invalid requests
                        # and exhausted quotas should go straight to the backup.
                        attempts=2,
                        http_status_codes=[408, 500, 502, 503, 504],
                    )
                ),
            )
        except Exception as e:
            self.logger.error(f"Failed to initialize Gemini API: {e}")

    @staticmethod
    def _get_thinking_budget(model_name: str) -> Optional[int]:
        model = (model_name or "").lower()
        if model.startswith("gemini-2.5"):
            return -1 if "-pro" in model else 0
        return None

    @staticmethod
    def _build_thinking_config(model_name: str) -> Optional[types.ThinkingConfig]:
        model = (model_name or "").lower()
        thinking_fields = getattr(types.ThinkingConfig, "model_fields", {})

        if "thinking_level" in thinking_fields and model.startswith(("gemini-3", "gemma-4")):
            # Gemini 3 rejects the legacy zero-token thinking budget. Gemma 4
            # also uses levels, with MINIMAL disabling its thinking mode.
            level = (
                types.ThinkingLevel.MINIMAL
                if model.startswith(MINIMAL_THINKING_MODEL_PREFIXES)
                else types.ThinkingLevel.LOW
            )
            return types.ThinkingConfig(
                thinking_level=level,
                include_thoughts=False,
            )

        thinking_budget = GeminiClient._get_thinking_budget(model_name)
        if thinking_budget is None:
            return None

        kwargs: dict[str, Any] = {"thinking_budget": thinking_budget}
        if "include_thoughts" in thinking_fields:
            kwargs["include_thoughts"] = False
        return types.ThinkingConfig(**kwargs)

    def _build_generation_config(self, request: AIRequest, model_name: str) -> types.GenerateContentConfig:
        max_output_tokens = LOW_LATENCY_TOKEN_LIMITS.get(request.request_kind, request.max_tokens)
        max_output_tokens = min(request.max_tokens, max_output_tokens)
        config = types.GenerateContentConfig(
            temperature=request.temperature,
            max_output_tokens=max_output_tokens,
            top_p=request.top_p,
            stop_sequences=None,
            response_mime_type="text/plain",
            safety_settings=self._safety_settings,
        )
        thinking_config = self._build_thinking_config(model_name)
        if thinking_config is not None:
            config.thinking_config = thinking_config
        return config

    @staticmethod
    def _extract_response_text(response: Any) -> str:
        response_text = getattr(response, "text", None)
        if isinstance(response_text, str) and response_text.strip():
            return response_text.strip()

        text_parts: list[str] = []
        for candidate in getattr(response, "candidates", None) or []:
            for part in getattr(getattr(candidate, "content", None), "parts", None) or []:
                if getattr(part, "thought", False):
                    continue
                part_text = getattr(part, "text", None)
                if part_text:
                    text_parts.append(part_text)
        return "".join(text_parts).strip()

    def generate(self, request: AIRequest) -> AIResponse:
        if self.client is None:
            raise AIError("Gemini model not initialized.", transient=False)

        start_time = time.time()
        try:
            model_name = normalize_gemini_model_name(request.model)
            generation_config = self._build_generation_config(request, model_name)
            contents = [
                types.Content(
                    role="user",
                    parts=[types.Part.from_text(text=request.prompt)],
                ),
            ]
            response = self.client.models.generate_content(
                model=model_name,
                contents=contents,
                config=generation_config,
            )

            self.logger.debug(f"Gemini raw response: {response}")

            raw_text = self._extract_response_text(response)
            usage: Optional[Dict[str, Any]] = None
            if hasattr(response, "usage_metadata") and response.usage_metadata:
                usage = (
                    response.usage_metadata.model_dump()
                    if hasattr(response.usage_metadata, "model_dump")
                    else dict(response.usage_metadata)
                )

            latency_ms = int((time.time() - start_time) * 1000)
            return AIResponse(
                provider=request.provider,
                model=model_name,
                text=raw_text,
                raw_text=raw_text,
                latency_ms=latency_ms,
                usage=usage,
            )
        except Exception as e:
            self.logger.error(f"Gemini processing failed: {e}")
            raise AIError(f"Processing failed: {e}", transient=True)
