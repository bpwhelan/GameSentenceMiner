"""Tests for the Yomitan frequency dictionary API endpoints."""

from __future__ import annotations

import json
import zipfile
import io
from unittest.mock import patch, MagicMock

import flask
import pytest

from GameSentenceMiner.util.database.db import SQLiteDB, GameLinesTable
from GameSentenceMiner.util.database.games_table import GamesTable


@pytest.fixture(autouse=True)
def _in_memory_db():
    original_games_db = GamesTable._db
    original_lines_db = GameLinesTable._db
    db = SQLiteDB(":memory:")
    GamesTable.set_db(db)
    GameLinesTable.set_db(db)
    yield db
    db.close()
    # Restore the original database references so later tests aren't broken.
    GamesTable._db = original_games_db
    GameLinesTable._db = original_lines_db


@pytest.fixture
def app(_in_memory_db):
    test_app = flask.Flask(__name__)
    test_app.config["TESTING"] = True
    from GameSentenceMiner.web.yomitan_api import register_yomitan_api_routes

    register_yomitan_api_routes(test_app)
    return test_app


@pytest.fixture
def client(app):
    return app.test_client()


@pytest.fixture
def enabled_config():
    with patch(
        "GameSentenceMiner.web.yomitan_api.is_tokenization_enabled",
        return_value=True,
    ):
        yield


@pytest.fixture
def disabled_config():
    with patch(
        "GameSentenceMiner.web.yomitan_api.is_tokenization_enabled",
        return_value=False,
    ):
        yield


def _mock_config(port=9000):
    cfg = MagicMock()
    cfg.general.single_port = port
    return cfg


class TestFreqDictEndpoint:
    def test_404_when_tokenization_disabled(self, client, disabled_config):
        resp = client.get("/api/yomitan-freq-dict")
        assert resp.status_code == 404
        data = resp.get_json()
        assert "Tokenization must be enabled" in data["error"]

    def test_404_when_no_word_data(self, client, enabled_config):
        with patch(
            "GameSentenceMiner.web.yomitan_api.get_config", return_value=_mock_config()
        ):
            with patch.object(
                __import__(
                    "GameSentenceMiner.util.yomitan_dict.freq_dict_builder",
                    fromlist=["FrequencyDictBuilder"],
                ).FrequencyDictBuilder,
                "build_from_db",
            ) as mock_build:
                # build_from_db leaves entries empty
                mock_build.return_value = None
                resp = client.get("/api/yomitan-freq-dict")
                assert resp.status_code == 404
                data = resp.get_json()
                assert "No frequency data available" in data["error"]

    def test_successful_zip_download(self, client, enabled_config):
        from GameSentenceMiner.util.yomitan_dict.freq_dict_builder import (
            FrequencyDictBuilder,
        )

        original_build = FrequencyDictBuilder.build_from_db

        def _fake_build(self):
            self.entries = [
                ["食べる", "freq", {"frequency": 42, "reading": "たべる"}],
                ["猫", "freq", {"frequency": 10, "reading": "ねこ"}],
            ]

        with patch(
            "GameSentenceMiner.web.yomitan_api.get_config", return_value=_mock_config()
        ):
            with patch.object(FrequencyDictBuilder, "build_from_db", _fake_build):
                resp = client.get("/api/yomitan-freq-dict")
                assert resp.status_code == 200
                assert resp.content_type == "application/zip"
                assert resp.headers.get("Access-Control-Allow-Origin") == "*"

                # Verify ZIP contents
                with zipfile.ZipFile(io.BytesIO(resp.data)) as zf:
                    assert "index.json" in zf.namelist()
                    assert "term_meta_bank_1.json" in zf.namelist()
                    entries = json.loads(zf.read("term_meta_bank_1.json"))
                    assert len(entries) == 2

    def test_cors_header_on_error(self, client, disabled_config):
        resp = client.get("/api/yomitan-freq-dict")
        assert resp.headers.get("Access-Control-Allow-Origin") == "*"


class TestFreqIndexEndpoint:
    def test_404_when_tokenization_disabled(self, client, disabled_config):
        resp = client.get("/api/yomitan-freq-index")
        assert resp.status_code == 404

    def test_returns_json_with_cors(self, client, enabled_config):
        with patch(
            "GameSentenceMiner.web.yomitan_api.get_config", return_value=_mock_config()
        ):
            resp = client.get("/api/yomitan-freq-index")
            assert resp.status_code == 200
            assert resp.headers.get("Access-Control-Allow-Origin") == "*"
            data = resp.get_json()
            assert data["title"] == "GSM Frequency Dictionary"
            assert data["format"] == 3
            assert data["frequencyMode"] == "occurrence-based"
            assert data["isUpdatable"] is True
            assert "/api/yomitan-freq-dict" in data["downloadUrl"]
            assert "/api/yomitan-freq-index" in data["indexUrl"]
