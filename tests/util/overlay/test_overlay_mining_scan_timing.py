import asyncio
from datetime import datetime, timedelta
from types import SimpleNamespace

from GameSentenceMiner.util.overlay import get_overlay_coords
from GameSentenceMiner.util.text_log import TextSource


def test_repeated_scans_preserve_first_seen_time_until_text_or_game_changes(monkeypatch):
    now = datetime(2026, 10, 27, 12)  # noqa: DTZ001 - GSM line times are local and naive.
    clock = SimpleNamespace(now=now)

    class FakeDatetime:
        @staticmethod
        def now():
            return clock.now

    monkeypatch.setattr(get_overlay_coords, "datetime", FakeDatetime)
    monkeypatch.setattr(get_overlay_coords, "get_overlay_config", lambda: SimpleNamespace(inject_scanned_lines=False))
    monkeypatch.setattr(get_overlay_coords.gsm_state, "last_overlay_scan_line", None)
    monkeypatch.setattr(get_overlay_coords.gsm_state, "current_game", "first game")

    def scan(text):
        asyncio.run(get_overlay_coords.OverlayProcessor._record_overlay_scan(None, text))
        return get_overlay_coords.gsm_state.last_overlay_scan_line

    assert scan("これは、同じ文章です。").time == now
    clock.now += timedelta(seconds=5)
    repeated = scan("これは 同じ文章です")
    assert repeated.time == now
    assert repeated.text == "これは 同じ文章です"

    clock.now += timedelta(seconds=2)
    assert scan("別の文章です").time == clock.now
    clock.now += timedelta(seconds=2)
    get_overlay_coords.gsm_state.current_game = "another game"
    assert scan("別の文章です").time == clock.now


def test_repeated_scan_does_not_keep_an_old_timestamp_forever(monkeypatch):
    now = datetime(2026, 10, 27, 12)  # noqa: DTZ001 - GSM line times are local and naive.
    clock = SimpleNamespace(now=now)

    class FakeDatetime:
        @staticmethod
        def now():
            return clock.now

    monkeypatch.setattr(get_overlay_coords, "datetime", FakeDatetime)
    monkeypatch.setattr(get_overlay_coords, "get_overlay_config", lambda: SimpleNamespace(inject_scanned_lines=False))
    monkeypatch.setattr(get_overlay_coords.gsm_state, "last_overlay_scan_line", None)
    monkeypatch.setattr(get_overlay_coords.gsm_state, "current_game", "game")
    asyncio.run(get_overlay_coords.OverlayProcessor._record_overlay_scan(None, "Same sentence"))
    clock.now += timedelta(seconds=31)

    asyncio.run(get_overlay_coords.OverlayProcessor._record_overlay_scan(None, "Same sentence"))

    assert get_overlay_coords.gsm_state.last_overlay_scan_line.time == clock.now


def test_overlay_benchmark_blocks_auto_injection_and_keeps_manual_mining_context(monkeypatch, tmp_path):
    from GameSentenceMiner import gametext
    from GameSentenceMiner.ocr import benchmark
    from GameSentenceMiner.text_pipeline.models import IngressAck, IngressStatus

    recorder = benchmark.OCRBenchmarkRecorder(tmp_path)
    recorder.set_enabled(True)
    monkeypatch.setattr(benchmark, "recorder", recorder)
    monkeypatch.setattr(get_overlay_coords, "get_overlay_config", lambda: SimpleNamespace(inject_scanned_lines=True))
    monkeypatch.setattr(get_overlay_coords.gsm_state, "last_overlay_scan_line", None)
    accepted = []

    def ingest(observation):
        accepted.append(observation)
        return SimpleNamespace(ack=IngressAck(IngressStatus.ACCEPTED, observation.observation_id))

    runtime = SimpleNamespace(ingest=ingest, wait_projected=lambda **_kwargs: None)
    monkeypatch.setattr(gametext, "get_authoritative_text_runtime", lambda: runtime)
    monkeypatch.setattr(gametext, "is_message_rate_limited", lambda _source: False)
    try:
        asyncio.run(get_overlay_coords.OverlayProcessor._record_overlay_scan(None, "automatic scan"))
        assert accepted == []
        assert get_overlay_coords.gsm_state.last_overlay_scan_line.text == "automatic scan"
        asyncio.run(
            get_overlay_coords.OverlayProcessor._record_overlay_scan(None, "manual scan", source=TextSource.HOTKEY)
        )
        assert [observation.raw_text for observation in accepted] == ["manual scan"]
        assert recorder.status()["counts"] == {}
    finally:
        recorder.set_enabled(False)
