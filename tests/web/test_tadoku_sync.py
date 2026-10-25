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


@pytest.mark.parametrize(
    ("title_source", "expected_title"),
    [("english", "English Title"), ("original", "原題"), ("romaji", "Gendai")],
)
def test_preview_uses_selected_game_title(title_source, expected_title):
    GamesTable(id="game-titles", title_original=" 原題 ", title_english="English Title", title_romaji="Gendai").save()
    StatsExportStateTable.mark_successful_export(TADOKU_CURSOR_KEY, 100.0)
    _line("title-line", "game-titles", "Scene A", "abc", 110.0)

    preview = build_tadoku_preview(title_source=title_source, upper_bound=150.0)

    assert preview["entries"][0]["game_name"] == expected_title
    assert preview["total_characters"] == 3


@pytest.mark.parametrize(
    ("title_source", "titles", "expected_title"),
    [
        ("english", {"title_original": "原題"}, "原題"),
        ("original", {"title_original": " ", "title_english": "English Title"}, "English Title"),
        ("romaji", {"title_original": "原題"}, "原題"),
        ("english", {"title_romaji": "Gendai"}, "Gendai"),
        ("original", {"title_original": " ", "title_english": " "}, "Scene A"),
    ],
)
def test_preview_title_source_falls_back_when_title_is_missing(title_source, titles, expected_title):
    GamesTable(id="game-titles", **titles).save()
    StatsExportStateTable.mark_successful_export(TADOKU_CURSOR_KEY, 100.0)
    _line("title-line", "game-titles", "Scene A", "abc", 110.0)
    _line("scene-line", "missing-game", "Scene B", "def", 120.0)

    preview = build_tadoku_preview(title_source=title_source, upper_bound=150.0)

    assert [entry["game_name"] for entry in preview["entries"]] == [expected_title, "Scene B"]
    assert preview["total_characters"] == 6


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


@pytest.mark.parametrize("scheduled", [False, True])
@pytest.mark.parametrize(
    ("title_source", "expected_title"),
    [("english", "English Title"), ("original", "原" * 255), ("romaji", "Gendai")],
)
def test_sync_uses_saved_title_source(monkeypatch, scheduled, title_source, expected_title):
    from GameSentenceMiner.util.cron.tadoku_sync import run_scheduled_tadoku_sync

    GamesTable(id="game-titles", title_original="原" * 300, title_english="English Title", title_romaji="Gendai").save()
    StatsExportStateTable.mark_successful_export(TADOKU_CURSOR_KEY, 100.0)
    _line("title-line", "game-titles", "Scene A", "あ" * TADOKU_AUTO_SYNC_MINIMUM_CHARACTERS, 110.0)
    config = _config(tadoku_title_source=title_source)
    client = _FakeClient()
    monkeypatch.setattr("GameSentenceMiner.util.tadoku_sync.time.time", lambda: 150.0)
    monkeypatch.setattr("GameSentenceMiner.util.cron.tadoku_sync.get_stats_config", lambda: config)
    monkeypatch.setattr(
        "GameSentenceMiner.util.cron.tadoku_sync.run_tadoku_sync",
        lambda **kwargs: run_tadoku_sync(client=client, **kwargs),
    )

    result = run_scheduled_tadoku_sync() if scheduled else run_tadoku_sync(config=config, client=client)

    assert result["success"] is True
    assert client.payloads[0]["description"] == expected_title
    assert client.payloads[0]["amount"] == TADOKU_AUTO_SYNC_MINIMUM_CHARACTERS


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


def test_manual_sync_uses_edited_log_descriptions_only_for_that_sync(monkeypatch):
    title = "Zero Escape: Virtue's Last Reward"
    edited_title = f"{title} 終わり"
    GamesTable(id="game-1", title_english=title).save()
    GamesTable(id="game-2", title_english=title).save()
    StatsExportStateTable.mark_successful_export(TADOKU_CURSOR_KEY, 100.0)
    _line("one", "game-1", "Scene A", "あいう", 110.0)
    _line("two", "game-2", "Scene B", "えお", 120.0)
    _line("unlinked", "", "Unlinked Game", "abc", 130.0)
    client = _FakeClient()
    now = [150.0]
    monkeypatch.setattr("GameSentenceMiner.util.tadoku_sync.time.time", lambda: now[0])

    result = run_tadoku_sync(
        config=_config(),
        client=client,
        log_descriptions={"game-1": edited_title, "scene:Unlinked Game": "Unlinked Game 終わり"},
    )

    assert result["characters_sent"] == 8
    assert [payload["description"] for payload in client.payloads] == [
        edited_title,
        title,
        "Unlinked Game 終わり",
    ]
    assert GamesTable.get("game-1").title_english == title
    assert GameLinesTable.get("one").game_name == "Scene A"
    assert StatsExportStateTable.get_last_successful_export_at(TADOKU_CURSOR_KEY) == 150.0

    _line("next", "game-1", "Scene A", "かきく", 160.0)
    now[0] = 200.0
    run_tadoku_sync(config=_config(), client=client)
    assert client.payloads[-1]["description"] == title


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


