from __future__ import annotations

import threading
from types import SimpleNamespace

import flask
import pytest
import requests

from GameSentenceMiner.util.database.db import GameLinesTable, SQLiteDB
from GameSentenceMiner.util.database.cron_table import CronTable
from GameSentenceMiner.util.database.games_table import GamesTable
from GameSentenceMiner.util.database.stats_export_state_table import StatsExportStateTable
from GameSentenceMiner.util.tadoku_sync import (
    TADOKU_AUTO_SYNC_MINIMUM_CHARACTERS,
    TADOKU_CURSOR_KEY,
    TadokuClient,
    TadokuSyncError,
    _tadoku_media_tag,
    build_tadoku_preview,
    initialize_tadoku_cursor,
    run_tadoku_sync,
    tadoku_game_cursor_key,
)
from GameSentenceMiner.web.tadoku_api import register_tadoku_api_routes


@pytest.fixture(autouse=True)
def _in_memory_db():
    for thread in threading.enumerate():
        target = getattr(thread, "_target", None)
        if getattr(target, "__name__", "") == "check_and_run_migrations":
            thread.join(timeout=10)
    original_dbs = {
        GameLinesTable: GameLinesTable._db,
        GamesTable: GamesTable._db,
        StatsExportStateTable: StatsExportStateTable._db,
        CronTable: CronTable._db,
    }
    db = SQLiteDB(":memory:")
    for table in original_dbs:
        table.set_db(db)
    db.execute(
        f"CREATE TABLE IF NOT EXISTS {GameLinesTable._sync_changes_table} ("
        "line_id TEXT PRIMARY KEY, change_type TEXT NOT NULL, changed_at REAL NOT NULL)",
        commit=True,
    )

    yield db

    db.close()
    for table, original_db in original_dbs.items():
        table._db = original_db


