import base64
import io

import pytest
from PIL import Image

from GameSentenceMiner.util.shared import image_utils


def _image_bytes(mode="RGB", size=(10, 10), fmt="PNG", color=(10, 20, 30)):
    image = Image.new(mode, size, color)
    buffer = io.BytesIO()
    image.save(buffer, format=fmt)
    return buffer.getvalue()


@pytest.mark.parametrize("fmt,mime", [("JPEG", "jpeg"), ("PNG", "png"), ("GIF", "gif"), ("WEBP", "webp")])
def test_fetch_original_image_preserves_bytes_and_resolution(monkeypatch, fmt, mime):
    raw = _image_bytes(size=(380, 500), fmt=fmt)
    response = type("Response", (), {"status_code": 200, "content": raw})()
    monkeypatch.setattr(image_utils.requests, "get", lambda *_args, **_kwargs: response)

    result = image_utils.fetch_original_image_as_base64("https://example.com/portrait")

    assert result.startswith(f"data:image/{mime};base64,")
    assert base64.b64decode(result.split(",", 1)[1]) == raw


def test_fetch_original_image_preserves_transparency(monkeypatch):
    raw = _image_bytes(mode="RGBA", size=(380, 500), color=(10, 20, 30, 0))
    response = type("Response", (), {"status_code": 200, "content": raw})()
    monkeypatch.setattr(image_utils.requests, "get", lambda *_args, **_kwargs: response)
    result = image_utils.fetch_original_image_as_base64("https://example.com/portrait.png")
    assert base64.b64decode(result.split(",", 1)[1]) == raw


def test_fetch_original_image_converts_other_formats_without_losing_resolution(monkeypatch):
    raw = _image_bytes(size=(380, 500), fmt="BMP")
    response = type("Response", (), {"status_code": 200, "content": raw})()
    monkeypatch.setattr(image_utils.requests, "get", lambda *_args, **_kwargs: response)
    result = image_utils.fetch_original_image_as_base64("https://example.com/portrait.bmp")
    assert result.startswith("data:image/png;base64,")
    with Image.open(io.BytesIO(base64.b64decode(result.split(",", 1)[1]))) as image:
        assert image.size == (380, 500)
        assert image.getpixel((0, 0)) == (10, 20, 30, 255)


@pytest.mark.parametrize("status,content", [(404, b""), (200, b"not an image")])
def test_fetch_original_image_handles_failed_downloads(monkeypatch, status, content):
    response = type("Response", (), {"status_code": status, "content": content})()
    monkeypatch.setattr(image_utils.requests, "get", lambda *_args, **_kwargs: response)
    assert image_utils.fetch_original_image_as_base64("https://example.com/portrait") is None


def test_fetch_original_image_handles_request_exception(monkeypatch):
    def fail(*_args, **_kwargs):
        raise image_utils.requests.RequestException("offline")

    monkeypatch.setattr(image_utils.requests, "get", fail)
    assert image_utils.fetch_original_image_as_base64("https://example.com/portrait") is None
    assert image_utils.fetch_original_image_as_base64("") is None


def test_convert_image_to_rgb_returns_same_object_for_rgb():
    image = Image.new("RGB", (2, 2), (1, 2, 3))
    converted = image_utils.convert_image_to_rgb(image)
    assert converted is image
    assert converted.mode == "RGB"


def test_convert_image_to_rgb_handles_rgba_transparency():
    image = Image.new("RGBA", (1, 1), (255, 0, 0, 0))
    converted = image_utils.convert_image_to_rgb(image)
    assert converted.mode == "RGB"
    assert converted.getpixel((0, 0)) == (255, 255, 255)


def test_resize_image_if_needed_returns_original_when_within_limits():
    data = _image_bytes(size=(20, 20), fmt="PNG")
    resized = image_utils.resize_image_if_needed(data, max_width=100, max_height=100)
    assert resized == data


