"""Z.ai's standard API (separate from its Coding Plan endpoint)."""

import time

from GameSentenceMiner.ai.contracts import AIError, AIRequest, AIResponse

ZAI_API_URL = "https://api.z.ai/api/paas/v4/"


class ZaiClient:
    def __init__(self, api_key: str, logger):
        from openai import OpenAI

        self.logger = logger
        self.client = OpenAI(base_url=ZAI_API_URL, api_key=api_key, timeout=45.0, max_retries=0)

    def generate(self, request: AIRequest) -> AIResponse:
        start = time.monotonic()
        try:
            response = self.client.chat.completions.create(
                model=request.model,
                messages=[{"role": "user", "content": request.prompt}],
                temperature=request.temperature,
                top_p=request.top_p,
                max_tokens=request.max_tokens,
                # Flash enables thinking by default. Translation needs the answer
                # budget and low latency; never expose reasoning_content as output.
                extra_body={"thinking": {"type": "disabled"}},
            )
            if not response.choices or not response.choices[0].message.content:
                raise AIError("Z.ai returned no text. Try again or choose another model.", transient=True)
            if response.choices[0].finish_reason == "length":
                raise AIError("Z.ai's response was cut off. Increase Max Output Tokens in AI settings.")
            text = response.choices[0].message.content.strip()
            if not text:
                raise AIError("Z.ai returned an empty answer.", transient=True)
            return AIResponse(
                provider=request.provider,
                model=request.model,
                text=text,
                raw_text=text,
                latency_ms=int((time.monotonic() - start) * 1000),
                usage=response.usage.model_dump() if response.usage else None,
            )
        except AIError:
            raise
        except Exception as exc:
            status = getattr(exc, "status_code", None)
            if status in (401, 403):
                message = "Z.ai rejected the API key. Create a key in the Z.ai API console and paste it in AI settings."
            elif status == 429:
                message = "Z.ai's rate limit or quota was reached. Wait and retry, or check usage in the Z.ai console."
            elif status == 404:
                message = "Z.ai could not find this model. Choose glm-4.7-flash in AI settings."
            else:
                message = "Could not complete the Z.ai request. Check your connection and model access, then retry."
            # SDK exception bodies may contain credentials or request content.
            self.logger.warning("Z.ai request failed (status=%s, type=%s)", status, type(exc).__name__)
            raise AIError(message, transient=status is None or status == 429 or status >= 500) from exc
