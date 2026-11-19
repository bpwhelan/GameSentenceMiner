from types import SimpleNamespace

from GameSentenceMiner.native import history
from GameSentenceMiner.util.database import db as db_module
from GameSentenceMiner.util.database.db import GameLinesTable


def test_capture_schedules_indexing_with_committed_desktop_write(monkeypatch):
    sent = []
    monkeypatch.setattr(history, "managed", lambda db: True)
    monkeypatch.setattr(history, "request", lambda operation, **kw: sent.append((operation, kw)))
    monkeypatch.setattr(GameLinesTable, "_db", SimpleNamespace(run_external_write=lambda action: action()))
    monkeypatch.setattr(db_module, "_is_tokenization_enabled", lambda: True)
    monkeypatch.setattr(
        "GameSentenceMiner.util.cron.tokenize_lines.enqueue_realtime_tokenization_batch",
        lambda _: sent.append(("python-worker", {})),
    )
    monkeypatch.setenv("GSM_NATIVE_WORD_INDEX", "1")
    line = SimpleNamespace(id="one", text="日本", scene="game", time=SimpleNamespace(timestamp=lambda: 1))
    assert GameLinesTable.persist_with_desktop([line], imported=True)
    assert len(sent) == 1
    assert sent[0][0] == "captureLines"
    assert sent[0][1]["dictionary"] in {"small", "core", "full"}


def test_startup_repair_waits_for_authenticated_desktop_before_dispatch(monkeypatch):
    from GameSentenceMiner.util.communication import bus_client
    from GameSentenceMiner.util.concurrency import work_pool
    from GameSentenceMiner.util.database import tokenization_tables as tables

    db = db_module.gsm_db
    pending = []
    calls = []
    monkeypatch.setenv("GSM_NATIVE_WORD_INDEX", "1")
    monkeypatch.setenv("GSM_CLIENT_ID", "backend")
    monkeypatch.setattr(bus_client, "is_bus_available", lambda: True)
    monkeypatch.setattr(bus_client, "get_bus", lambda: SimpleNamespace(on_first_connection=pending.append))
    monkeypatch.setattr(work_pool, "submit_background_work", lambda run: run())
    monkeypatch.setattr(
        tables, "recompute_word_first_seen_metadata", lambda db, only_missing: calls.append((db, only_missing))
    )
    tables._schedule_first_seen_backfill(db)
    assert not calls
    pending.pop()()
    assert calls == [(db, True)]
