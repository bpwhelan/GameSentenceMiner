from __future__ import annotations

import json
import os
from typing import Any

from GameSentenceMiner.util.config.configuration import Locale, logger


def load_localization(locale: Locale = Locale.English) -> dict[str, Any]:
    """Load the localization file for the given locale."""
    try:
        script_dir = os.path.dirname(os.path.abspath(__file__))
        lang_file = os.path.join(script_dir, "..", "..", "locales", f"{locale.value}.json")
        with open(lang_file, "r", encoding="utf-8") as handle:
            return json.load(handle)["python"]["config"]
    except (FileNotFoundError, json.JSONDecodeError) as exc:
        logger.warning(
            f"Could not load localization file '{locale.value}.json'. Error: {exc}. Falling back to empty dict."
        )
        return {}
