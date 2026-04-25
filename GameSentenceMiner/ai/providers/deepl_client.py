from __future__ import annotations

import time
import json
import requests

from GameSentenceMiner.ai.contracts import AIRequest, AIResponse, AIError


class DeepLClient:
    def __init__(self, api_key: str, logger, target_lang: str = "EN"):  # ← Default to "EN"
        self.api_key = api_key
        self.logger = logger
        self.target_lang = target_lang or "EN"  # ← Use provided value or fallback to "EN"
        self.url = "https://api-free.deepl.com/v2/translate"

    def generate(self, request: AIRequest) -> AIResponse:
        self.logger.debug("[DEEPL CLIENT] generate() CALLED")
        start_time = time.time()

        try:
            # Extract Japanese text from the prompt (your existing extraction logic)
            import re
            
            full_prompt = request.prompt.strip()
            
            # DO NOT do regex extraction for DeepL
            text_to_send = full_prompt

            # optional cleanup only (safe)
            text_to_send = text_to_send.strip().strip('"').strip("'")

            if not text_to_send:
                 raise AIError("Empty input to DeepL", transient=False)
                
            deepl_lang_map = {
                "en": "EN",
                "ja": "JA",
                "zh": "ZH",
                "es": "ES",
                "fr": "FR",
                "de": "DE",
                "it": "IT",
                "nl": "NL",
                "pl": "PL",
                "pt": "PT-PT",
                "ru": "RU",
                "ko": "KO",
            }
            
            target = deepl_lang_map.get(self.target_lang.lower(), self.target_lang)
            
            # NEW: Use header authentication instead of form data
            headers = {
                "Authorization": f"DeepL-Auth-Key {self.api_key.strip()}",
                "Content-Type": "application/x-www-form-urlencoded"
            }
            
            response = requests.post(
                self.url,
                headers=headers,  # ← Move API key to header
                data={
                    "text": text_to_send,
                    "target_lang": target,
                },
                timeout=30,
            )

            if response.status_code != 200:
                self.logger.debug(f"Response status code: {response.status_code}")
                self.logger.debug(f"Response body: {response.text}")
                
            response.raise_for_status()
            data = response.json()
            translated = data["translations"][0]["text"]
            latency_ms = int((time.time() - start_time) * 1000)

            return AIResponse(
                provider=request.provider,
                model="deepl",
                text=translated,
                raw_text=translated,
                latency_ms=latency_ms,
                usage=None,
            )

        except Exception as e:
            self.logger.exception(f"DeepL processing failed: {e}")
            raise AIError(f"Processing failed: {e}", transient=True)
