import time

import pytest

from GameSentenceMiner.util.media import pause_history


@pytest.fixture
def history_file(tmp_path, monkeypatch):
    monkeypatch.setattr(pause_history, "submit_background_work", lambda fn: fn())
    path = tmp_path / "process_pause_history.json"
    pause_history._reset_for_tests(path)
    yield path
    pause_history._reset_for_tests()


def test_records_and_queries_overlapping_pauses(history_file):
    now = time.time()
    pause_history.record_pause(now - 100, now - 90)
    pause_history.record_pause(now - 50, now - 45)

    assert pause_history.get_pauses_between(now - 60, now) == [(now - 50, now - 45)]
    assert pause_history.get_pauses_between(now - 95, now - 80) == [(now - 100, now - 90)]


def test_pauses_survive_a_restart(history_file):
    now = time.time()
    pause_history.record_pause(now - 20, now - 10)

    pause_history._reset_for_tests(history_file)
    assert pause_history.get_pauses_between(now - 30, now) == [(now - 20, now - 10)]


def test_prunes_pauses_older_than_the_replay_buffer(history_file, monkeypatch):
    monkeypatch.setattr(pause_history.gsm_state, "replay_buffer_length", 300)
    now = time.time()
    retention = 300 + pause_history.RETENTION_MARGIN_SECONDS
    pause_history.record_pause(now - retention - 100, now - retention - 90)
    pause_history.record_pause(now - retention + 60, now - retention + 70)
    pause_history.record_pause(now - 5, now - 1)

    assert pause_history.get_pauses_between(0, now) == [
        (now - retention + 60, now - retention + 70),
        (now - 5, now - 1),
    ]


def test_the_file_is_written_off_the_resuming_thread(tmp_path, monkeypatch):
    submitted = []
    monkeypatch.setattr(pause_history, "submit_background_work", submitted.append)
    pause_history._reset_for_tests(tmp_path / "process_pause_history.json")

    pause_history.record_pause(time.time() - 2, time.time() - 1)

    assert submitted == [pause_history._save]
    assert not (tmp_path / "process_pause_history.json").exists()
    pause_history._reset_for_tests()


def test_remembered_clip_pauses_are_kept_however_old(history_file):
    old = time.time() - 90 * 24 * 60 * 60
    pause_history.remember_pauses([[old, old + 3], [old + 10, old + 11]])
    pause_history.record_pause(time.time() - 5, time.time() - 1)  # pruning the history leaves them alone

    assert pause_history.get_pauses_between(old - 1, old + 20) == [(old, old + 3), (old + 10, old + 11)]
    assert not history_file.read_text().count(str(old))


def test_remembered_pauses_do_not_duplicate_recorded_ones(history_file):
    now = time.time()
    pause_history.record_pause(now - 20, now - 10)
    pause_history.remember_pauses([[now - 20, now - 10], [now - 20, now - 10], [now - 8, now - 6]])

    assert pause_history.get_pauses_between(now - 30, now) == [(now - 20, now - 10), (now - 8, now - 6)]
