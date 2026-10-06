import base64
import io
from types import SimpleNamespace

import pytest
from PIL import Image

from GameSentenceMiner.util.clients.anilist_api_client import AniListApiClient
from GameSentenceMiner.util.clients.vndb_api_client import VNDBApiClient
from GameSentenceMiner.util.shared import image_utils


@pytest.mark.parametrize("client", [VNDBApiClient, AniListApiClient])
def test_character_client_preserves_original_image_by_default(monkeypatch, client):
    buffer = io.BytesIO()
    Image.new("RGB", (380, 500), (120, 40, 80)).save(buffer, format="JPEG")
    raw = buffer.getvalue()
    monkeypatch.setattr(
        image_utils.requests, "get", lambda *_args, **_kwargs: SimpleNamespace(status_code=200, content=raw)
    )

    result = client.fetch_image_as_base64("https://example.com/portrait.jpg")
    assert base64.b64decode(result.split(",", 1)[1]) == raw

    thumbnail = client.fetch_image_as_base64("https://example.com/portrait.jpg", (80, 100))
    with Image.open(io.BytesIO(base64.b64decode(thumbnail.split(",", 1)[1]))) as image:
        assert image.size == (76, 100)


def test_anilist_character_uses_large_image(monkeypatch):
    fetched = []
    monkeypatch.setattr(AniListApiClient, "fetch_image_as_base64", lambda url: fetched.append(url) or "original")
    result = AniListApiClient.format_character_for_translation(
        {
            "role": "MAIN",
            "node": {
                "id": 1,
                "name": {"full": "Test", "native": "テスト"},
                "image": {"medium": "https://example.com/small.jpg", "large": "https://example.com/large.jpg"},
            },
        }
    )
    assert fetched == ["https://example.com/large.jpg"]
    assert result["image_url"] == "https://example.com/large.jpg"
    assert result["image_base64"] == "original"
