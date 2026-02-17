from __future__ import annotations

import time
from groq import Groq
from typing import Optional, Any, Dict

from GameSentenceMiner.ai.contracts import AIRequest, AIResponse, AIError


class GroqClient:
    def __init__(self, api_key: str, logger):
        self.api_key = api_key
        self.logger = logger
        self.client = None
        try:
            self.client = Groq(api_key=self.api_key)
        except Exception as e:
            self.logger.error(f"Failed to initialize Groq client: {e}")

    def generate(self, request: AIRequest) -> AIResponse:
        if self.client is None:
            raise AIError("Groq client not initialized.", transient=False)

        start_time = time.time()
        try:
            completion = self.client.chat.completions.create(
                model=request.model,
                messages=[{"role": "user", "content": request.prompt}],
                temperature=request.temperature,
                max_completion_tokens=request.max_tokens,
                top_p=request.top_p,
                stream=False,
                stop=None,
            )
            raw_text = completion.choices[0].message.content.strip()
            usage: Optional[Dict[str, Any]] = None
            if hasattr(completion, "usage") and completion.usage:
                usage = completion.usage.model_dump() if hasattr(completion.usage, "model_dump") else dict(completion.usage)

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
            self.logger.error(f"Groq processing failed: {e}")
            raise AIError(f"Processing failed: {e}", transient=True)
