from __future__ import annotations

import time
import json
import requests

from GameSentenceMiner.ai.contracts import AIRequest, AIResponse, AIError


class DeepLClient:
    def __init__(self, api_key: str, logger):
        self.api_key = api_key
        self.logger = logger
        self.url = "https://api-free.deepl.com/v2/translate"

    def generate(self, request: AIRequest) -> AIResponse:
        start_time = time.time()

        try:
            response = requests.post(
                self.url,
                data={
                    "auth_key": self.api_key,
                    "text": request.prompt,
                    "target_lang": "EN"
                }
            )

            response.raise_for_status()
            data = response.json()

            translated = data["translations"][0]["text"]

            raw_text = json.dumps({"output": translated})

            latency_ms = int((time.time() - start_time) * 1000)

            return AIResponse(
                provider=request.provider,
                model="deepl",
                text=raw_text,
                raw_text=raw_text,
                latency_ms=latency_ms,
                usage=None
            )

        except Exception as e:
            self.logger.exception(f"DeepL processing failed: {e}")
            raise AIError(f"Processing failed: {e}", transient=True)