class _TadokuSession:
    """Scripted HTTP responses; never contact a real Tadoku account."""

    def __init__(self, *responses):
        self.cookies = requests.cookies.RequestsCookieJar()
        self.responses = list(responses)
        self.requests = []
        self.sent_cookies = []

    def request(self, method, url, **kwargs):
        self.requests.append((method, url, kwargs))
        prepared = requests.Request(method, url, cookies=self.cookies).prepare()
        self.sent_cookies.append(prepared.headers.get("Cookie", ""))
        assert self.responses, f"Unexpected request: {method} {url}"
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        self.cookies.update(response.cookies)
        return response


def _tadoku_response(status=200, payload=None, *, cookie=""):
    response = SimpleNamespace(
        ok=200 <= status < 400,
        status_code=status,
        content=b"{}",
        text="",
        json=lambda: payload or {},
        cookies=requests.cookies.RequestsCookieJar(),
    )
    if cookie:
        response.cookies.set("tadoku_session", cookie, domain=".tadoku.app", path="/", secure=True)
    return response


def test_tadoku_client_uses_deployed_internal_immersion_route():
    session = _TadokuSession(_tadoku_response(cookie="fresh-cookie"), _tadoku_response(payload={"units": []}))
    client = TadokuClient("reader@example.com", "password", session=session)

    with pytest.raises(TadokuSyncError, match="no Character unit"):
        client.resolve_character_unit_id("jpn")

    method, url, kwargs = session.requests[-1]
    assert method == "GET"
    assert url == "https://tadoku.app/api/internal/immersion/logs/configuration-options"
    assert "headers" not in kwargs
    assert session.sent_cookies[-1] == "tadoku_session=fresh-cookie"


def test_tadoku_client_exchanges_saved_credentials_for_new_session_cookie():
    session = _TadokuSession(_tadoku_response(cookie="fresh-cookie"))
    client = TadokuClient(" reader@example.com ", " password-secret ", session=session)

    client.refresh_session()

    assert len(session.requests) == 1
    method, url, kwargs = session.requests[0]
    assert method == "POST"
    assert url == "https://tadoku.app/api/internal/identity/login"
    assert kwargs["json"] == {"email": "reader@example.com", "password": " password-secret "}
    assert kwargs["headers"]["Origin"] == "https://tadoku.app"
    prepared = requests.Request(method, url, json=kwargs["json"], headers=kwargs["headers"]).prepare()
    assert prepared.headers["Content-Type"] == "application/json"
    assert "Authorization" not in prepared.headers
    assert "X-Session-Token" not in prepared.headers
    assert kwargs["timeout"] == 20
    assert client.session_cookie == "fresh-cookie"


def test_tadoku_client_reuses_saved_cookie_without_logging_in():
    session = _TadokuSession(_tadoku_response(payload={"units": []}))
    client = TadokuClient("reader@example.com", "password", session_cookie="saved-cookie", session=session)

    with pytest.raises(TadokuSyncError, match="no Character unit"):
        client.resolve_character_unit_id("jpn")

    assert len(session.requests) == 1
    assert session.requests[0][1].endswith("/immersion/logs/configuration-options")
    assert session.sent_cookies == ["tadoku_session=saved-cookie"]
    assert client.session_cookie == "saved-cookie"
    cookie = next(iter(session.cookies))
    assert cookie.secure and cookie.domain == ".tadoku.app" and cookie.path == "/"


@pytest.mark.parametrize("saved_cookie", ["legacy-kratos-cookie", "expired-tadoku-cookie"])
def test_tadoku_client_refreshes_saved_cookie_once_after_401(saved_cookie):
    session = _TadokuSession(
        _tadoku_response(401), _tadoku_response(cookie="refreshed-cookie"), _tadoku_response(payload={"id": "log-1"})
    )
    client = TadokuClient("reader@example.com", "password", session_cookie=saved_cookie, session=session)
    payload = {"amount": 123, "description": "Existing log format"}

    assert client.create_log(payload) == {"id": "log-1"}

    assert len(session.requests) == 3
    assert session.requests[0] == session.requests[2]
    assert session.requests[0][2]["json"] == payload
    assert session.requests[1][1].endswith("/identity/login")
    assert session.sent_cookies == [f"tadoku_session={saved_cookie}", "", "tadoku_session=refreshed-cookie"]
    assert client.session_cookie == "refreshed-cookie"


