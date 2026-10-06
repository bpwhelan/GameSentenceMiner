import base64
import io
import json
import zipfile
from types import SimpleNamespace

import pytest
from PIL import Image

from GameSentenceMiner.util.yomitan_dict.dict_builder import YomitanDictBuilder


def test_get_score_uses_role_map():
    builder = YomitanDictBuilder(revision="1")
    assert builder._get_score("main") == 100
    assert builder._get_score("primary") == 75
    assert builder._get_score("unknown") == 0


def test_dictionary_recovers_original_for_legacy_thumbnail_and_caches_it(monkeypatch, tmp_path):
    from GameSentenceMiner.util.yomitan_dict import image_handler

    monkeypatch.setattr(image_handler, "get_app_directory", lambda: str(tmp_path))
    buffer = io.BytesIO()
    Image.new("RGB", (380, 500), (100, 30, 50)).save(buffer, format="JPEG")
    original = buffer.getvalue()
    buffer = io.BytesIO()
    Image.new("RGB", (76, 100)).save(buffer, format="JPEG")
    thumbnail = buffer.getvalue()
    downloads = []

    def fetch(url):
        downloads.append(url)
        return "data:image/jpeg;base64," + base64.b64encode(original).decode("ascii")

    monkeypatch.setattr(image_handler, "fetch_original_image_as_base64", fetch)
    character = {
        "id": "10490",
        "name_original": "桂",
        "image_url": "https://example.com/portrait.jpg",
        "image_base64": "data:image/jpeg;base64," + base64.b64encode(thumbnail).decode("ascii"),
    }
    for _ in range(2):
        builder = YomitanDictBuilder(revision="1")
        builder.add_character(character, "Game")
        with zipfile.ZipFile(io.BytesIO(builder.export_bytes())) as archive:
            assert archive.read("img/c10490.jpg") == original
            entries = json.loads(archive.read("term_bank_1.json"))
            image_content = next(item for item in entries[0][5][0]["content"] if item.get("tag") == "img")
            assert (image_content["width"], image_content["height"]) == (80, 100)
    assert downloads == [character["image_url"]]
    assert base64.b64decode(character["image_base64"].split(",", 1)[1]) == thumbnail


def test_dictionary_keeps_saved_thumbnail_when_original_download_fails(monkeypatch, tmp_path):
    from GameSentenceMiner.util.yomitan_dict import image_handler

    monkeypatch.setattr(image_handler, "get_app_directory", lambda: str(tmp_path))
    monkeypatch.setattr(image_handler, "fetch_original_image_as_base64", lambda _url: None)
    buffer = io.BytesIO()
    Image.new("RGB", (76, 100)).save(buffer, format="JPEG")
    thumbnail = buffer.getvalue()
    builder = YomitanDictBuilder(revision="1")
    builder.add_character(
        {
            "id": "1",
            "name_original": "桂",
            "image_url": "https://example.com/portrait.jpg",
            "image_base64": "data:image/jpeg;base64," + base64.b64encode(thumbnail).decode("ascii"),
        },
        "Game",
    )
    with zipfile.ZipFile(io.BytesIO(builder.export_bytes())) as archive:
        assert archive.read("img/c1.jpg") == thumbnail


def test_dictionary_preserves_saved_full_resolution_image_without_download(monkeypatch):
    from GameSentenceMiner.util.yomitan_dict import image_handler

    def unexpected_download(_url):
        pytest.fail("Full resolution images should not need another download")

    monkeypatch.setattr(image_handler, "fetch_original_image_as_base64", unexpected_download)
    buffer = io.BytesIO()
    Image.new("RGBA", (380, 500), (120, 40, 80, 100)).save(buffer, format="PNG")
    original = buffer.getvalue()
    builder = YomitanDictBuilder(revision="1")
    builder.add_character(
        {
            "id": "1",
            "name_original": "桂",
            "image_url": "https://example.com/portrait.png",
            "image_base64": "data:image/png;base64," + base64.b64encode(original).decode("ascii"),
        },
        "Game",
    )
    with zipfile.ZipFile(io.BytesIO(builder.export_bytes())) as archive:
        assert archive.read("img/c1.png") == original


def test_add_character_skips_empty_names():
    builder = YomitanDictBuilder(revision="1")
    builder.add_character({"id": "c1", "name_original": "", "name": ""}, "Game")
    assert builder.entries == []


