import asyncio
from types import SimpleNamespace

from GameSentenceMiner.util import text_log
from GameSentenceMiner.util.overlay import get_overlay_coords


def test_do_work_sends_recycled_status_at_start_of_overlay_work(monkeypatch):
    processor = get_overlay_coords.OverlayProcessor()
    sent_messages = []
    ordered_steps = []

    async def fake_try_send_precomputed_overlay_payload(*_args, **_kwargs):
        ordered_steps.append("precomputed_payload")
        return True

    monkeypatch.setattr(text_log.game_log, "previous_lines", {"HelloWorld"})
    monkeypatch.setattr(get_overlay_coords, "is_recycled_line_detection_enabled", lambda: True)
    monkeypatch.setattr(processor, "_get_effective_engine", lambda: "oneocr")
    monkeypatch.setattr(processor, "_is_use_ocr_result_enabled", lambda: True)
    monkeypatch.setattr(processor, "_try_send_precomputed_overlay_payload", fake_try_send_precomputed_overlay_payload)
    monkeypatch.setattr(
        get_overlay_coords,
        "websocket_manager",
        SimpleNamespace(
            has_clients=lambda server_id: server_id == get_overlay_coords.ID_OVERLAY,
            send_nowait=lambda server_id, payload: (
                ordered_steps.append("send_recycled_status"),
                sent_messages.append((server_id, payload)),
            )[-1],
        ),
    )

    asyncio.run(
        processor._do_work(
            line=SimpleNamespace(id="line-1", text="Hello, World!"),
            dict_from_ocr={"schema": "gsm_overlay_coords_v1"},
        )
    )

    assert sent_messages == [
        (
            get_overlay_coords.ID_OVERLAY,
            {
                "type": "sentence_recycled_status",
                "line_id": "line-1",
                "sentence": "Hello, World!",
                "is_sentence_recycled": True,
            },
        )
    ]
    assert ordered_steps == ["send_recycled_status", "precomputed_payload"]