def test_tadoku_client_stops_after_second_401():
    session = _TadokuSession(_tadoku_response(401), _tadoku_response(cookie="fresh-cookie"), _tadoku_response(401))
    client = TadokuClient("reader@example.com", "password", session_cookie="old-cookie", session=session)

    with pytest.raises(TadokuSyncError, match="HTTP 401"):
        client.create_log({"amount": 123})

    assert len(session.requests) == 3


@pytest.mark.parametrize(
    ("status", "message"),
    [
        (400, "HTTP 400"),
        (401, "email and password"),
        (403, "HTTP 403"),
        (429, "15 minutes"),
        (503, "temporarily unavailable"),
    ],
)
def test_tadoku_login_failure_does_not_retry_or_expose_response(status, message):
    response = _tadoku_response(status)
    response.text = "password-secret cookie-secret"
    session = _TadokuSession(_tadoku_response(401), response)
    client = TadokuClient("reader@example.com", "password-secret", session_cookie="old-cookie", session=session)

    with pytest.raises(TadokuSyncError, match=message) as error:
        client.create_log({"amount": 123})

    assert len(session.requests) == 2
    assert "password-secret" not in str(error.value)
    assert "cookie-secret" not in str(error.value)


@pytest.mark.parametrize("status", [403, 429, 503])
def test_tadoku_api_errors_do_not_trigger_login_or_retry(status):
    session = _TadokuSession(_tadoku_response(status))
    client = TadokuClient("reader@example.com", "password", session_cookie="saved-cookie", session=session)

    with pytest.raises(TadokuSyncError, match=f"HTTP {status}"):
        client.create_log({"amount": 123})

    assert len(session.requests) == 1
    assert client.session_cookie == "saved-cookie"


def test_tadoku_login_requires_new_cookie_and_clears_stale_sessions():
    response = _tadoku_response()
    response.cookies.set("ory_kratos_session", "legacy-response-cookie", domain=".tadoku.app", path="/")
    session = _TadokuSession(response)
    session.cookies.set("ory_kratos_session", "legacy-cookie", domain=".tadoku.app", path="/")
    session.cookies.set("tadoku_session", "host-cookie", domain="tadoku.app", path="/")
    client = TadokuClient("reader@example.com", "password", session_cookie="saved-cookie", session=session)

    with pytest.raises(TadokuSyncError, match="session cookie"):
        client.refresh_session()

    assert session.sent_cookies == [""]
    assert client.session_cookie == ""


def test_tadoku_login_handles_network_failure_without_retry():
    session = _TadokuSession(requests.Timeout("timed out"))
    client = TadokuClient("reader@example.com", "password", session=session)

    with pytest.raises(TadokuSyncError, match="Could not reach Tadoku login"):
        client.refresh_session()

    assert len(session.requests) == 1