def test_add_character_creates_entries_honorifics_aliases_and_image(monkeypatch):
    builder = YomitanDictBuilder(revision="1")

    monkeypatch.setattr(
        builder.name_parser,
        "generate_mixed_name_readings",
        lambda *_args, **_kwargs: {"full": "f", "family": "fa", "given": "gi"},
    )
    monkeypatch.setattr(
        builder.name_parser,
        "split_japanese_name",
        lambda *_args, **_kwargs: {
            "has_space": True,
            "original": "orig name",
            "combined": "origname",
            "family": "orig",
            "given": "name",
        },
    )
    builder.name_parser.HONORIFIC_SUFFIXES = [("-sfx", "-rsfx", "test suffix")]
    monkeypatch.setattr(
        builder.image_handler,
        "decode_image",
        lambda *_args, **_kwargs: ("c1.jpg", b"img"),
    )
    monkeypatch.setattr(
        builder.content_builder,
        "build_structured_content",
        lambda *_args, **_kwargs: {"ok": True},
    )
    monkeypatch.setattr(
        builder.content_builder,
        "create_term_entry",
        lambda term, reading, role, score, structured: [
            term,
            reading,
            role,
            score,
            structured,
        ],
    )

    builder.add_character(
        {
            "id": "c1",
            "name_original": "orig name",
            "name": "Roman Name",
            "role": "main",
            "aliases": ["alias", "orig"],
            "image_base64": "data:image/jpeg;base64,aGVsbG8=",
        },
        "GameTitle",
    )

    terms = [entry[0] for entry in builder.entries]
    assert "orig name" in terms
    assert "origname" in terms
    assert "orig" in terms
    assert "name" in terms
    assert "alias" in terms
    assert "orig-sfx" in terms
    assert "alias-sfx" in terms
    assert builder.tags == {"main"}
    assert builder.images["c1"] == ("c1.jpg", b"img")


def test_add_game_characters_handles_string_json_and_invalid():
    builder = YomitanDictBuilder(revision="1")
    calls = []
    builder.add_character = lambda char, title: calls.append((char["id"], title))

    valid = SimpleNamespace(
        vndb_character_data=json.dumps(
            {
                "characters": {
                    "main": [{"id": "1"}],
                    "primary": [{"id": "2"}],
                    "side": [],
                    "appears": [{"id": "3"}],
                }
            }
        ),
        title_original="JP",
        title_romaji="",
        title_english="",
    )
    count = builder.add_game_characters(valid)
    assert count == 3
    assert calls == [("1", "JP"), ("2", "JP"), ("3", "JP")]
    assert builder.game_titles == ["JP"]

    invalid = SimpleNamespace(
        vndb_character_data="{bad-json",
        title_original="",
        title_romaji="R",
        title_english="E",
    )
    assert builder.add_game_characters(invalid) == 0

    none_data = SimpleNamespace(vndb_character_data=None, title_original="", title_romaji="", title_english="")
    assert builder.add_game_characters(none_data) == 0


def test_create_index_includes_download_metadata():
    builder = YomitanDictBuilder(revision="2026.01.01", download_url="https://x/api/yomitan-dict", game_count=2)
    builder.game_titles = ["A", "B"]
    index = builder._create_index()
    assert index["title"] == "GSM Character Dictionary"
    assert index["revision"] == "2026.01.01"
    assert "A, B" in index["description"]
    assert index["downloadUrl"] == "https://x/api/yomitan-dict"
    assert index["indexUrl"] == "https://x/api/yomitan-index"
    assert index["isUpdatable"] is True


def test_export_bytes_writes_required_files():
    builder = YomitanDictBuilder(revision="1")
    builder.entries = [["term", "reading", "name", "", 0, [], 0, ""]]
    builder.images = {"1": ("c1.jpg", b"img-data")}

    payload = builder.export_bytes()

    with zipfile.ZipFile(io.BytesIO(payload), "r") as zf:
        names = set(zf.namelist())
        assert "index.json" in names
        assert "tag_bank_1.json" in names
        assert "term_bank_1.json" in names
        assert "img/c1.jpg" in names


def test_export_writes_file_to_disk(tmp_path):
    builder = YomitanDictBuilder(revision="1")
    builder.entries = []
    output = tmp_path / "dict.zip"

    result = builder.export(str(output))

    assert result == str(output)
    assert output.exists()
    assert output.stat().st_size > 0
