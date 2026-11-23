"""Unit tests for the Python <-> Rust native mining shim & Qt confirmation hydration."""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace

from GameSentenceMiner.native import mining as native_mining
from GameSentenceMiner.ui import desktop_dialog


def test_external_gateway_port_parsing(monkeypatch):
    monkeypatch.delenv("GSM_EXTERNAL_GATEWAY_PORT", raising=False)
    assert native_mining.external_gateway_port() is None

    monkeypatch.setenv("GSM_EXTERNAL_GATEWAY_PORT", "7275")
    assert native_mining.external_gateway_port() == 7275

    monkeypatch.setenv("GSM_EXTERNAL_GATEWAY_PORT", "0")
    assert native_mining.external_gateway_port() is None

    monkeypatch.setenv("GSM_EXTERNAL_GATEWAY_PORT", "not-a-port")
    assert native_mining.external_gateway_port() is None


def test_native_mining_enabled_respects_fallback_flag(monkeypatch):
    monkeypatch.setattr(
        "GameSentenceMiner.util.communication.bus_client.owns_backend_connection",
        lambda: True,
    )
    monkeypatch.setenv("GSM_CLIENT_ID", "backend")

    monkeypatch.setenv("GSM_NATIVE_MINING", "1")
    assert native_mining.native_mining_enabled() is True

    monkeypatch.setenv("GSM_NATIVE_MINING", "python")
    assert native_mining.native_mining_enabled() is False

    monkeypatch.setenv("GSM_NATIVE_MINING", "0")
    assert native_mining.native_mining_enabled() is False

    monkeypatch.setenv("GSM_NATIVE_MINING", "1")
    monkeypatch.setenv("GSM_CLIENT_ID", "overlay")
    assert native_mining.native_mining_enabled() is False


def test_desktop_dialog_hydrates_and_restores_gsm_state_for_anki_confirmation(monkeypatch):
    from GameSentenceMiner.util.config.configuration import gsm_state

    captured = {}

    class FakeQtMain:
        @staticmethod
        def launch_anki_confirmation(**kwargs):
            captured["kwargs"] = kwargs
            captured["current_replay"] = gsm_state.current_replay
            captured["vad_result"] = gsm_state.vad_result
            captured["current_replay_context"] = gsm_state.current_replay_context
            captured["audio_edit_context"] = gsm_state.audio_edit_context
            return (True, kwargs["sentence"], "Hello", kwargs["screenshot_path"], None, False, kwargs["audio_path"], {})

    sentinel_replay = object()
    sentinel_vad = object()
    sentinel_ctx = object()
    sentinel_edit = object()
    monkeypatch.setattr(gsm_state, "current_replay", sentinel_replay)
    monkeypatch.setattr(gsm_state, "vad_result", sentinel_vad)
    monkeypatch.setattr(gsm_state, "current_replay_context", sentinel_ctx)
    monkeypatch.setattr(gsm_state, "audio_edit_context", sentinel_edit)

    args = {
        "expression": "世界",
        "sentence": "こんにちは世界",
        "screenshot_path": "shot.png",
        "previous_screenshot_path": None,
        "audio_path": "clip.opus",
        "translation": "Hello world",
        "screenshot_timestamp": 4.2,
        "video_path": "replay.mp4",
        "start_time": 1.5,
        "end_time": 6.5,
        "vad_result": {
            "success": True,
            "start": 0.2,
            "end": 3.8,
            "model": "FireRed",
            "output_audio": "clip.opus",
            "trimmed_audio_path": "clip.opus",
            "segments": [{"start": 0.2, "end": 3.8}],
            "tts_used": False,
        },
        "audio_edit_context": {
            "source_audio_path": "full.opus",
            "source_duration": 30.0,
            "range_start": 1.7,
            "range_end": 5.3,
            "rebase_on_selection_trim": False,
            "timeline": {"cuts": [[10.0, 12.0]], "fade": 0.02},
            "timing_fallback": False,
        },
        "mined_line": {
            "id": "line-42",
            "text": "こんにちは世界",
            "time": "2026-11-19T12:00:00",
            "scene": "TestVN",
            "source": "hooker",
        },
        "selected_lines": [
            {
                "id": "line-42",
                "text": "こんにちは世界",
                "time": "2026-11-19T12:00:00",
                "scene": "TestVN",
                "source": "hooker",
            }
        ],
        "anki_card_creation_time": "2026-11-19T12:00:05",
    }

    result = desktop_dialog._run_anki_confirmation_with_context(FakeQtMain, args)
    assert result[0] is True
    assert result[1] == "こんにちは世界"
    # Rust-only fields must be stripped before calling launch_anki_confirmation
    assert "video_path" not in captured["kwargs"]
    assert "vad_result" not in captured["kwargs"]
    assert captured["current_replay"] == "replay.mp4"
    assert captured["vad_result"].model == "FireRed"
    assert captured["current_replay_context"].video_path == "replay.mp4"
    assert captured["current_replay_context"].audio_result.start_time == 1.5
    assert captured["audio_edit_context"].source_audio_path == "full.opus"
    assert captured["audio_edit_context"].timeline.cuts == ((10.0, 12.0),)
    assert captured["current_replay_context"].mined_line.id == "line-42"
    # gsm_state must be cleanly restored after dialog finishes
    assert gsm_state.current_replay is sentinel_replay
    assert gsm_state.vad_result is sentinel_vad
    assert gsm_state.current_replay_context is sentinel_ctx
    assert gsm_state.audio_edit_context is sentinel_edit


def test_ai_prompting_and_overlay_translation_delegate_when_native_enabled(monkeypatch):
    from GameSentenceMiner.ai import ai_prompting, overlay_translation

    monkeypatch.setattr(native_mining, "native_mining_enabled", lambda: True)
    monkeypatch.setattr(native_mining, "ai_translate", lambda **kw: f"rust-tl:{kw['sentence']}")
    monkeypatch.setattr(native_mining, "ai_analyze", lambda *a, **kw: f"rust-an:{kw['mode']}")
    monkeypatch.setattr(
        native_mining,
        "ai_overlay_translate",
        lambda lines, blocks, game_title: [{"id": b["id"], "translation": f"tl:{b['text']}"} for b in blocks],
    )

    line = SimpleNamespace(id="1", text="テスト", time=datetime.now(UTC), scene="VN", clip=None)
    assert ai_prompting.get_ai_prompt_result([line], "テスト", line, "VN") == "rust-tl:テスト"
    assert ai_prompting.get_sentence_analysis([line], "テスト", line, "VN", mode="grammar") == "rust-an:grammar"
    out = overlay_translation.translate_overlay_blocks([line], [{"id": "b1", "text": "開始"}], "VN")
    assert out == [{"id": "b1", "translation": "tl:開始"}]
