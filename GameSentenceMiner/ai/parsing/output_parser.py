from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Optional


@dataclass
class OutputParser:
    compat_mode: bool = True

    def parse(self, raw_text: str) -> str:
        if not raw_text:
            return raw_text

        if not self.compat_mode:
            return raw_text

        if "{" in raw_text and "}" in raw_text:
            try:
                json_output = raw_text[raw_text.find("{"):raw_text.rfind("}") + 1]
                json_output = json_output.replace("{output:", '{"output":')
                parsed = json.loads(json_output)
                if isinstance(parsed, dict) and "output" in parsed:
                    return parsed["output"]
            except Exception:
                return raw_text

        return raw_text
