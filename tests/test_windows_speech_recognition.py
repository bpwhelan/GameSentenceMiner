from __future__ import annotations

import zipfile
from types import SimpleNamespace

import pytest

from GameSentenceMiner import gametext
from GameSentenceMiner import windows_speech_recognition as speech
from GameSentenceMiner.text_pipeline.models import SourceKind
from GameSentenceMiner.windows_speech_recognition import (
    discover_speech_model,
    discover_speech_runtime,
    ensure_direct_live_captions_bundle,
    normalize_speech_locale,
    parse_speech_event,
)


def test_normalize_speech_locale_supports_gsm_language_codes():
    assert normalize_speech_locale("ja") == "ja-JP"
    assert normalize_speech_locale("en-US") == "en-US"


def test_normalize_speech_locale_rejects_unavailable_models():
    with pytest.raises(ValueError, match="English and Japanese"):
        normalize_speech_locale("de")


def test_get_target_window_uses_gsm_target_instead_of_foreground(monkeypatch):
    target = speech.ForegroundWindow(101, 202, "Game", "game.exe", r"C:\Games\game.exe")
    foreground = speech.ForegroundWindow(303, 404, "Editor", "editor.exe", r"C:\Editor\editor.exe")

    monkeypatch.setattr(speech.sys, "platform", "win32")
    monkeypatch.setattr(speech, "_get_window_state_target_hwnd", lambda: target.hwnd)
    monkeypatch.setattr(speech, "_window_from_hwnd", lambda hwnd: target if hwnd == target.hwnd else None)
    monkeypatch.setattr(speech, "_resolve_obs_target_hwnd", lambda: pytest.fail("OBS fallback should not run"))
    monkeypatch.setattr(speech, "get_foreground_window", lambda: foreground)

    assert speech.get_target_window() == target


def test_get_target_window_does_not_fall_back_to_foreground(monkeypatch):
    monkeypatch.setattr(speech.sys, "platform", "win32")
    monkeypatch.setattr(speech, "_get_window_state_target_hwnd", lambda: None)
    monkeypatch.setattr(speech, "_resolve_obs_target_hwnd", lambda: None)
    monkeypatch.setattr(
        speech,
        "get_foreground_window",
        lambda: pytest.fail("Speech recognition must not use the foreground window"),
    )

    assert speech.get_target_window() is None


def test_service_defaults_to_gsm_target_provider(monkeypatch):
    target = speech.ForegroundWindow(101, 202)
    provider = lambda: target
    monkeypatch.setattr(speech, "get_target_window", provider)

    service = speech.WindowsSpeechRecognitionService(lambda *_args: None, language="ja")

    assert service.target_window_provider is provider
    assert service.foreground_provider is provider
    assert service._safe_target_window() == target


def test_source_kind_recognizes_windows_speech_display_name():
    assert SourceKind.normalize("", "Windows Speech Recognition") is SourceKind.SPEECH_RECOGNITION


def test_parse_speech_event_ignores_status_and_keeps_partial_metadata():
    assert parse_speech_event('{"type":"status","status":"ready"}') is None

    event = parse_speech_event(b'{"type":"recognition","final":false,"text":"hello","offset":12,"duration":34}')

    assert event is not None
    assert event.text == "hello"
    assert event.final is False
    assert event.offset == 12
    assert event.duration == 34


def test_discover_speech_model_honors_an_explicit_model_directory(tmp_path):
    (tmp_path / "sr.ini").write_text("locale-id=1041\n", encoding="utf-8")

    assert discover_speech_model("ja", str(tmp_path)) == tmp_path


def _write_test_direct_live_captions_archive(path):
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("DirectLiveCaptions/Microsoft.CognitiveServices.Speech.core.dll", b"dll")
        package = "DirectLiveCaptions/MicrosoftWindows.Speech.ja-JP.1_1.0.19.0_x64__cw5n1h2txyewy"
        archive.writestr(f"{package}/sr.ini", "locale-id=1041\n")
        archive.writestr(f"{package}/svad.quantized.onnx", b"model")


