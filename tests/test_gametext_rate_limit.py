from types import SimpleNamespace

import pytest

from GameSentenceMiner import gametext


@pytest.fixture(autouse=True)
def reset_rate_limit_state():
    gametext.message_timestamps.clear()
    gametext.rate_limit_active.clear()
    yield
    gametext.message_timestamps.clear()
    gametext.rate_limit_active.clear()


def test_rate_limit_trips_on_fifth_event_within_one_second(monkeypatch):
    event_times = iter((0.0, 0.2, 0.4, 0.6, 0.8, 0.9))
    monkeypatch.setattr(gametext.time, "monotonic", lambda: next(event_times))

    decisions = [gametext.is_message_rate_limited("texthook") for _ in range(6)]

    assert decisions == [False, False, False, False, True, True]


def test_rate_limit_recovers_after_short_quiet_period(monkeypatch):
    event_times = iter((0.0, 0.1, 0.2, 0.3, 0.4, 0.45, 0.76))
    monkeypatch.setattr(gametext.time, "monotonic", lambda: next(event_times))

    decisions = [gametext.is_message_rate_limited("texthook") for _ in range(7)]

    assert decisions == [False, False, False, False, True, True, False]
    assert gametext.rate_limit_active["texthook"] is False


def test_rate_limit_keeps_text_sources_independent(monkeypatch):
    event_times = iter((0.0, 0.1, 0.2, 0.3, 0.4, 0.41))
    monkeypatch.setattr(gametext.time, "monotonic", lambda: next(event_times))

    for _ in range(4):
        assert gametext.is_message_rate_limited("texthook") is False
    assert gametext.is_message_rate_limited("texthook") is True
    assert gametext.is_message_rate_limited("ocr") is False


def test_v2_intake_drops_rate_limited_hook_before_pipeline_work(monkeypatch):
    monkeypatch.setattr(gametext, "is_message_rate_limited", lambda source: source == "texthook")
    monkeypatch.setattr(
        gametext,
        "get_config",
        lambda: SimpleNamespace(general=SimpleNamespace(texthook_max_buffer_size=3000)),
    )
    monkeypatch.setattr(
        gametext,
        "apply_text_processing",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("processing should not run")),
    )

    result = gametext.ingest_text_v2_payload(
        {
            "text": "skipped VN line",
            "source": "texthook",
            "sourceInstance": "hook-42",
            "observationId": "spam-observation",
        }
    )

    assert result == {
        "status": "rejected",
        "observation_id": "spam-observation",
        "line_id": None,
        "stream_sequence": None,
        "revision": None,
        "reason": "skip spam detected",
        "matched_source": None,
    }
