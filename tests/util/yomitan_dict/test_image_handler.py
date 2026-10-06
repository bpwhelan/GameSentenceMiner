import base64
import hashlib
import io
from pathlib import Path

import pytest
from PIL import Image

from GameSentenceMiner.util.yomitan_dict import image_handler
from GameSentenceMiner.util.yomitan_dict.image_handler import ImageHandler


@pytest.mark.parametrize("cache_writable", [True, False])
def test_recover_missing_image_and_ignore_corrupt_or_unwritable_cache(monkeypatch, tmp_path, cache_writable):
    monkeypatch.setattr(image_handler, "get_app_directory", lambda: str(tmp_path))
    url = "https://example.com/portrait.png"
    cache_path = tmp_path / "cache" / "character_images" / f"{hashlib.sha256(url.encode()).hexdigest()}.data-uri"
    cache_path.parent.mkdir(parents=True)
    cache_path.write_text("data:image/png;base64,broken", encoding="ascii")
    if not cache_writable:

        def fail_write(*_args, **_kwargs):
            raise OSError("read only")

        monkeypatch.setattr(Path, "write_text", fail_write)
    buffer = io.BytesIO()
    Image.new("RGB", (380, 500)).save(buffer, format="PNG")
    raw = buffer.getvalue()
    data_uri = "data:image/png;base64," + base64.b64encode(raw).decode("ascii")
    monkeypatch.setattr(image_handler, "fetch_original_image_as_base64", lambda _url: data_uri)

    assert ImageHandler().get_character_image({"id": "42", "image_url": url}) == ("c42.png", raw)
    if cache_writable:
        assert cache_path.read_text(encoding="ascii") == data_uri


def test_decode_image_with_data_uri_png():
    handler = ImageHandler()
    raw = b"hello-image"
    encoded = base64.b64encode(raw).decode("ascii")
    filename, payload = handler.decode_image(f"data:image/png;base64,{encoded}", "42")
    assert filename == "c42.png"
    assert payload == raw


def test_decode_image_without_header_defaults_to_jpg():
    handler = ImageHandler()
    raw = b"data"
    encoded = base64.b64encode(raw).decode("ascii")
    filename, payload = handler.decode_image(encoded, "99")
    assert filename == "c99.jpg"
    assert payload == raw


def test_create_image_content_returns_expected_shape():
    handler = ImageHandler()
    content = handler.create_image_content("img/c1.jpg")
    assert content["tag"] == "img"
    assert content["path"] == "img/c1.jpg"
    assert content["width"] == 80
    assert content["height"] == 100


def test_validate_image_accepts_valid_base64_and_rejects_invalid():
    handler = ImageHandler()
    assert handler.validate_image(base64.b64encode(b"ok").decode("ascii")) is True
    assert handler.validate_image("not-base64***") is False
    assert handler.validate_image("") is False
