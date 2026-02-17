from GameSentenceMiner.util.shared import base_api_client


class DummyClient(base_api_client.BaseApiClient):
    def search_game(self, query: str, **kwargs):
        return {"query": query, "kwargs": kwargs}

    def get_game_details(self, game_id: str, **kwargs):
        return {"id": game_id, "kwargs": kwargs}

    def get_characters(self, game_id: str, **kwargs):
        return [{"id": game_id, "kwargs": kwargs}]


def test_fetch_image_as_base64_delegates_to_shared_utility(monkeypatch):
    captured = {}

    def fake_fetch(**kwargs):
        captured.update(kwargs)
        return "ok"

    monkeypatch.setattr(base_api_client, "_fetch_image_as_base64", fake_fetch)
    result = DummyClient.fetch_image_as_base64("https://example.com/img.png")

    assert result == "ok"
    assert captured["image_url"] == "https://example.com/img.png"
    assert captured["timeout"] == DummyClient.TIMEOUT
    assert captured["thumbnail_size"] == DummyClient.THUMBNAIL_SIZE
    assert captured["output_format"] == "JPEG"


def test_download_cover_image_from_url_delegates_to_shared_utility(monkeypatch):
    captured = {}

    def fake_download(**kwargs):
        captured.update(kwargs)
        return "cover"

    monkeypatch.setattr(base_api_client, "_download_cover_image", fake_download)
    result = DummyClient.download_cover_image_from_url("https://example.com/cover.jpg")

    assert result == "cover"
    assert captured["image_url"] == "https://example.com/cover.jpg"
    assert captured["timeout"] == DummyClient.TIMEOUT
    assert captured["cover_size"] == DummyClient.COVER_IMAGE_SIZE
    assert captured["output_format"] == "PNG"


def test_create_translation_context_builds_role_sections_and_truncates_description():
    long_desc = "x" * 250
    data = {
        "media_type": "VN",
        "vn_id": "v123",
        "characters": {
            "main": [
                {
                    "name": "Alice",
                    "name_original": "Arisu",
                    "sex": "f",
                    "age": 17,
                    "personality": ["kind", "smart"],
                    "roles": ["hero"],
                    "description": long_desc,
                }
            ],
            "side": [{"name": "Bob"}],
        },
    }

    text = DummyClient.create_translation_context(data)

    assert "# Character Reference for VN v123" in text
    assert "## Protagonist" in text
    assert "- Alice (Arisu): f; age 17; personality: kind, smart; role: hero" in text
    assert "Description: " in text
    assert "..." in text
    assert "## Side Characters" in text
    assert "- Bob" in text


def test_create_translation_context_uses_defaults_for_missing_identifier():
    text = DummyClient.create_translation_context({"characters": {}})
    assert "# Character Reference for Unknown" in text


def test_log_request_and_response_use_expected_levels(monkeypatch):
    calls = []

    class FakeLogger:
        def debug(self, message):
            calls.append(("debug", message))

        def info(self, message):
            calls.append(("info", message))

        def warning(self, message):
            calls.append(("warning", message))

    monkeypatch.setattr(base_api_client, "logger", FakeLogger())

    DummyClient.log_request("/search", {"q": "abc"})
    DummyClient.log_response("/search", success=True, details="ok")
    DummyClient.log_response("/search", success=False, details="bad")

    assert calls[0][0] == "debug"
    assert "/search" in calls[0][1]
    assert calls[1][0] == "info"
    assert "succeeded" in calls[1][1]
    assert calls[2][0] == "warning"
    assert "failed" in calls[2][1]