def test_sync_migrates_legacy_cookie_preserving_settings_and_incremental_history(monkeypatch):
    StatsExportStateTable.mark_successful_export(TADOKU_CURSOR_KEY, 100.0)
    StatsExportStateTable.mark_successful_export(tadoku_game_cursor_key("game-1"), 120.0)
    _line("already-synced", "game-1", "Scene A", "old", 110.0)
    _line("pending", "game-1", "Scene A", "new", 130.0)
    config = _config(
        tadoku_username="reader@example.com",
        tadoku_session_cookie="legacy-kratos-cookie",
        tadoku_daily_sync_enabled=True,
        tadoku_daily_sync_game_ids=["game-1"],
        tadoku_title_source="original",
    )
    original_settings = vars(config).copy()
    units = {"units": [{"id": "characters", "log_activity_id": 1, "name": "Character"}]}
    session = _TadokuSession(
        _tadoku_response(payload=units),
        _tadoku_response(401),
        _tadoku_response(cookie="fresh-cookie"),
        _tadoku_response(payload={"registrations": []}),
        _tadoku_response(payload={"id": "log-1"}),
        _tadoku_response(payload=units),
        _tadoku_response(payload={"registrations": []}),
        _tadoku_response(payload={"id": "log-2"}),
    )
    saved = []
    monkeypatch.setattr("GameSentenceMiner.util.tadoku_sync.requests.Session", lambda: session)
    monkeypatch.setattr("GameSentenceMiner.util.tadoku_sync.save_stats_config", lambda value: saved.append(value))
    now = [150.0]
    monkeypatch.setattr("GameSentenceMiner.util.tadoku_sync.time.time", lambda: now[0])

    result = run_tadoku_sync(config=config)

    assert result["characters_sent"] == 3
    assert session.requests[4][2]["json"]["amount"] == 3
    assert vars(config) == {**original_settings, "tadoku_session_cookie": "fresh-cookie"}
    assert saved == [config]
    assert StatsExportStateTable.get_last_successful_export_at(tadoku_game_cursor_key("game-1")) == 150.0
    assert run_tadoku_sync(config=config)["entries_sent"] == 0
    assert len(session.requests) == 5

    _line("next", "game-1", "Scene A", "next", 160.0)
    now[0] = 200.0
    assert run_tadoku_sync(config=config)["characters_sent"] == 4
    assert len(session.requests) == 8
    assert all(cookie == "tadoku_session=fresh-cookie" for cookie in session.sent_cookies[5:])
    assert saved == [config]


@pytest.mark.parametrize("login_succeeds", [False, True])
def test_failed_sync_keeps_history_and_saves_only_successful_login(monkeypatch, login_succeeds):
    StatsExportStateTable.mark_successful_export(TADOKU_CURSOR_KEY, 100.0)
    StatsExportStateTable.mark_successful_export(tadoku_game_cursor_key("game-1"), 120.0)
    _line("pending", "game-1", "Scene A", "new", 130.0)
    config = _config(tadoku_username="reader@example.com", tadoku_session_cookie="legacy-cookie")
    responses = [_tadoku_response(401)]
    if login_succeeds:
        responses.extend([_tadoku_response(cookie="fresh-cookie"), _tadoku_response(503)])
    else:
        responses.append(_tadoku_response(401))
    session = _TadokuSession(*responses)
    saved = []
    monkeypatch.setattr("GameSentenceMiner.util.tadoku_sync.requests.Session", lambda: session)
    monkeypatch.setattr("GameSentenceMiner.util.tadoku_sync.save_stats_config", lambda value: saved.append(value))
    monkeypatch.setattr("GameSentenceMiner.util.tadoku_sync.time.time", lambda: 150.0)

    with pytest.raises(TadokuSyncError):
        run_tadoku_sync(config=config)

    assert config.tadoku_session_cookie == ("fresh-cookie" if login_succeeds else "legacy-cookie")
    assert saved == ([config] if login_succeeds else [])
    assert StatsExportStateTable.get_last_successful_export_at(TADOKU_CURSOR_KEY) == 100.0
    assert StatsExportStateTable.get_last_successful_export_at(tadoku_game_cursor_key("game-1")) == 120.0
    assert build_tadoku_preview(upper_bound=150.0)["total_characters"] == 3
    assert GameLinesTable.get("pending") is not None


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


@pytest.mark.parametrize(
    ("query", "expected_title"),
    [("", "原題"), ("?title_source=romaji", "Gendai"), ("?title_source=english", "English Title")],
)
def test_tadoku_preview_api_uses_saved_or_requested_title_source(monkeypatch, query, expected_title):
    app = flask.Flask(__name__)
    register_tadoku_api_routes(app)
    GamesTable(id="game-titles", title_original="原題", title_english="English Title", title_romaji="Gendai").save()
    StatsExportStateTable.mark_successful_export(TADOKU_CURSOR_KEY, 100.0)
    _line("title-line", "game-titles", "Scene A", "abc", 110.0)
    monkeypatch.setattr("GameSentenceMiner.util.tadoku_sync.time.time", lambda: 150.0)
    monkeypatch.setattr(
        "GameSentenceMiner.web.tadoku_api.get_stats_config", lambda: _config(tadoku_title_source="original")
    )

    response = app.test_client().get(f"/api/tadoku/preview{query}")

    assert response.status_code == 200
    assert response.get_json()["entries"][0]["game_name"] == expected_title


def test_tadoku_preview_api_rejects_invalid_title_source(monkeypatch):
    app = flask.Flask(__name__)
    register_tadoku_api_routes(app)
    monkeypatch.setattr("GameSentenceMiner.web.tadoku_api.get_stats_config", lambda: _config())

    response = app.test_client().get("/api/tadoku/preview?title_source=invalid")

    assert response.status_code == 400


