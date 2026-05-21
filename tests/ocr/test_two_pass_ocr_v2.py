from __future__ import annotations

from datetime import datetime, timedelta

from PIL import Image, ImageDraw

from GameSentenceMiner.ocr.gsm_ocr import SecondPassResult, TwoPassConfig, TwoPassOCRControllerV2


def _make_time(offset_sec: int = 0) -> datetime:
    return datetime(2026, 2, 22, 12, 0, 0) + timedelta(seconds=offset_sec)


def _make_send(sent: list[dict]):
    def _send(text, time, *, response_dict=None, source=None):
        sent.append(
            {
                "text": text,
                "time": time,
                "response_dict": response_dict,
                "source": source,
            }
        )

    return _send


def _make_second_ocr(calls: list[dict], responses: list[str]):
    def _run(img, last_result, filtering, engine, **kw):
        calls.append(
            {
                "img": img,
                "last_result": last_result,
                "filtering": filtering,
                "engine": engine,
                **kw,
            }
        )
        response = responses[min(len(calls) - 1, len(responses) - 1)]
        return SecondPassResult(text=response, orig_text=[response], response_dict={"engine": engine})

    return _run


def _passthrough_filter(text, last_result, *, engine=None, is_second_ocr=False):
    return text, [text] if text else []


def _image_with_text(text: str) -> Image.Image:
    img = Image.new("RGB", (240, 80), "white")
    draw = ImageDraw.Draw(img)
    draw.text((20, 25), text, fill="black")
    return img


def _make_controller(sent: list[dict], calls: list[dict], responses: list[str]) -> TwoPassOCRControllerV2:
    return TwoPassOCRControllerV2(
        config=TwoPassConfig(two_pass_enabled=True, ocr1_engine="meiki_text_detector", ocr2_engine="glens"),
        filtering=_passthrough_filter,
        send_result=_make_send(sent),
        run_second_ocr=_make_second_ocr(calls, responses),
        save_image=lambda *a, **kw: None,
        get_ocr2_image=lambda coords, img, extra_padding=0: img.crop(coords) if coords else img,
    )


def test_v2_text_stability_runs_second_ocr_before_text_disappears():
    sent: list[dict] = []
    calls: list[dict] = []
    ctrl = _make_controller(sent, calls, ["refined"])
    text = "今日はいい天気ですね。"
    img = _image_with_text(text)

    ctrl.handle_ocr_result(text, [text], _make_time(0), img)
    ctrl.handle_ocr_result(text, [text], _make_time(1), img)

    assert len(calls) == 1
    assert [item["text"] for item in sent] == ["refined"]


def test_v2_text_growth_waits_for_final_stable_frame():
    sent: list[dict] = []
    calls: list[dict] = []
    ctrl = _make_controller(sent, calls, ["refined-full"])

    ctrl.handle_ocr_result("今日は", ["今日は"], _make_time(0), _image_with_text("今日は"))
    ctrl.handle_ocr_result("今日はいい天気", ["今日はいい天気"], _make_time(1), _image_with_text("今日はいい天気"))
    assert calls == []

    full = "今日はいい天気ですね。"
    img = _image_with_text(full)
    ctrl.handle_ocr_result(full, [full], _make_time(2), img)
    ctrl.handle_ocr_result(full, [full], _make_time(3), img)

    assert len(calls) == 1
    assert [item["text"] for item in sent] == ["refined-full"]


def test_v2_detector_same_coords_reocr_when_cropped_pixels_change():
    sent: list[dict] = []
    calls: list[dict] = []
    ctrl = _make_controller(sent, calls, ["first-refined", "second-refined"])
    coords = (10, 10, 180, 60)

    first_img = _image_with_text("first")
    ctrl.handle_ocr_result("", [], _make_time(0), first_img, detection_boxes=[{"box": coords}], crop_coords=coords)
    ctrl.handle_ocr_result("", [], _make_time(1), first_img, detection_boxes=[{"box": coords}], crop_coords=coords)
    ctrl.handle_ocr_result("", [], _make_time(2), first_img, detection_boxes=[{"box": coords}], crop_coords=coords)
    ctrl.handle_ocr_result("", [], _make_time(3), first_img, detection_boxes=[{"box": coords}], crop_coords=coords)

    second_img = _image_with_text("second")
    ctrl.handle_ocr_result("", [], _make_time(4), second_img, detection_boxes=[{"box": coords}], crop_coords=coords)
    ctrl.handle_ocr_result("", [], _make_time(5), second_img, detection_boxes=[{"box": coords}], crop_coords=coords)

    assert len(calls) == 2
    assert [item["text"] for item in sent] == ["first-refined", "second-refined"]
