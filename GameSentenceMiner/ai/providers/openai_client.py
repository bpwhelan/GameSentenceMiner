from __future__ import annotations

import time
from typing import Optional, Any, Dict

from GameSentenceMiner.ai.contracts import AIRequest, AIResponse, AIError


class OpenAIClient:
    def __init__(self, api_url: str, api_key: str, logger):
        self.api_url = api_url
        self.api_key = api_key
        self.logger = logger
        self.client = None
        try:
            import openai

            self.client = openai.OpenAI(base_url=api_url, api_key=api_key)
        except Exception as e:
            self.logger.error(f"Failed to initialize OpenAI API: {e}")

    def _should_use_basic_params(self, model_name: str) -> bool:
        return "gpt-5" in model_name.lower()

    def generate(self, request: AIRequest) -> AIResponse:
        if self.client is None:
            raise AIError("OpenAI client not initialized.", transient=False)

        extra_params_allowed = not self._should_use_basic_params(request.model)
        start_time = time.time()

        try:
            response = None
            if extra_params_allowed:
                try:
                    response = self.client.chat.completions.create(
                        model=request.model,
                        messages=[
                            {
                                "role": "system",
                                "content": "You are a helpful assistant that translates game dialogue. Provide output in the form of json with a single key 'output'.",
                            },
                            {"role": "user", "content": request.prompt},
                        ],
                        temperature=request.temperature,
                        max_tokens=request.max_tokens,
                        top_p=request.top_p,
                        n=1,
                        stop=None,
                    )
                except Exception as e:
                    extra_params_allowed = False
                    self.logger.warning(
                        f"Full parameter request failed, trying with basic parameters: {e}"
                    )

            if not extra_params_allowed or response is None:
                response = self.client.chat.completions.create(
                    model=request.model,
                    messages=[
                        {
                            "role": "system",
                            "content": "You are a helpful assistant that translates game dialogue. Provide output in the form of json with a single key 'output'.",
                        },
                        {"role": "user", "content": request.prompt},
                    ],
                    n=1,
                )

            raw_text = ""
            if response.choices and response.choices[0].message.content:
                raw_text = response.choices[0].message.content.strip()
            else:
                raw_text = "Processing failed: No content in API response"

            usage: Optional[Dict[str, Any]] = None
            if hasattr(response, "usage") and response.usage:
                usage = response.usage.model_dump() if hasattr(response.usage, "model_dump") else dict(response.usage)

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
            self.logger.exception(f"OpenAI processing failed: {e}")
            raise AIError(f"Processing failed: {e}", transient=True)