@pytest.mark.parametrize("run_inline", [True, False])
def test_tadoku_api_passes_edited_log_descriptions_to_sync(monkeypatch, run_inline):
    from GameSentenceMiner.web.tadoku_api import TadokuSyncJobManager

    app = flask.Flask(__name__)
    app.config["TESTING"] = run_inline
    register_tadoku_api_routes(app)
    monkeypatch.setattr("GameSentenceMiner.web.tadoku_api.tadoku_sync_job_manager", TadokuSyncJobManager())
    calls = []
    completed = threading.Event()

    def sync(**kwargs):
        calls.append(kwargs)
        completed.set()
        return {"success": True, "entries_sent": 1, "characters_sent": 3}

    monkeypatch.setattr("GameSentenceMiner.web.tadoku_api.run_tadoku_sync", sync)
    descriptions = {"game-1": "Zero Escape: Virtue's Last Reward 終わり"}
    response = app.test_client().post("/api/tadoku/sync", json={"deduplicate": True, "log_descriptions": descriptions})

    assert response.status_code == 202
    assert completed.wait(timeout=2)
    assert calls == [{"deduplicate": True, "log_descriptions": descriptions}]


@pytest.mark.parametrize(
    "descriptions",
    [[], "title", {"": "title"}, {"game-1": None}, {"game-1": 123}, {"game-1": "  "}, {"game-1": "あ" * 256}],
)
def test_tadoku_api_rejects_invalid_log_descriptions_before_queueing(monkeypatch, descriptions):
    app = flask.Flask(__name__)
    app.config["TESTING"] = True
    register_tadoku_api_routes(app)
    calls = []
    monkeypatch.setattr("GameSentenceMiner.web.tadoku_api.run_tadoku_sync", lambda **kwargs: calls.append(kwargs))

    response = app.test_client().post("/api/tadoku/sync", json={"log_descriptions": descriptions})

    assert response.status_code == 400
    assert "log" in response.get_json()["error"].lower()
    assert calls == []


def test_tadoku_api_manually_refreshes_and_persists_authentication(monkeypatch):
    app = flask.Flask(__name__)
    app.config["TESTING"] = True
    register_tadoku_api_routes(app)
    config = _config(tadoku_username="reader@example.com", tadoku_session_cookie="old-cookie")
    saved = []
    session = _TadokuSession(_tadoku_response(cookie="fresh-cookie"))

    monkeypatch.setattr("GameSentenceMiner.web.tadoku_api.get_stats_config", lambda: config)
    monkeypatch.setattr("GameSentenceMiner.web.tadoku_api.save_stats_config", lambda value: saved.append(value))
    monkeypatch.setattr("GameSentenceMiner.util.tadoku_sync.requests.Session", lambda: session)

    response = app.test_client().post("/api/tadoku/auth/refresh")

    assert response.status_code == 200
    assert response.get_json() == {"authenticated": True}
    assert config.tadoku_session_cookie == "fresh-cookie"
    assert saved == [config]
    assert len(session.requests) == 1
    assert session.requests[0][1] == "https://tadoku.app/api/internal/identity/login"
    assert session.requests[0][2]["json"] == {"email": "reader@example.com", "password": "password-secret"}


def test_tadoku_api_failed_manual_refresh_keeps_saved_login_and_sync_history(monkeypatch):
    app = flask.Flask(__name__)
    app.config["TESTING"] = True
    register_tadoku_api_routes(app)
    config = _config(tadoku_session_cookie="old-cookie")
    original_settings = vars(config).copy()
    StatsExportStateTable.mark_successful_export(TADOKU_CURSOR_KEY, 100.0)
    saved = []
    session = _TadokuSession(_tadoku_response(401))
    monkeypatch.setattr("GameSentenceMiner.web.tadoku_api.get_stats_config", lambda: config)
    monkeypatch.setattr("GameSentenceMiner.web.tadoku_api.save_stats_config", lambda value: saved.append(value))
    monkeypatch.setattr("GameSentenceMiner.util.tadoku_sync.requests.Session", lambda: session)

    response = app.test_client().post("/api/tadoku/auth/refresh")

    assert response.status_code == 401
    assert "email and password" in response.get_json()["error"]
    assert saved == []
    assert vars(config) == original_settings
    assert StatsExportStateTable.get_last_successful_export_at(TADOKU_CURSOR_KEY) == 100.0


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
    assert response.get_json()["error"] == "Save a Tadoku email and password first"
