import os
from datetime import date
from types import SimpleNamespace

from GameSentenceMiner.native import history
from GameSentenceMiner.util.communication import bus_client


def test_startup_schema_uses_the_authenticated_writer(monkeypatch):
    calls = []
    db = SimpleNamespace(db_path=":memory:", read_only=False, run_external_write=lambda work: work())
    client = SimpleNamespace(connected=False)
    monkeypatch.setenv("GSM_NATIVE_SCHEMA", "1")
    monkeypatch.setattr(history, "managed", lambda db: True)
    monkeypatch.setattr(bus_client, "get_bus", lambda: client)
    monkeypatch.setattr(history, "request", lambda operation, **fields: calls.append((operation, fields)))
    assert not history.migrate_schema(db, "ja")
    assert not history.configure_vocabulary_schema(db, False)
    assert calls == []
    client.connected = True
    assert history.migrate_schema(db, "ja")
    assert history.configure_vocabulary_schema(db, False) == "desktop"
    assert calls == [
        ("migrateSchema", {"language": "ja", "timeout": None}),
        ("configureVocabulary", {"enabled": False, "timeout": None}),
    ]


def test_large_mined_fields_fall_back_before_any_write():
    writes = []
    db = SimpleNamespace(run_external_write=lambda action: writes.append(action))
    assert history.update_mined_line(db, line_id="line", translation="\0" * (2**21)) is None
    assert history.update_mined_line(db, line_id="line", note_id=2**90) is None
    assert not writes


def test_only_primary_backend_can_delegate_active_database(monkeypatch, tmp_path):
    monkeypatch.setenv("GSM_NATIVE_HISTORY", "1")
    monkeypatch.setenv("GSM_CLIENT_ID", "backend")
    monkeypatch.setenv("GSM_DATA_DIR", str(tmp_path))
    client = SimpleNamespace(client_id="backend", _process_id=os.getpid(), _main_future=object())
    monkeypatch.setattr(bus_client, "_client", client)
    db = SimpleNamespace(read_only=False, db_path=str(tmp_path / "gsm.db"), _on_writer_thread=lambda: False)
    assert history.managed(db)
    client._process_id = -1
    assert not history.managed(db)
    client._process_id = os.getpid()
    db.db_path = str(tmp_path / "import.db")
    assert not history.managed(db)
    db.db_path = str(tmp_path / "gsm.db")
    db._on_writer_thread = lambda: True
    assert not history.managed(db)


def test_anki_reports_use_local_reads_with_older_desktop_or_lost_connection(monkeypatch):
    sent = []

    def disconnect(operation, **fields):
        sent.append(operation)
        raise ConnectionError("disconnected")

    monkeypatch.setattr(history, "request", disconnect)
    monkeypatch.setattr(history, "managed", lambda db: True)
    monkeypatch.delenv("GSM_NATIVE_ANKI_REPORTS", raising=False)
    db = object()
    assert history.maturity_report(db, date(2024, 1, 5)) is None
    assert history.anki_game_stats(db, "Game", None, None) is None
    assert not sent

    monkeypatch.setenv("GSM_NATIVE_ANKI_REPORTS", "1")
    assert history.anki_game_stats(None, "Game", None, None) is None
    assert history.anki_game_stats(db, "Game", 2**63, None) is None
    assert not sent
    assert history.anki_game_stats(db, "Game", 7, None) is None
    assert sent == ["ankiGameStats"]


def test_search_queries_fall_back_on_missing_flag_disconnect_or_unsupported_regex(monkeypatch):
    sent = []

    def fake_request(operation, **fields):
        sent.append((operation, fields))
        if fields.get("query") == "[bad":
            return {"fallback": "invalidRegex"}
        if fields.get("query") == "disconnect":
            raise ConnectionError("lost desktop")
        return {"results": [], "total": 0, "page": 1, "page_size": 20, "total_pages": 0}

    monkeypatch.setattr(history, "request", fake_request)
    monkeypatch.setattr(history, "managed", lambda db: True)
    monkeypatch.delenv("GSM_NATIVE_SEARCH", raising=False)
    db = object()
    assert history.search_sentences(db, query="hello") is None
    assert history.search_duplicates(db) is None
    assert not sent

    monkeypatch.setenv("GSM_NATIVE_SEARCH", "1")
    assert history.search_sentences(db, query="[bad", use_regex=True) is None
    assert history.search_sentences(db, query="disconnect") is None
    ok = history.search_sentences(db, query="hello", game="G1", sort="date_asc", page=2, page_size=10)
    assert ok == {"results": [], "total": 0, "page": 1, "page_size": 20, "total_pages": 0}
    dup = history.search_duplicates(
        db, game="G1", time_window_minutes=10, case_sensitive=True, ignore_time_window=False
    )
    assert dup is not None
    assert [op for op, _ in sent] == [
        "searchSentences",
        "searchSentences",
        "searchSentences",
        "searchDuplicates",
    ]


def test_maintenance_tokenization_and_dashboard_facades_guard_and_fallback(monkeypatch):
    sent = []

    def fake_request(operation, **fields):
        sent.append(operation)
        if operation == "previewTextDeletion" and fields.get("regex_pattern") == "[bad":
            return {"fallback": "invalidRegex"}
        return {"ok": True}

    monkeypatch.setattr(history, "request", fake_request)
    monkeypatch.setattr(history, "managed", lambda db: True)
    for var in ("GSM_NATIVE_MAINTENANCE", "GSM_NATIVE_TOKENIZATION", "GSM_NATIVE_DASHBOARD_STATS"):
        monkeypatch.delenv(var, raising=False)
    db = SimpleNamespace(run_external_write=lambda fn: fn())

    assert history.games_list(db) is None
    assert history.tokenization_status(db) is None
    assert (
        history.game_stats(db, game_id="g1", today=date(2026, 11, 19), session_gap=300, tokenization_enabled=False)
        is None
    )
    assert history.dashboard_stats(db, today=date(2026, 11, 19), session_gap=300) is None
    assert not sent

    monkeypatch.setenv("GSM_NATIVE_MAINTENANCE", "1")
    monkeypatch.setenv("GSM_NATIVE_TOKENIZATION", "1")
    monkeypatch.setenv("GSM_NATIVE_DASHBOARD_STATS", "1")
    assert history.preview_text_deletion(db, regex_pattern="[bad", use_regex=True) is None
    assert history.games_list(db) == {"ok": True}
    assert history.delete_text_lines_native(db, exact_text="foo") == {"ok": True}
    assert history.deduplicate_lines_native(db, games=["all"]) == {"ok": True}
    assert history.tokenization_status(db) == {"ok": True}
    assert history.game_stats(
        db, game_id="g1", today=date(2026, 11, 19), session_gap=300, tokenization_enabled=True
    ) == {"ok": True}
    assert history.dashboard_stats(db, today=date(2026, 11, 19), session_gap=300) == {"ok": True}
    assert sent == [
        "previewTextDeletion",
        "gamesList",
        "deleteTextLines",
        "deduplicateLines",
        "tokenizationStatus",
        "gameStats",
        "dashboardStats",
    ]
