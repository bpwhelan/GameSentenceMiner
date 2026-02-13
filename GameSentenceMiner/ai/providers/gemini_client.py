from __future__ import annotations

import time
from google import genai
from google.genai import types
from typing import Optional, Any, Dict

from GameSentenceMiner.ai.contracts import AIRequest, AIResponse, AIError
from GameSentenceMiner.util.config.configuration import normalize_gemini_model_name


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
            self.client = genai.Client(api_key=self.api_key)
        except Exception as e:
            self.logger.error(f"Failed to initialize Gemini API: {e}")

    @staticmethod
    def _get_thinking_budget(model_name: str) -> Optional[int]:
        model = (model_name or "").lower()
        if "gemini-2.5" in model or "gemini-3" in model:
            return -1 if "-pro" in model else 0
        return None

    def _build_generation_config(self, request: AIRequest, model_name: str) -> types.GenerateContentConfig:
        config = types.GenerateContentConfig(
            temperature=request.temperature,
            max_output_tokens=request.max_tokens,
            top_p=request.top_p,
            stop_sequences=None,
            safety_settings=self._safety_settings,
        )
        thinking_budget = self._get_thinking_budget(model_name)
        if thinking_budget is not None:
            config.thinking_config = types.ThinkingConfig(thinking_budget=thinking_budget)
        return config

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

            result = ""
            if response.candidates:
                for candidate in response.candidates:
                    if candidate.content and candidate.content.parts:
                        for part in candidate.content.parts:
                            if hasattr(part, "text") and part.text:
                                result += part.text

            raw_text = result.strip()
            usage: Optional[Dict[str, Any]] = None
            if hasattr(response, "usage_metadata") and response.usage_metadata:
                usage = response.usage_metadata.model_dump() if hasattr(response.usage_metadata, "model_dump") else dict(response.usage_metadata)

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
