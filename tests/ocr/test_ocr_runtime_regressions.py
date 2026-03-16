from __future__ import annotations

import asyncio
import json
from datetime import datetime
from types import SimpleNamespace

from PIL import Image

import GameSentenceMiner.ocr.gsm_ocr as gsm_ocr
from GameSentenceMiner.owocr.owocr import run as run_module


def test_resolve_requested_engines_prioritizes_cli_values():
    engines = run_module._resolve_requested_engines(
        "meikiocr",
        "glens",
        requested_engine="alivetext",
        requested_ocr1="alivetext",
        requested_ocr2="alivetext",
    )

    assert engines[0] == "alivetext"
    assert engines.count("alivetext") == 1
    assert "meikiocr" in engines
    assert "glens" in engines


def test_resolve_requested_engines_falls_back_to_config_values():
    engines = run_module._resolve_requested_engines(
        "meikiocr",
        "glens",
        requested_engine=None,
        requested_ocr1=None,
        requested_ocr2=None,
    )

    assert engines == ["meikiocr", "glens"]


def test_run_oneocr_disables_manual_combo_in_auto_mode(monkeypatch):
    captured = {}

    monkeypatch.setattr(gsm_ocr.run, "init_config", lambda _parse_args: None)
    monkeypatch.setattr(gsm_ocr.run, "run", lambda **kwargs: captured.update(kwargs))

    monkeypatch.setattr(gsm_ocr, "obs_ocr", True)
    monkeypatch.setattr(gsm_ocr, "window", None)
    monkeypatch.setattr(gsm_ocr, "ss_clipboard", False, raising=False)
    monkeypatch.setattr(gsm_ocr, "ocr1", "alivetext", raising=False)
    monkeypatch.setattr(gsm_ocr, "ocr2", "alivetext", raising=False)
    monkeypatch.setattr(gsm_ocr, "manual", False)
    monkeypatch.setattr(gsm_ocr, "manual_ocr_hotkey_combo", "<alt>+b")
    monkeypatch.setattr(gsm_ocr, "global_pause_hotkey", "ctrl+shift+p")
    monkeypatch.setattr(gsm_ocr, "furigana_filter_sensitivity", 0)
    monkeypatch.setattr(gsm_ocr, "ocr_result_callback", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(gsm_ocr, "get_ocr_scan_rate", lambda: 0.5)

    gsm_ocr.run_oneocr(None, [])

    assert captured["screen_capture_combo"] == ""


def test_run_oneocr_uses_manual_combo_in_manual_mode(monkeypatch):
    captured = {}

    monkeypatch.setattr(gsm_ocr.run, "init_config", lambda _parse_args: None)
    monkeypatch.setattr(gsm_ocr.run, "run", lambda **kwargs: captured.update(kwargs))

    monkeypatch.setattr(gsm_ocr, "obs_ocr", True)
    monkeypatch.setattr(gsm_ocr, "window", None)
    monkeypatch.setattr(gsm_ocr, "ss_clipboard", False, raising=False)
    monkeypatch.setattr(gsm_ocr, "ocr1", "alivetext", raising=False)
    monkeypatch.setattr(gsm_ocr, "ocr2", "alivetext", raising=False)
    monkeypatch.setattr(gsm_ocr, "manual", True)
    monkeypatch.setattr(gsm_ocr, "manual_ocr_hotkey_combo", "<alt>+b")
    monkeypatch.setattr(gsm_ocr, "global_pause_hotkey", "ctrl+shift+p")
    monkeypatch.setattr(gsm_ocr, "furigana_filter_sensitivity", 0)
    monkeypatch.setattr(gsm_ocr, "ocr_result_callback", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(gsm_ocr, "get_ocr_scan_rate", lambda: 0.5)

    gsm_ocr.run_oneocr(None, [])

    assert captured["screen_capture_combo"] == "<alt>+b"


def test_apply_ocr_config_to_image_supports_grayscale_masking():
    img = Image.new("L", (12, 12), color=255)
    config = SimpleNamespace(
        rectangles=[
            SimpleNamespace(
                coordinates=[0, 0, 3, 3], is_excluded=True, is_secondary=False
            ),
            SimpleNamespace(
                coordinates=[0, 0, 12, 12], is_excluded=False, is_secondary=False
            ),
        ]
    )

    processed, offset = run_module.apply_ocr_config_to_image(
        img,
        config,
        return_full_size=False,
    )

    assert processed.mode == "L"
    assert offset == (0, 0)
    assert processed.getpixel((0, 0)) == 0
    assert processed.getpixel((8, 8)) == 255


def test_ocr_processor_second_pass_suppresses_subset_chunk_duplicate(monkeypatch):
    sent = []
    saved = []
    full_text = (
        "ヤゴ：「荘厳」？あー・・・できる限りのことはしたつもりだ。大佐に相応しい式かと"
    )
    ctrl = SimpleNamespace(
        last_sent_result=full_text,
        last_ocr2_result=[
            "ヤゴ：「荘厳」？",
            "あー・・・できる限りのことはしたつもりだ。",
            "大佐に相応しい式かと",
        ],
    )

    monkeypatch.setattr(gsm_ocr, "TextFiltering", lambda lang: object())
    monkeypatch.setattr(gsm_ocr, "get_ocr_language", lambda: "ja")
    monkeypatch.setattr(gsm_ocr, "get_controller", lambda: ctrl)
    monkeypatch.setattr(gsm_ocr, "get_ocr_ocr2", lambda: "glens")
    monkeypatch.setattr(
        gsm_ocr, "capture_ocr_metrics_sample", lambda *args, **kwargs: None
    )
    monkeypatch.setattr(
        gsm_ocr, "save_result_image", lambda *args, **kwargs: saved.append(args)
    )

    async def _send_result(text, time, *, response_dict=None, source=None):
        sent.append(
            {
                "text": text,
                "time": time,
                "response_dict": response_dict,
                "source": source,
            }
        )

    monkeypatch.setattr(gsm_ocr, "send_result", _send_result)
    monkeypatch.setattr(
        gsm_ocr.run,
        "process_and_write_results",
        lambda *args, **kwargs: (["・「荘厳」？"], "・「荘厳」？", {"engine": "glens"}),
    )

    processor = gsm_ocr.OCRProcessor()
    processor.do_second_ocr(
        "",
        datetime(2026, 2, 22, 12, 0, 0),
        Image.new("RGB", (2, 2), color=255),
        filtering=None,
    )

    assert sent == []
    assert saved == []
    assert ctrl.last_sent_result == full_text


def test_websocket_server_buffers_until_first_client_connects():
    server = gsm_ocr.WebsocketServerThread(read=True)
    message = json.dumps({"sentence": "hello"})

    class FakeClient:
        def __init__(self):
            self.messages = []

        async def send(self, payload):
            self.messages.append(json.loads(payload))

    asyncio.run(server._queue_or_send_message(message))
    assert list(server._pending_messages) == [message]

    client = FakeClient()
    asyncio.run(server._register_client(client))

    assert client.messages == [{"sentence": "hello"}]
    assert list(server._pending_messages) == []

    server.clients.clear()
    asyncio.run(server._queue_or_send_message(json.dumps({"sentence": "later"})))
    assert list(server._pending_messages) == []
