from __future__ import annotations

import time
from google import genai
from google.genai import types
from typing import Optional, Any, Dict

from GameSentenceMiner.ai.contracts import AIRequest, AIResponse, AIError
from GameSentenceMiner.util.config.configuration import get_config


class GeminiClient:
    def __init__(self, api_key: str, model_name: str, logger):
        self.api_key = api_key
        self.model_name = model_name
        self.logger = logger
        self.client = None
        self.generation_config = None
        try:
            self.client = genai.Client(api_key=self.api_key)
            self.generation_config = types.GenerateContentConfig(
                temperature=get_config().ai.temperature,
                max_output_tokens=get_config().ai.max_output_tokens,
                top_p=get_config().ai.top_p,
                stop_sequences=None,
                safety_settings=[
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
                ],
            )
            if "2.5" in self.model_name:
                self.generation_config.thinking_config = types.ThinkingConfig(
                    thinking_budget=-1 if "2.5-pro" in self.model_name else 0
                )
        except Exception as e:
            self.logger.error(f"Failed to initialize Gemini API: {e}")

    def generate(self, request: AIRequest) -> AIResponse:
        if self.client is None or self.generation_config is None:
            raise AIError("Gemini model not initialized.", transient=False)

        start_time = time.time()
        try:
            self.generation_config.temperature = request.temperature
            self.generation_config.max_output_tokens = request.max_tokens
            self.generation_config.top_p = request.top_p
            contents = [
                types.Content(
                    role="user",
                    parts=[types.Part.from_text(text=request.prompt)],
                ),
            ]
            response = self.client.models.generate_content(
                model=request.model,
                contents=contents,
                config=self.generation_config,
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
                model=request.model,
                text=raw_text,
                raw_text=raw_text,
                latency_ms=latency_ms,
                usage=usage,
            )
        except Exception as e:
            self.logger.error(f"Gemini processing failed: {e}")
            raise AIError(f"Processing failed: {e}", transient=True)