def _config(**overrides):
    values = {
        "tadoku_username": "reader",
        "tadoku_password": "password-secret",
        "tadoku_session_cookie": "",
        "tadoku_language_code": "jpn",
        "tadoku_daily_sync_enabled": False,
        "tadoku_daily_sync_deduplicate": True,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def _line(line_id, game_id, scene, text, modified):
    line = GameLinesTable(
        id=line_id,
        game_id=game_id,
        game_name=scene,
        line_text=text,
        timestamp=modified,
        last_modified=modified,
        created_at=modified,
        language="ja",
    )
    line.save()
    # The repository starts its legacy migration worker at db-module import time;
    # a first in-memory insert can overlap trigger creation on Windows.
    if GameLinesTable.get(line_id) is None:
        line.save()


def test_initialize_cursor_creates_launch_placeholder_without_overwriting_it():
    assert initialize_tadoku_cursor(now=100.0) == 100.0
    assert StatsExportStateTable.get_last_successful_export_at(TADOKU_CURSOR_KEY) == 100.0

    assert initialize_tadoku_cursor(now=200.0) == 100.0
    assert StatsExportStateTable.get_last_successful_export_at(TADOKU_CURSOR_KEY) == 100.0


def test_preview_groups_new_characters_into_one_entry_per_game():
    GamesTable(id="game-1", title_original="Tsukihime", obs_scene_name="Scene A").save()
    StatsExportStateTable.mark_successful_export(TADOKU_CURSOR_KEY, 100.0)
    _line("old", "game-1", "Scene A", "old", 90.0)
    _line("new-a", "game-1", "Scene A", "あいう", 110.0)
    _line("new-b", "game-1", "Scene B", "えお", 120.0)
    _line("other", "", "Unlinked Game", "abc", 130.0)

    preview = build_tadoku_preview(deduplicate=False, upper_bound=150.0)

    assert preview["cursor"] == 100.0
    assert preview["total_characters"] == 8
    assert preview["total_entries"] == 2
    assert preview["entries"] == [
        {
            "game_key": "game-1",
            "game_name": "Tsukihime",
            "media_tag": "game",
            "characters": 5,
            "lines": 2,
        },
        {
            "game_key": "scene:Unlinked Game",
            "game_name": "Unlinked Game",
            "media_tag": "game",
            "characters": 3,
            "lines": 1,
        },
    ]


def test_preview_does_not_resend_old_line_after_metadata_modification():
    StatsExportStateTable.mark_successful_export(TADOKU_CURSOR_KEY, 100.0)
    line = GameLinesTable(
        id="old-line",
        game_id="game-1",
        game_name="Scene A",
        line_text="already exported",
        timestamp=80.0,
        created_at=90.0,
        last_modified=120.0,
        language="ja",
    )
    line.save()

    preview = build_tadoku_preview(deduplicate=False, upper_bound=150.0)

    assert preview["entries"] == []
    assert preview["total_characters"] == 0


def test_deduplicated_preview_only_compares_lines_within_current_batch():
    StatsExportStateTable.mark_successful_export(TADOKU_CURSOR_KEY, 100.0)
    _line("old", "game-1", "Scene A", "same", 90.0)
    _line("duplicate", "game-1", "Scene B", "same", 110.0)
    _line("duplicate-later", "game-1", "Scene B", "SAME", 120.0)
    _line("unique", "game-1", "Scene B", "new", 130.0)

    plain = build_tadoku_preview(deduplicate=False, upper_bound=150.0)
    cleaned = build_tadoku_preview(deduplicate=True, upper_bound=150.0)

    assert plain["total_characters"] == len("samesamenew")
    assert cleaned["total_characters"] == len("samenew")
    assert cleaned["duplicates_excluded"] == 1
    assert GameLinesTable.get("old") is not None
    assert GameLinesTable.get("duplicate") is not None
    assert GameLinesTable.get("duplicate-later") is not None


def test_deduplicated_preview_keeps_identical_text_in_separate_game_groups():
    StatsExportStateTable.mark_successful_export(TADOKU_CURSOR_KEY, 100.0)
    _line("game-one", "game-1", "Game One", "same", 110.0)
    _line("game-two", "game-2", "Game Two", "same", 120.0)

    preview = build_tadoku_preview(deduplicate=True, upper_bound=150.0)

    assert preview["total_characters"] == len("same") * 2
    assert preview["duplicates_excluded"] == 0
    assert [entry["game_key"] for entry in preview["entries"]] == ["game-1", "game-2"]


@pytest.mark.parametrize(
    ("media_type", "expected_tag"),
    [
        ("Visual Novel", "vn"),
        ("VN", "vn"),
        ("Video game", "game"),
        ("VideoGame", "game"),
        ("Anime", "anime"),
        ("Drama", "drama"),
        ("Movie", "movie"),
        ("Novel", "novel"),
        ("NonFiction", "nonfiction"),
        ("Manga", "manga"),
        ("Web Novel", "webnovel"),
        ("Unknown", "game"),
        ("", "game"),
        (None, "game"),
    ],
)
def test_tadoku_media_tag_uses_media_type_with_game_fallback(media_type, expected_tag):
    assert _tadoku_media_tag(media_type) == expected_tag


def test_preview_prefers_english_game_title_when_available():
    GamesTable(
        id="game-english",
        title_original="原題",
        title_english="English Title",
        obs_scene_name="Scene A",
    ).save()
    StatsExportStateTable.mark_successful_export(TADOKU_CURSOR_KEY, 100.0)
    _line("english-title-line", "game-english", "Scene A", "abc", 110.0)

    preview = build_tadoku_preview(deduplicate=False, upper_bound=150.0)

    assert preview["entries"] == [
        {
            "game_key": "game-english",
            "game_name": "English Title",
            "media_tag": "game",
            "characters": 3,
            "lines": 1,
        }
    ]


class _FakeClient:
    def __init__(self, fail_on_post=0):
        self.fail_on_post = fail_on_post
        self.payloads = []
        self.deleted = []

    def resolve_character_unit_id(self, language_code):
        assert language_code == "jpn"
        return "character-unit"

    def get_eligible_registration_ids(self, language_code, activity_id):
        assert language_code == "jpn"
        assert activity_id == 1
        return ["registration-1", "registration-2"]

    def create_log(self, payload):
        self.payloads.append(payload)
        if self.fail_on_post and len(self.payloads) == self.fail_on_post:
            raise TadokuSyncError("remote failure")
        return {"id": f"log-{len(self.payloads)}"}

    def delete_log(self, log_id):
        self.deleted.append(log_id)


def test_sync_posts_one_character_log_per_game_and_advances_frozen_cursor(monkeypatch):
    StatsExportStateTable.mark_successful_export(TADOKU_CURSOR_KEY, 100.0)
    GamesTable(id="game-1", title_original="Tsukihime", game_type="Visual Novel").save()
    _line("one", "game-1", "Scene A", "あいう", 110.0)
    _line("two", "game-2", "Scene B", "えお", 120.0)
    client = _FakeClient()
    monkeypatch.setattr("GameSentenceMiner.util.tadoku_sync.time.time", lambda: 150.0)

    result = run_tadoku_sync(config=_config(), client=client, deduplicate=False)

    assert result["success"] is True
    assert result["entries_sent"] == 2
    assert result["characters_sent"] == 5
    assert StatsExportStateTable.get_last_successful_export_at(TADOKU_CURSOR_KEY) == 150.0
    assert client.payloads == [
        {
            "language_code": "jpn",
            "activity_id": 1,
            "amount": 3,
            "unit_id": "character-unit",
            "tags": ["vn", "gsm"],
            "description": "Tsukihime",
            "registration_ids": ["registration-1", "registration-2"],
        },
        {
            "language_code": "jpn",
            "activity_id": 1,
            "amount": 2,
            "unit_id": "character-unit",
            "tags": ["game", "gsm"],
            "description": "Scene B",
            "registration_ids": ["registration-1", "registration-2"],
        },
    ]


def test_sync_rolls_back_remote_logs_and_keeps_cursor_when_a_post_fails(monkeypatch):
    StatsExportStateTable.mark_successful_export(TADOKU_CURSOR_KEY, 100.0)
    _line("one", "game-1", "Scene A", "abc", 110.0)
    _line("two", "game-2", "Scene B", "def", 120.0)
    client = _FakeClient(fail_on_post=2)
    monkeypatch.setattr("GameSentenceMiner.util.tadoku_sync.time.time", lambda: 150.0)

    with pytest.raises(TadokuSyncError, match="remote failure"):
        run_tadoku_sync(config=_config(), client=client, deduplicate=False)

    assert client.deleted == ["log-1"]
    assert StatsExportStateTable.get_last_successful_export_at(TADOKU_CURSOR_KEY) == 100.0


def test_sync_minimum_uses_total_game_characters_not_queued_characters(monkeypatch):
    StatsExportStateTable.mark_successful_export(TADOKU_CURSOR_KEY, 100.0)
    _line("historical", "game-main", "Main Game", "a" * 4_963, 90.0)
    _line("queued", "game-main", "Main Game", "b" * 37, 110.0)
    client = _FakeClient()
    monkeypatch.setattr("GameSentenceMiner.util.tadoku_sync.time.time", lambda: 150.0)

    result = run_tadoku_sync(
        config=_config(),
        client=client,
        deduplicate=False,
        minimum_characters_per_game=TADOKU_AUTO_SYNC_MINIMUM_CHARACTERS,
        game_whitelist={"game-main"},
    )

    assert result["success"] is True
    assert result["characters_sent"] == 37
    assert client.payloads[0]["description"] == "Main Game"
    assert client.payloads[0]["amount"] == 37
    assert StatsExportStateTable.get_last_successful_export_at(TADOKU_CURSOR_KEY) == 100.0
    assert StatsExportStateTable.get_last_successful_export_at(tadoku_game_cursor_key("game-main")) == 150.0


def test_sync_minimum_keeps_games_below_total_character_threshold_queued(monkeypatch):
    StatsExportStateTable.mark_successful_export(TADOKU_CURSOR_KEY, 100.0)
    _line("historical", "game-small", "Small Game", "a" * 4_962, 90.0)
    _line("queued", "game-small", "Small Game", "b" * 37, 110.0)
    client = _FakeClient()
    monkeypatch.setattr("GameSentenceMiner.util.tadoku_sync.time.time", lambda: 150.0)

    result = run_tadoku_sync(
        config=_config(),
        client=client,
        deduplicate=False,
        minimum_characters_per_game=TADOKU_AUTO_SYNC_MINIMUM_CHARACTERS,
        game_whitelist={"game-small"},
    )

    assert result["success"] is True
    assert result["skipped"] is True
    assert result["reason"] == "no whitelisted game has 5,000 total characters"
    assert result["pending_characters"] == 37
    assert client.payloads == []
    assert StatsExportStateTable.get_last_successful_export_at(tadoku_game_cursor_key("game-small")) is None


def test_sync_whitelist_excludes_games_without_consuming_them(monkeypatch):
    StatsExportStateTable.mark_successful_export(TADOKU_CURSOR_KEY, 100.0)
    _line("allowed", "game-allowed", "Allowed Game", "a" * 5_000, 110.0)
    _line("blocked", "game-blocked", "Blocked Game", "b" * 5_000, 120.0)
    client = _FakeClient()
    now = [150.0]
    monkeypatch.setattr("GameSentenceMiner.util.tadoku_sync.time.time", lambda: now[0])

    run_tadoku_sync(
        config=_config(),
        client=client,
        game_whitelist={"game-allowed"},
    )

    assert [payload["description"] for payload in client.payloads] == ["Allowed Game"]
    assert StatsExportStateTable.get_last_successful_export_at(tadoku_game_cursor_key("game-blocked")) is None

    now[0] = 200.0
    run_tadoku_sync(
        config=_config(),
        client=client,
        game_whitelist={"game-blocked"},
    )

    assert [payload["description"] for payload in client.payloads] == ["Allowed Game", "Blocked Game"]


def test_empty_whitelist_does_not_restrict_automatic_sync(monkeypatch):
    StatsExportStateTable.mark_successful_export(TADOKU_CURSOR_KEY, 100.0)
    _line("pending", "game-main", "Main Game", "a" * 10_000, 110.0)
    client = _FakeClient()
    monkeypatch.setattr("GameSentenceMiner.util.tadoku_sync.time.time", lambda: 150.0)

    result = run_tadoku_sync(
        config=_config(),
        client=client,
        game_whitelist=set(),
        minimum_characters_per_game=TADOKU_AUTO_SYNC_MINIMUM_CHARACTERS,
    )

    assert result["success"] is True
    assert result["characters_sent"] == 10_000
    assert [payload["description"] for payload in client.payloads] == ["Main Game"]
    assert StatsExportStateTable.get_last_successful_export_at(TADOKU_CURSOR_KEY) == 100.0
    assert StatsExportStateTable.get_last_successful_export_at(tadoku_game_cursor_key("game-main")) == 150.0


def test_sync_excludes_duplicate_current_batch_without_deleting_local_lines(monkeypatch):
    StatsExportStateTable.mark_successful_export(TADOKU_CURSOR_KEY, 100.0)
    _line("old", "game-1", "Scene A", "same", 90.0)
    _line("new", "game-1", "Scene B", "same", 110.0)
    _line("new-duplicate", "game-1", "Scene B", "SAME", 120.0)
    monkeypatch.setattr("GameSentenceMiner.util.tadoku_sync.time.time", lambda: 150.0)

    client = _FakeClient()
    result = run_tadoku_sync(config=_config(), client=client, deduplicate=True)

    assert result["entries_sent"] == 1
    assert result["characters_sent"] == len("same")
    assert result["duplicates_excluded"] == 1
    assert GameLinesTable.get("old") is not None
    assert GameLinesTable.get("new") is not None
    assert GameLinesTable.get("new-duplicate") is not None
    assert StatsExportStateTable.get_last_successful_export_at(TADOKU_CURSOR_KEY) == 150.0


def test_sync_reuses_and_persists_refreshed_session_cookie(monkeypatch):
    StatsExportStateTable.mark_successful_export(TADOKU_CURSOR_KEY, 100.0)
    _line("one", "game-1", "Scene A", "abc", 110.0)
    config = _config(tadoku_session_cookie="saved-cookie")
    constructed = []
    saved = []

    class _RefreshingClient(_FakeClient):
        def __init__(self, username, password, *, session_cookie):
            super().__init__()
            constructed.append((username, password, session_cookie))
            self.session_cookie = "refreshed-cookie"

    monkeypatch.setattr("GameSentenceMiner.util.tadoku_sync.TadokuClient", _RefreshingClient)
    monkeypatch.setattr("GameSentenceMiner.util.tadoku_sync.save_stats_config", lambda value: saved.append(value))
    monkeypatch.setattr("GameSentenceMiner.util.tadoku_sync.time.time", lambda: 150.0)

    result = run_tadoku_sync(config=config, deduplicate=False)

    assert result["success"] is True
    assert constructed == [("reader", "password-secret", "saved-cookie")]
    assert config.tadoku_session_cookie == "refreshed-cookie"
    assert saved == [config]


def test_tadoku_client_prefers_language_specific_character_unit():
    client = TadokuClient("reader", "password")
    client._request_json = lambda *_args, **_kwargs: {
        "units": [
            {"id": "fallback", "log_activity_id": 1, "name": "Character"},
            {
                "id": "japanese",
                "log_activity_id": 1,
                "name": "Character",
                "language_code": "jpn",
            },
        ]
    }

    assert client.resolve_character_unit_id("jpn") == "japanese"


def test_tadoku_client_uses_deployed_internal_immersion_route():
    class _Response:
        ok = True
        status_code = 200
        content = b'{"units": []}'

        @staticmethod
        def json():
            return {"units": []}

    class _Session:
        def __init__(self):
            self.request_urls = []
            self.cookies = requests.cookies.RequestsCookieJar()

        def request(self, method, url, **kwargs):
            self.request_urls.append((method, url, kwargs))
            if url.endswith("/self-service/login/browser"):
                return SimpleNamespace(
                    ok=True,
                    content=b"{}",
                    json=lambda: {
                        "ui": {
                            "action": "https://account.tadoku.app/kratos/self-service/login?flow=id",
                            "nodes": [{"attributes": {"name": "csrf_token", "value": "csrf-value"}}],
                        }
                    },
                )
            if "self-service/login?flow=" in url:
                self.cookies.set("ory_kratos_session", "fresh-cookie")
                return SimpleNamespace(
                    ok=True,
                    content=b"{}",
                    json=lambda: {},
                )
            return _Response()

    session = _Session()
    client = TadokuClient("reader", "password", session=session)

    with pytest.raises(TadokuSyncError, match="no Character unit"):
        client.resolve_character_unit_id("jpn")

    method, url, kwargs = session.request_urls[-1]
    assert method == "GET"
    assert url == "https://tadoku.app/api/internal/immersion/logs/configuration-options"
    assert "headers" not in kwargs


def test_tadoku_client_exchanges_credentials_for_browser_session_cookie():
    class _Session:
        def __init__(self):
            self.requests = []
            self.cookies = requests.cookies.RequestsCookieJar()

        def request(self, method, url, **kwargs):
            self.requests.append((method, url, kwargs))
            if url.endswith("/self-service/login/browser"):
                return SimpleNamespace(
                    ok=True,
                    content=b"{}",
                    json=lambda: {
                        "ui": {
                            "action": "https://account.tadoku.app/kratos/self-service/login?flow=flow-id",
                            "nodes": [{"attributes": {"name": "csrf_token", "value": "csrf-value"}}],
                        }
                    },
                )
            self.cookies.set("ory_kratos_session", "fresh-cookie")
            return SimpleNamespace(
                ok=True,
                content=b"{}",
                json=lambda: {},
            )

    session = _Session()
    client = TadokuClient("reader", "password-secret", session=session)

    client._login()

    assert session.requests[1][2]["data"] == {
        "identifier": "reader",
        "password": "password-secret",
        "method": "password",
        "csrf_token": "csrf-value",
    }
    assert session.cookies.get("ory_kratos_session") == "fresh-cookie"


def test_tadoku_client_reuses_saved_cookie_without_logging_in():
    class _Session:
        def __init__(self):
            self.cookies = requests.cookies.RequestsCookieJar()
            self.requests = []

        def request(self, method, url, **kwargs):
            self.requests.append((method, url, kwargs))
            return SimpleNamespace(
                ok=True,
                status_code=200,
                content=b'{"units": []}',
                json=lambda: {"units": []},
            )

    session = _Session()
    client = TadokuClient("reader", "password", session_cookie="saved-cookie", session=session)

    with pytest.raises(TadokuSyncError, match="no Character unit"):
        client.resolve_character_unit_id("jpn")

    assert len(session.requests) == 1
    assert "/self-service/login/" not in session.requests[0][1]
    assert client.session_cookie == "saved-cookie"


def test_tadoku_client_refreshes_saved_cookie_once_after_401():
    class _Session:
        def __init__(self):
            self.cookies = requests.cookies.RequestsCookieJar()
            self.requests = []
            self.api_calls = 0

        def request(self, method, url, **kwargs):
            self.requests.append((method, url, kwargs))
            if url.endswith("/self-service/login/browser"):
                return SimpleNamespace(
                    ok=True,
                    status_code=200,
                    content=b"{}",
                    json=lambda: {
                        "ui": {
                            "action": "https://account.tadoku.app/kratos/self-service/login?flow=id",
                            "nodes": [{"attributes": {"name": "csrf_token", "value": "csrf-value"}}],
                        }
                    },
                )
            if "self-service/login?flow=" in url:
                self.cookies.clear()
                self.cookies.set("ory_kratos_session", "refreshed-cookie")
                return SimpleNamespace(ok=True, status_code=200, content=b"{}", json=lambda: {})
            self.api_calls += 1
            if self.api_calls == 1:
                return SimpleNamespace(ok=False, status_code=401, content=b"", text="")
            return SimpleNamespace(
                ok=True,
                status_code=200,
                content=b'{"units": []}',
                json=lambda: {"units": []},
            )

    session = _Session()
    client = TadokuClient("reader", "password", session_cookie="expired-cookie", session=session)

    with pytest.raises(TadokuSyncError, match="no Character unit"):
        client.resolve_character_unit_id("jpn")

    assert session.api_calls == 2
    assert client.session_cookie == "refreshed-cookie"


def test_tadoku_client_selects_all_eligible_ongoing_contest_registrations():
    client = TadokuClient("reader", "password")
    client._request_json = lambda *_args, **_kwargs: {
        "registrations": [
            {
                "id": "eligible-official",
                "languages": [{"code": "jpn"}],
                "contest": {"allowed_activities": [{"id": 1}]},
            },
            {
                "id": "eligible-private",
                "languages": [{"code": "jpn"}, {"code": "kor"}],
                "contest": {"allowed_activities": [{"id": 1}, {"id": 2}]},
            },
            {
                "id": "wrong-language",
                "languages": [{"code": "kor"}],
                "contest": {"allowed_activities": [{"id": 1}]},
            },
            {
                "id": "wrong-activity",
                "languages": [{"code": "jpn"}],
                "contest": {"allowed_activities": [{"id": 2}]},
            },
        ]
    }

    assert client.get_eligible_registration_ids("jpn", 1) == [
        "eligible-official",
        "eligible-private",
    ]


def test_tadoku_cron_is_created_disabled_then_can_be_enabled(monkeypatch):
    from GameSentenceMiner.util.cron.tadoku_sync import configure_tadoku_cron

    monkeypatch.setattr(
        "GameSentenceMiner.util.cron.tadoku_sync.get_stats_config",
        lambda: _config(tadoku_daily_sync_enabled=False),
    )

    cron = configure_tadoku_cron()
    assert cron.name == "tadoku_sync"
    assert cron.schedule == "daily"
    assert cron.enabled is False

    enabled = configure_tadoku_cron(True)
    assert enabled.enabled is True
    assert enabled.next_run > 0


def test_scheduled_sync_reports_remote_failure_without_raising(monkeypatch):
    from GameSentenceMiner.util.cron.tadoku_sync import run_scheduled_tadoku_sync

    monkeypatch.setattr(
        "GameSentenceMiner.util.cron.tadoku_sync.get_stats_config",
        lambda: _config(),
    )
    monkeypatch.setattr(
        "GameSentenceMiner.util.cron.tadoku_sync.run_tadoku_sync",
        lambda **_kwargs: (_ for _ in ()).throw(TadokuSyncError("expired cookie")),
    )

    assert run_scheduled_tadoku_sync() == {"success": False, "error": "expired cookie"}


def test_scheduled_sync_requires_automatic_minimum(monkeypatch):
    from GameSentenceMiner.util.cron.tadoku_sync import run_scheduled_tadoku_sync

    calls = []
    config = _config(
        tadoku_daily_sync_deduplicate=False,
        tadoku_daily_sync_game_ids=["game-main"],
    )
    monkeypatch.setattr(
        "GameSentenceMiner.util.cron.tadoku_sync.get_stats_config",
        lambda: config,
    )
    monkeypatch.setattr(
        "GameSentenceMiner.util.cron.tadoku_sync.run_tadoku_sync",
        lambda **kwargs: calls.append(kwargs) or {"success": True},
    )

    assert run_scheduled_tadoku_sync() == {"success": True}
    assert calls == [
        {
            "config": config,
            "deduplicate": False,
            "minimum_characters_per_game": TADOKU_AUTO_SYNC_MINIMUM_CHARACTERS,
            "game_whitelist": {"game-main"},
        }
    ]


def test_scheduled_sync_does_not_require_a_whitelist(monkeypatch):
    from GameSentenceMiner.util.cron.tadoku_sync import run_scheduled_tadoku_sync

    calls = []
    config = _config(tadoku_daily_sync_game_ids=[])
    monkeypatch.setattr(
        "GameSentenceMiner.util.cron.tadoku_sync.get_stats_config",
        lambda: config,
    )
    monkeypatch.setattr(
        "GameSentenceMiner.util.cron.tadoku_sync.run_tadoku_sync",
        lambda **kwargs: calls.append(kwargs) or {"success": True},
    )

    assert run_scheduled_tadoku_sync() == {"success": True}
    assert calls[0]["game_whitelist"] is None


def test_tadoku_api_previews_and_queues_inline_sync(monkeypatch):
    app = flask.Flask(__name__)
    app.config["TESTING"] = True
    register_tadoku_api_routes(app)
    monkeypatch.setattr(
        "GameSentenceMiner.web.tadoku_api.get_stats_config",
        lambda: _config(),
    )
    monkeypatch.setattr(
        "GameSentenceMiner.web.tadoku_api.build_tadoku_preview",
        lambda **_kwargs: {
            "entries": [{"game_name": "Game", "characters": 3, "lines": 1}],
            "total_entries": 1,
            "total_characters": 3,
        },
    )
    monkeypatch.setattr(
        "GameSentenceMiner.web.tadoku_api.run_tadoku_sync",
        lambda **_kwargs: {"success": True, "entries_sent": 1, "characters_sent": 3},
    )
    client = app.test_client()

    preview = client.get("/api/tadoku/preview?deduplicate=true")
    queued = client.post("/api/tadoku/sync", json={"deduplicate": True})

    assert preview.status_code == 200
    assert preview.get_json()["configured"] is True
    assert queued.status_code == 202
    job = queued.get_json()
    assert job["status"] == "completed"
    assert job["result"]["characters_sent"] == 3


def test_tadoku_api_manually_refreshes_and_persists_authentication(monkeypatch):
    app = flask.Flask(__name__)
    app.config["TESTING"] = True
    register_tadoku_api_routes(app)
    config = _config(tadoku_session_cookie="old-cookie")
    saved = []

    class _Client:
        def __init__(self, username, password):
            assert username == "reader"
            assert password == "password-secret"
            self.session_cookie = ""

        def refresh_session(self):
            self.session_cookie = "fresh-cookie"

    monkeypatch.setattr("GameSentenceMiner.web.tadoku_api.get_stats_config", lambda: config)
    monkeypatch.setattr("GameSentenceMiner.web.tadoku_api.save_stats_config", lambda value: saved.append(value))
    monkeypatch.setattr("GameSentenceMiner.web.tadoku_api.TadokuClient", _Client)

    response = app.test_client().post("/api/tadoku/auth/refresh")

    assert response.status_code == 200
    assert response.get_json() == {"authenticated": True}
    assert config.tadoku_session_cookie == "fresh-cookie"
    assert saved == [config]


def test_tadoku_api_manual_auth_requires_saved_credentials(monkeypatch):
    app = flask.Flask(__name__)
    app.config["TESTING"] = True
    register_tadoku_api_routes(app)
    monkeypatch.setattr(
        "GameSentenceMiner.web.tadoku_api.get_stats_config",
        lambda: _config(tadoku_username="", tadoku_password=""),
    )

    response = app.test_client().post("/api/tadoku/auth/refresh")

    assert response.status_code == 400
    assert response.get_json()["error"] == "Save a Tadoku username and password first"