def test_resize_image_if_needed_resizes_large_image():
    data = _image_bytes(size=(400, 300), fmt="PNG")
    resized = image_utils.resize_image_if_needed(data, max_width=100, max_height=100)
    image = Image.open(io.BytesIO(resized))
    assert image.width <= 100
    assert image.height <= 100


def test_fetch_image_as_base64_returns_none_for_empty_url():
    assert image_utils.fetch_image_as_base64("") is None


def test_fetch_image_as_base64_handles_non_200(monkeypatch):
    class Response:
        status_code = 404
        content = b""

    monkeypatch.setattr(image_utils.requests, "get", lambda *_args, **_kwargs: Response())
    assert image_utils.fetch_image_as_base64("https://example.com/a.png") is None


def test_fetch_image_as_base64_converts_and_encodes(monkeypatch):
    class Response:
        status_code = 200
        content = _image_bytes(mode="RGBA", size=(200, 120), fmt="PNG", color=(0, 0, 0, 0))

    monkeypatch.setattr(image_utils.requests, "get", lambda *_args, **_kwargs: Response())
    result = image_utils.fetch_image_as_base64("https://example.com/img.png", thumbnail_size=(40, 40))
    assert result is not None
    assert result.startswith("data:image/jpeg;base64,")

    encoded = result.split(",", 1)[1]
    decoded = base64.b64decode(encoded)
    image = Image.open(io.BytesIO(decoded))
    assert image.width <= 40
    assert image.height <= 40


def test_fetch_image_as_base64_unsupported_format_falls_back_to_jpeg(monkeypatch):
    class Response:
        status_code = 200
        content = _image_bytes(mode="RGB", size=(20, 20), fmt="PNG")

    monkeypatch.setattr(image_utils.requests, "get", lambda *_args, **_kwargs: Response())
    result = image_utils.fetch_image_as_base64("x", output_format="TIFF")
    assert result is not None
    assert result.startswith("data:image/jpeg;base64,")


def test_fetch_image_as_base64_handles_request_exception(monkeypatch):
    def raise_request_error(*_args, **_kwargs):
        raise image_utils.requests.RequestException("network")

    monkeypatch.setattr(image_utils.requests, "get", raise_request_error)
    assert image_utils.fetch_image_as_base64("https://example.com") is None


def test_download_cover_image_returns_none_for_empty_url():
    assert image_utils.download_cover_image("") is None


def test_download_cover_image_encodes_png(monkeypatch):
    class Response:
        status_code = 200
        content = _image_bytes(mode="RGB", size=(800, 600), fmt="JPEG")

    monkeypatch.setattr(image_utils.requests, "get", lambda *_args, **_kwargs: Response())
    result = image_utils.download_cover_image("https://example.com/cover.jpg", cover_size=(90, 90))
    assert result is not None
    assert result.startswith("data:image/png;base64,")


def test_download_cover_image_handles_bad_status(monkeypatch):
    class Response:
        status_code = 500
        content = b""

    monkeypatch.setattr(image_utils.requests, "get", lambda *_args, **_kwargs: Response())
    assert image_utils.download_cover_image("https://example.com") is None


def test_download_cover_image_unsupported_format_defaults_to_png(monkeypatch):
    class Response:
        status_code = 200
        content = _image_bytes(mode="RGB", size=(20, 20), fmt="JPEG")

    monkeypatch.setattr(image_utils.requests, "get", lambda *_args, **_kwargs: Response())
    result = image_utils.download_cover_image("https://example.com", output_format="BMP")
    assert result.startswith("data:image/png;base64,")


def test_download_cover_image_handles_request_exception(monkeypatch):
    def raise_request_error(*_args, **_kwargs):
        raise image_utils.requests.RequestException("timeout")

    monkeypatch.setattr(image_utils.requests, "get", raise_request_error)
    assert image_utils.download_cover_image("https://example.com") is None


def test_resize_image_if_needed_raises_for_invalid_data():
    with pytest.raises(Exception):
        image_utils.resize_image_if_needed(b"not-an-image", 10, 10)
