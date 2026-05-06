from __future__ import annotations

import time
from typing import Optional, Any, Dict

from GameSentenceMiner.ai.contracts import AIRequest, AIResponse, AIError


class OllamaClient:
    def __init__(self, api_url: str, logger):
        self.api_url = api_url
        self.logger = logger
        self.client = None
        try:
            import ollama

            self.client = ollama.Client(host=api_url)
        except Exception as e:
            self.logger.error(f"Failed to initialize Ollama client: {e}")

    def generate(self, request: AIRequest) -> AIResponse:
        if self.client is None:
            raise AIError("Ollama client not initialized.", transient=False)

        start_time = time.time()
        try:
            response = self.client.chat(
                model=request.model,
                messages=[
                    {
                        "role": "system",
                        "content": "You are a helpful assistant that translates game dialogue. Provide output in the form of json with a single key 'output'.",
                    },
                    {"role": "user", "content": request.prompt},
                ],
                options={
                    "temperature": request.temperature,
                    "top_p": request.top_p,
                    "num_predict": request.max_tokens,
                },
            )
            raw_text = response["message"]["content"].strip()
            usage: Optional[Dict[str, Any]] = None
            if isinstance(response, dict) and "usage" in response:
                usage = response["usage"]

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
            self.logger.exception(f"Ollama processing failed: {e}")
            raise AIError(f"Processing failed: {e}", transient=True)