def test_ensure_direct_live_captions_bundle_downloads_extracts_and_reuses_cache(tmp_path):
    source_archive = tmp_path / "source.zip"
    cache_dir = tmp_path / "cache"
    _write_test_direct_live_captions_archive(source_archive)
    progress = []

    result = ensure_direct_live_captions_bundle(
        cache_dir,
        url=source_archive.as_uri(),
        progress_callback=lambda downloaded, total: progress.append((downloaded, total)),
    )

    assert result == cache_dir / "DirectLiveCaptions"
    assert (result / "Microsoft.CognitiveServices.Speech.core.dll").is_file()
    assert discover_speech_model("ja", str(cache_dir)) == result / (
        "MicrosoftWindows.Speech.ja-JP.1_1.0.19.0_x64__cw5n1h2txyewy"
    )
    assert discover_speech_runtime(str(cache_dir)) == result
    assert not (cache_dir / "DirectLiveCaptions.zip").exists()
    assert progress[-1][0] == progress[-1][1]

    # A complete cache should not contact the URL again, even if the original
    # archive has since disappeared.
    assert ensure_direct_live_captions_bundle(cache_dir, url=(tmp_path / "gone.zip").as_uri()) == result


def test_ensure_direct_live_captions_bundle_rejects_zip_path_traversal(tmp_path):
    source_archive = tmp_path / "unsafe.zip"
    cache_dir = tmp_path / "cache"
    with zipfile.ZipFile(source_archive, "w") as archive:
        archive.writestr("DirectLiveCaptions/../outside.txt", b"nope")

    with pytest.raises(ValueError, match="Unsafe path"):
        ensure_direct_live_captions_bundle(cache_dir, url=source_archive.as_uri())

    assert not (tmp_path / "outside.txt").exists()


def test_service_resolves_the_downloaded_bundle_before_installed_assets(monkeypatch, tmp_path):
    source_archive = tmp_path / "source.zip"
    cache_dir = tmp_path / "cache"
    _write_test_direct_live_captions_archive(source_archive)
    monkeypatch.setattr(speech.sys, "platform", "win32")
    monkeypatch.setenv("GSM_WINDOWS_SPEECH_CACHE_DIR", str(cache_dir))
    monkeypatch.setenv("GSM_WINDOWS_SPEECH_BUNDLE_URL", source_archive.as_uri())

    service = speech.WindowsSpeechRecognitionService(lambda *_args: None, language="ja")
    model, runtime = service._resolve_embedded_assets()

    assert model is not None and model.parent == cache_dir / "DirectLiveCaptions"
    assert runtime == cache_dir / "DirectLiveCaptions"


def test_handle_new_text_event_can_force_merge_for_windows_speech(monkeypatch):
    calls = []

    async def fake_add_line(*args, **kwargs):
        calls.append((args, kwargs))

    monkeypatch.setattr(
        gametext,
        "get_config",
        lambda: SimpleNamespace(
            general=SimpleNamespace(merge_matching_sequential_text=False),
            hotkeys=SimpleNamespace(relay_outputs_when_text_intake_paused=True),
        ),
    )
    monkeypatch.setattr(gametext.obs, "update_current_game", lambda: None)
    monkeypatch.setattr(gametext.obs, "get_current_game", lambda *_args, **_kwargs: "")
    monkeypatch.setattr(gametext.discord_rpc_manager, "update", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(gametext, "add_line_to_text_log", fake_add_line)
    monkeypatch.setattr(gametext.gsm_state, "text_input_paused", False, raising=False)

    import asyncio

    asyncio.run(
        gametext.handle_new_text_event(
            "speech fragment",
            source="speech_recognition",
            merge_fragments=True,
            metadata_extra={"window_pid": 1234},
        )
    )

    assert calls[0][1]["merge_fragments"] is True
    assert calls[0][1]["metadata_extra"] == {"window_pid": 1234}
