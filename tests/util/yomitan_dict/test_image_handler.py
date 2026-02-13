import base64

from GameSentenceMiner.util.yomitan_dict.image_handler import ImageHandler


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
