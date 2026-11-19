from types import SimpleNamespace

from GameSentenceMiner.native import history
from GameSentenceMiner.util.config import feature_flags
from GameSentenceMiner.util.cron import anki_card_sync as sync
from GameSentenceMiner.util.cron import run_crons
from GameSentenceMiner.web import anki_api_endpoints


def test_full_and_incremental_use_desktop_without_starting_another_interpreter(monkeypatch):
    completed = []
    invalidated = []
    config = SimpleNamespace(anki=SimpleNamespace(url="http://localhost:8765", word_field="語", note_type='My "Model"'))
    monkeypatch.setattr(sync, "get_config", lambda: config)
    monkeypatch.setattr(feature_flags, "is_tokenization_enabled", lambda: True)
    monkeypatch.setattr(history, "manages_anki_sync", lambda db: True)
    monkeypatch.setattr(
        history,
        "sync_anki",
        lambda db, url, field, query, notes: completed.append((url, field, query, notes)) or {"skipped": False},
    )
    monkeypatch.setattr(anki_api_endpoints, "invalidate_anki_data_cache", lambda: invalidated.append(True))
    assert not run_crons._can_isolate_task(run_crons._TASK_REGISTRY["anki_card_sync"])
    assert sync.run_full_sync() == {"skipped": False}
    assert sync.run_incremental_sync([9, 3]) == {"skipped": False}
    assert [item[-1] for item in completed] == [None, [9, 3]]
    assert all(item[2] == sync._build_sync_query() for item in completed)
    assert len(invalidated) == 2
