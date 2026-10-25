from datetime import datetime, timedelta
from unittest.mock import Mock

import pytest
from PIL import Image

from GameSentenceMiner.ocr.gsm_ocr import TwoPassConfig, TwoPassOCRController, TwoPassOCRControllerV2


@pytest.mark.parametrize("controller_class", [TwoPassOCRController, TwoPassOCRControllerV2])
@pytest.mark.parametrize("instant", [False, True])
def test_same_engine_flush_preserves_raw_text_and_geometry_without_scanning(controller_class, instant):
    send, scan, queue, crop, save = Mock(), Mock(), Mock(), Mock(), Mock()
    raw = "「今日は晴れですね。」\n「明日も晴れるかな？」"
    chunks = ["「今日は晴れですね。」", "「明日も晴れるかな？」"]
    filtering = Mock(return_value=(raw, chunks))
    controller = controller_class(
        TwoPassConfig(
            ocr1_engine="screenai", ocr2_engine="screenai", text_appears_instantly=instant, keep_newline=True
        ),
        filtering=filtering,
        send_result=send,
        run_second_ocr=scan,
        queue_second_pass=queue,
        get_ocr2_image=crop,
        save_image=save,
    )
    image = Image.new("RGB", (200, 80))
    payload = {"engine": "screenai", "lines": [{"text": raw}]}
    timestamp = datetime(2026, 10, 5)  # noqa: DTZ001 -- Capture timestamps use local naive datetimes.
    for offset in range(2):
        controller.handle_ocr_result(
            "明日も晴れるかな",
            chunks,
            timestamp + timedelta(seconds=offset),
            image,
            raw_text=raw,
            response_dict=payload,
            source="ocr",
        )
    # The legacy controller flushes on disappearance; V2 flushes on stability.
    controller.handle_ocr_result("", [], timestamp + timedelta(seconds=2), image, response_dict={"lines": []})
    filtering.assert_called_once_with(raw, [], engine="screenai", is_second_ocr=True)
    send.assert_called_once_with(raw, timestamp, response_dict=payload, source="ocr")
    scan.assert_not_called()
    queue.assert_not_called()
    crop.assert_not_called()
    save.assert_called_once_with(image)
    assert controller.last_ocr2_result == chunks


def test_v2_same_engine_delivers_on_stability_even_when_ocr1_history_removed_text():
    send, scan, queue = Mock(), Mock(), Mock()
    raw = "一度だけ安定した文章を出力します。"
    controller = TwoPassOCRControllerV2(
        TwoPassConfig(ocr1_engine="screenai", ocr2_engine="screenai"),
        filtering=lambda text, last_result, **kwargs: (text, [text]),
        send_result=send,
        run_second_ocr=scan,
        queue_second_pass=queue,
    )
    for text in [raw, "", "", ""]:
        controller.handle_ocr_result(text, [raw], raw_text=raw)
    send.assert_called_once()
    assert send.call_args.args[0] == raw
    scan.assert_not_called()
    queue.assert_not_called()


def test_bypass_respects_filter_suppression_instead_of_restoring_raw_duplicates():
    send, scan = Mock(), Mock()
    controller = TwoPassOCRControllerV2(
        TwoPassConfig(ocr1_engine="screenai", ocr2_engine="screenai"),
        filtering=lambda *args, **kwargs: ("", ["前の文章"]),
        send_result=send,
        run_second_ocr=scan,
    )
    for _ in range(3):
        controller.handle_ocr_result("前の文章", ["前の文章"], raw_text="前の文章")
    send.assert_not_called()
    scan.assert_not_called()


@pytest.mark.parametrize(
    "language,raw",
    [
        ("ja", "「これは、新しい文章です。」\n「はい、そうですね！」"),
        ("en", "This is a complete sentence.\nHere is another one!"),
    ],
)
def test_real_filter_delivers_stable_text_despite_first_pass_history(monkeypatch, language, raw):
    from GameSentenceMiner.owocr.owocr import ocr_runtime

    monkeypatch.setattr(ocr_runtime, "get_ocr_language", lambda: language)
    filtering = ocr_runtime.TextFiltering(lang=language)
    send = Mock()
    controller = TwoPassOCRControllerV2(
        TwoPassConfig(ocr1_engine="screenai", ocr2_engine="screenai", language=language, keep_newline=True),
        filtering=filtering,
        send_result=send,
    )
    for _ in range(4):
        filtered, chunks = filtering(raw, [], engine="screenai")
        controller.handle_ocr_result(filtered, chunks, raw_text=raw)
    send.assert_called_once()
    assert send.call_args.args[0] == raw
