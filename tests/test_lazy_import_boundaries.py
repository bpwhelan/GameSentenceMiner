from __future__ import annotations

import json
import subprocess
import sys
import textwrap
from pathlib import Path


def _run_probe(code: str) -> dict:
    repo_root = Path(__file__).resolve().parents[1]
    output = subprocess.check_output(
        [sys.executable, "-c", textwrap.dedent(code)],
        cwd=repo_root,
        text=True,
    )
    return json.loads(output.strip().splitlines()[-1])


def test_importing_web_package_does_not_load_texthooking_page():
    result = _run_probe(
        """
        import json
        import sys
        from pathlib import Path

        sys.path.insert(0, str(Path.cwd()))
        import GameSentenceMiner.web  # noqa: F401

        print(json.dumps({
            "texthooking_loaded": "GameSentenceMiner.web.texthooking_page" in sys.modules,
        }))
        """
    )

    assert result["texthooking_loaded"] is False


def test_importing_anki_does_not_eagerly_load_ai_prompting_or_texthooking_page():
    result = _run_probe(
        """
        import json
        import sys
        from pathlib import Path

        sys.path.insert(0, str(Path.cwd()))
        import GameSentenceMiner.anki  # noqa: F401

        print(json.dumps({
            "ai_prompting_loaded": "GameSentenceMiner.ai.ai_prompting" in sys.modules,
            "texthooking_loaded": "GameSentenceMiner.web.texthooking_page" in sys.modules,
        }))
        """
    )

    assert result["ai_prompting_loaded"] is False
    assert result["texthooking_loaded"] is False


def test_importing_ai_registry_does_not_load_provider_sdk_modules():
    result = _run_probe(
        """
        import json
        import sys
        from pathlib import Path

        sys.path.insert(0, str(Path.cwd()))
        import GameSentenceMiner.ai.registry  # noqa: F401

        print(json.dumps({
            "gemini_client_loaded": "GameSentenceMiner.ai.providers.gemini_client" in sys.modules,
            "groq_client_loaded": "GameSentenceMiner.ai.providers.groq_client" in sys.modules,
            "google_genai_loaded": "google.genai" in sys.modules,
            "groq_sdk_loaded": "groq" in sys.modules,
        }))
        """
    )

    assert result["gemini_client_loaded"] is False
    assert result["groq_client_loaded"] is False
    assert result["google_genai_loaded"] is False
    assert result["groq_sdk_loaded"] is False


def test_importing_ai_prompting_does_not_eagerly_load_ai_service_stack():
    result = _run_probe(
        """
        import json
        import sys
        from pathlib import Path

        sys.path.insert(0, str(Path.cwd()))
        import GameSentenceMiner.ai.ai_prompting  # noqa: F401

        print(json.dumps({
            "ai_service_loaded": "GameSentenceMiner.ai.service" in sys.modules,
            "character_summary_loaded": "GameSentenceMiner.ai.features.character_summary" in sys.modules,
        }))
        """
    )

    assert result["ai_service_loaded"] is False
    assert result["character_summary_loaded"] is False


def test_importing_ui_package_does_not_load_pyqt():
    result = _run_probe(
        """
        import json
        import sys
        from pathlib import Path

        sys.path.insert(0, str(Path.cwd()))
        import GameSentenceMiner.ui  # noqa: F401

        print(json.dumps({
            "pyqt_loaded": any(name.startswith("PyQt6") for name in sys.modules),
        }))
        """
    )

    assert result["pyqt_loaded"] is False


def test_importing_gsm_does_not_eagerly_load_web_stack_modules():
    result = _run_probe(
        """
        import json
        import sys
        from pathlib import Path

        sys.path.insert(0, str(Path.cwd()))
        import GameSentenceMiner.gsm  # noqa: F401

        print(json.dumps({
            "texthooking_loaded": "GameSentenceMiner.web.texthooking_page" in sys.modules,
            "websocket_loaded": "GameSentenceMiner.web.gsm_websocket" in sys.modules,
            "web_service_loaded": "GameSentenceMiner.web.service" in sys.modules,
            "anki_api_endpoints_loaded": "GameSentenceMiner.web.anki_api_endpoints" in sys.modules,
            "ui_package_loaded": "GameSentenceMiner.ui" in sys.modules,
            "qt_main_loaded": "GameSentenceMiner.ui.qt_main" in sys.modules,
            "pyqt_loaded": any(name.startswith("PyQt6") for name in sys.modules),
        }))
        """
    )

    assert result["texthooking_loaded"] is False
    assert result["websocket_loaded"] is False
    assert result["web_service_loaded"] is False
    assert result["anki_api_endpoints_loaded"] is False
    assert result["ui_package_loaded"] is False
    assert result["qt_main_loaded"] is False
    assert result["pyqt_loaded"] is False
