from types import SimpleNamespace

import GameSentenceMiner.obs as obs_module


class _ExplodingImage:
    def getextrema(self):
        raise AssertionError("image validation should have been skipped")


class _UniformImage:
    def getextrema(self):
        return (7, 7)


class _NonUniformImage:
    def getextrema(self):
        return (0, 255)


def test_get_screenshot_pil_skips_validation_for_helper_scene(monkeypatch):
    helper_image = _ExplodingImage()
    fallback_image = _NonUniformImage()
    warning_calls = []

    monkeypatch.setattr(
        obs_module,
        "get_active_video_sources",
        lambda: [
            {"sourceName": "some_helper_capture", "inputKind": "window_capture"},
            {"sourceName": "fallback_capture", "inputKind": "game_capture"},
        ],
    )
    monkeypatch.setattr(
        obs_module,
        "get_screenshot_PIL_from_source",
        lambda source_name, *_args, **_kwargs: helper_image if source_name == "some_helper_capture" else fallback_image,
    )
    monkeypatch.setattr(obs_module, "_apply_ocr_preprocessing", lambda img, **_kwargs: img)
    monkeypatch.setattr(obs_module.gsm_state, "current_game", "GSM Helper - DONT TOUCH", raising=False)
    monkeypatch.setattr(obs_module, "obs_service", None)
    monkeypatch.setattr(obs_module.logger, "warning", lambda message: warning_calls.append(message))

    result = obs_module.get_screenshot_PIL()

    assert result is helper_image
    assert warning_calls == []


def test_get_screenshot_pil_skips_validation_for_helper_sources(monkeypatch):
    helper_image = _ExplodingImage()
    fallback_image = _NonUniformImage()
    warning_calls = []

    monkeypatch.setattr(
        obs_module,
        "get_active_video_sources",
        lambda: [
            {"sourceName": "window_getter", "inputKind": "window_capture"},
            {"sourceName": "fallback_capture", "inputKind": "game_capture"},
        ],
    )
    monkeypatch.setattr(
        obs_module,
        "get_screenshot_PIL_from_source",
        lambda source_name, *_args, **_kwargs: helper_image if source_name == "window_getter" else fallback_image,
    )
    monkeypatch.setattr(obs_module, "_apply_ocr_preprocessing", lambda img, **_kwargs: img)
    monkeypatch.setattr(obs_module.gsm_state, "current_game", "Regular Scene", raising=False)
    monkeypatch.setattr(
        obs_module, "obs_service", SimpleNamespace(state=SimpleNamespace(current_scene="Regular Scene"))
    )
    monkeypatch.setattr(obs_module.logger, "warning", lambda message: warning_calls.append(message))

    result = obs_module.get_screenshot_PIL()

    assert result is helper_image
    assert warning_calls == []


def test_get_screenshot_pil_keeps_validation_for_regular_sources(monkeypatch):
    uniform_image = _UniformImage()
    valid_image = _NonUniformImage()

    monkeypatch.setattr(
        obs_module,
        "get_active_video_sources",
        lambda: [
            {"sourceName": "blank_capture", "inputKind": "window_capture"},
            {"sourceName": "game_capture", "inputKind": "game_capture"},
        ],
    )
    monkeypatch.setattr(
        obs_module,
        "get_screenshot_PIL_from_source",
        lambda source_name, *_args, **_kwargs: uniform_image if source_name == "blank_capture" else valid_image,
    )
    monkeypatch.setattr(obs_module, "_apply_ocr_preprocessing", lambda img, **_kwargs: img)
    monkeypatch.setattr(obs_module.gsm_state, "current_game", "Regular Scene", raising=False)
    monkeypatch.setattr(
        obs_module, "obs_service", SimpleNamespace(state=SimpleNamespace(current_scene="Regular Scene"))
    )

    result = obs_module.get_screenshot_PIL()

    assert result is valid_image
