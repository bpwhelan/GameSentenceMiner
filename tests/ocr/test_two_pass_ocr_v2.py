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


def _image_with_light_capture_noise(text: str) -> Image.Image:
    img = _image_with_text(text)
    draw = ImageDraw.Draw(img)
    draw.rectangle((125, 20, 170, 42), fill=(248, 248, 248))
    return img


def _make_controller(
    sent: list[dict],
    calls: list[dict],
    responses: list[str],
    *,
    text_appears_instantly: bool = False,
) -> TwoPassOCRControllerV2:
    return TwoPassOCRControllerV2(
        config=TwoPassConfig(
            two_pass_enabled=True,
            ocr1_engine="meiki_text_detector",
            ocr2_engine="glens",
            text_appears_instantly=text_appears_instantly,
        ),
        filtering=_passthrough_filter,
        send_result=_make_send(sent),
        run_second_ocr=_make_second_ocr(calls, responses),
        save_image=lambda *a, **kw: None,
        get_ocr2_image=lambda coords, img, extra_padding=0: img.crop(coords) if coords else img,
    )


def _make_queued_controller(queued: list[dict]) -> TwoPassOCRControllerV2:
    def _queue_second_pass(
        ocr1_text,
        stable_time,
        img,
        filtering,
        pre_crop_image=None,
        ignore_furigana_filter=False,
        ignore_previous_result=False,
        image_metadata=None,
        response_dict=None,
        source="ocr",
    ):
        queued.append(
            {
                "ocr1_text": ocr1_text,
                "stable_time": stable_time,
                "img": img,
                "filtering": filtering,
                "pre_crop_image": pre_crop_image,
                "ignore_furigana_filter": ignore_furigana_filter,
                "ignore_previous_result": ignore_previous_result,
                "image_metadata": image_metadata,
                "response_dict": response_dict,
                "source": source,
            }
        )
        return True

    return TwoPassOCRControllerV2(
        config=TwoPassConfig(
            two_pass_enabled=True,
            ocr1_engine="meiki_text_detector",
            ocr2_engine="glens",
        ),
        filtering=_passthrough_filter,
        queue_second_pass=_queue_second_pass,
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


def test_v2_text_appears_instantly_runs_second_ocr_on_first_text_frame():
    sent: list[dict] = []
    calls: list[dict] = []
    ctrl = _make_controller(sent, calls, ["refined"], text_appears_instantly=True)
    text = "今日はいい天気ですね。"
    img = _image_with_text(text)

    ctrl.handle_ocr_result(text, [text], _make_time(0), img)

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


def test_v2_text_truncated_same_line_waits_for_blank_flush():
    queued: list[dict] = []
    ctrl = _make_queued_controller(queued)

    full = "「はやい、はやい」みすず"
    truncated = "はやい、はやい」"
    ctrl.handle_ocr_result(full, [full], _make_time(0), _image_with_text(full))
    ctrl.handle_ocr_result(truncated, [truncated], _make_time(1), _image_with_text(full))

    assert queued == []

    ctrl.handle_ocr_result("", [], _make_time(2), _image_with_text(""))
    assert len(queued) == 1
    assert queued[0]["ocr1_text"] == full


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


def test_v2_detector_same_coords_ignores_minor_capture_noise():
    sent: list[dict] = []
    calls: list[dict] = []
    ctrl = _make_controller(sent, calls, ["first-refined", "unexpected-repeat"])
    coords = (10, 10, 180, 60)

    first_img = _image_with_text("first")
    ctrl.handle_ocr_result("", [], _make_time(0), first_img, detection_boxes=[{"box": coords}], crop_coords=coords)
    ctrl.handle_ocr_result("", [], _make_time(1), first_img, detection_boxes=[{"box": coords}], crop_coords=coords)

    noisy_img = _image_with_light_capture_noise("first")
    ctrl.handle_ocr_result("", [], _make_time(2), noisy_img, detection_boxes=[{"box": coords}], crop_coords=coords)
    ctrl.handle_ocr_result("", [], _make_time(3), noisy_img, detection_boxes=[{"box": coords}], crop_coords=coords)

    assert len(calls) == 1
    assert [item["text"] for item in sent] == ["first-refined"]


def test_v2_detector_same_crop_not_requeued_while_lens_in_flight():
    queued: list[dict] = []
    ctrl = _make_queued_controller(queued)
    coords = (10, 10, 180, 60)

    first_img = _image_with_text("first")
    ctrl.handle_ocr_result("", [], _make_time(0), first_img, detection_boxes=[{"box": coords}], crop_coords=coords)
    ctrl.handle_ocr_result("", [], _make_time(1), first_img, detection_boxes=[{"box": coords}], crop_coords=coords)

    changed_img = _image_with_text("second")
    ctrl.handle_ocr_result("", [], _make_time(2), changed_img, detection_boxes=[{"box": coords}], crop_coords=coords)
    ctrl.handle_ocr_result("", [], _make_time(3), changed_img, detection_boxes=[{"box": coords}], crop_coords=coords)

    assert len(queued) == 1


def test_v2_detector_completion_allows_changed_same_crop_to_requeue():
    queued: list[dict] = []
    ctrl = _make_queued_controller(queued)
    coords = (10, 10, 180, 60)

    first_img = _image_with_text("first")
    ctrl.handle_ocr_result("", [], _make_time(0), first_img, detection_boxes=[{"box": coords}], crop_coords=coords)
    ctrl.handle_ocr_result("", [], _make_time(1), first_img, detection_boxes=[{"box": coords}], crop_coords=coords)
    ctrl.mark_v2_detection_ocr2_complete(coords, duplicate=False)

    changed_img = _image_with_text("second")
    ctrl.handle_ocr_result("", [], _make_time(2), changed_img, detection_boxes=[{"box": coords}], crop_coords=coords)
    ctrl.handle_ocr_result("", [], _make_time(3), changed_img, detection_boxes=[{"box": coords}], crop_coords=coords)

    assert len(queued) == 2


def test_v2_detector_duplicate_latches_same_crop_until_box_disappears():
    queued: list[dict] = []
    ctrl = _make_queued_controller(queued)
    coords = (10, 10, 180, 60)

    img = _image_with_text("first")
    ctrl.handle_ocr_result("", [], _make_time(0), img, detection_boxes=[{"box": coords}], crop_coords=coords)
    ctrl.handle_ocr_result("", [], _make_time(1), img, detection_boxes=[{"box": coords}], crop_coords=coords)
    ctrl.mark_v2_detection_ocr2_complete(coords, duplicate=True)

    noisy_img = _image_with_light_capture_noise("first")
    ctrl.handle_ocr_result("", [], _make_time(2), noisy_img, detection_boxes=[{"box": coords}], crop_coords=coords)
    ctrl.handle_ocr_result("", [], _make_time(3), noisy_img, detection_boxes=[{"box": coords}], crop_coords=coords)
    assert len(queued) == 1

    ctrl.handle_ocr_result("", [], _make_time(4), img, detection_boxes=[], crop_coords=None)
    ctrl.handle_ocr_result("", [], _make_time(5), img, detection_boxes=[{"box": coords}], crop_coords=coords)
    ctrl.handle_ocr_result("", [], _make_time(6), img, detection_boxes=[{"box": coords}], crop_coords=coords)

    assert len(queued) == 2


def test_v2_text_appears_instantly_detector_runs_second_ocr_on_first_box():
    sent: list[dict] = []
    calls: list[dict] = []
    ctrl = _make_controller(sent, calls, ["first-refined"], text_appears_instantly=True)
    coords = (10, 10, 180, 60)
    img = _image_with_text("first")

    ctrl.handle_ocr_result("", [], _make_time(0), img, detection_boxes=[{"box": coords}], crop_coords=coords)

    assert len(calls) == 1
    assert [item["text"] for item in sent] == ["first-refined"]
