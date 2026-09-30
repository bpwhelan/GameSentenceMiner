from types import SimpleNamespace

from GameSentenceMiner.ocr import gsm_ocr


def test_gsm_ocr_preserves_persistent_logger_when_runtime_starts(monkeypatch):
    run_kwargs = {}

    monkeypatch.setattr(gsm_ocr.ocr_runtime, "init_config", lambda _parse_args: None)
    monkeypatch.setattr(gsm_ocr.ocr_runtime, "run", lambda **kwargs: run_kwargs.update(kwargs))
    monkeypatch.setattr(gsm_ocr, "obs_ocr", False)
    monkeypatch.setattr(gsm_ocr, "window", None)
    monkeypatch.setattr(gsm_ocr, "ss_clipboard", False, raising=False)
    monkeypatch.setattr(gsm_ocr, "manual", False, raising=False)
    monkeypatch.setattr(gsm_ocr, "global_pause_hotkey", "", raising=False)
    monkeypatch.setattr(gsm_ocr, "ocr1", "screenai", raising=False)
    monkeypatch.setattr(gsm_ocr, "ocr2", "glens", raising=False)
    monkeypatch.setattr(gsm_ocr, "furigana_filter_sensitivity", 16, raising=False)
    monkeypatch.setattr(gsm_ocr, "get_ocr_scan_rate", lambda: 0.5)

    config = SimpleNamespace(window=None)
    gsm_ocr.run_oneocr(config, [])

    assert run_kwargs["configure_logger"] is False
    assert run_kwargs["logger_setup_callback"] is gsm_ocr._setup_ocr_process_logging


def test_ocr_debug_setup_uses_persistent_default_directory(monkeypatch, tmp_path):
    calls = []
    monkeypatch.setattr(gsm_ocr, "get_ocr_advanced_debug_logging", lambda: True)
    monkeypatch.setattr(gsm_ocr, "start_ocr_debug_log", lambda: (tmp_path / "ocr-debug.jsonl", True))
    fake_logger = SimpleNamespace(info=lambda *args: calls.append(args))
    gsm_ocr._setup_ocr_process_logging(fake_logger)
    assert calls == [("Advanced OCR debug log: {}", tmp_path / "ocr-debug.jsonl")]
