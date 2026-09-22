from types import SimpleNamespace

import pytest

from GameSentenceMiner.ocr import lens_latency


@pytest.fixture
def runtime(monkeypatch):
    state = SimpleNamespace(calls=0, closed=False, fail=False, available=True, images=[], sleeps=[])

    class FakeLens:
        def __init__(self, **kwargs):
            self.available = state.available

        def __call__(self, image):
            state.calls += 1
            state.images.append(image.copy())
            lens_latency.ocr.emit_ocr_debug(
                True,
                "google_lens.request",
                request_ms=150.0,
                tls_finished_ms=50.0 if state.calls == 1 else 0.0,
                first_byte_ms=145.0,
                new_connections=int(state.calls == 1),
                status_code=503 if state.fail else 200,
                image_bytes=3000,
            )
            return (False, "Unknown error!") if state.fail else (True, lens_latency.TEST_TEXT)

        def close(self):
            state.closed = True

    monkeypatch.setattr(lens_latency.ocr, "GoogleLens", FakeLens)
    monkeypatch.setattr(lens_latency.ocr, "get_ocr_language", lambda: "ja")
    monkeypatch.setattr(lens_latency.time, "sleep", state.sleeps.append)
    monkeypatch.setattr(lens_latency, "version", lambda name: "test-version")
    return state


def test_latency_command_measures_cold_and_repeat_requests_without_changing_settings(runtime, monkeypatch, capsys):
    times = iter([0.0, 0.4, 1.0, 1.2, 2.0, 2.25])
    monkeypatch.setattr(lens_latency.time, "perf_counter", lambda: next(times))
    original_debug = lens_latency.ocr.get_ocr_advanced_debug_logging
    original_emitter = lens_latency.ocr.emit_ocr_debug

    assert lens_latency.run_latency_test(3) == 0

    output = capsys.readouterr().out
    assert "400.0 ms" in output
    assert "225.0 ms" in output
    assert "2/2 repeat requests reused a connection" in output
    assert "3/3 OCR text checks passed" in output
    assert runtime.calls == 3
    assert runtime.closed
    assert runtime.sleeps == [0.5, 0.5]
    assert all(image.size == (960, 240) for image in runtime.images)
    assert all(image.tobytes() == runtime.images[0].tobytes() for image in runtime.images)
    assert lens_latency.ocr.get_ocr_advanced_debug_logging is original_debug
    assert lens_latency.ocr.emit_ocr_debug is original_emitter


def test_latency_command_stops_on_failure_and_closes_session(runtime, capsys):
    runtime.fail = True

    assert lens_latency.run_latency_test(6) == 1

    output = capsys.readouterr().out
    assert "503" in output
    assert "Stopped after request 1" in output
    assert "median" not in output
    assert runtime.calls == 1
    assert runtime.closed
    assert runtime.sleeps == []


def test_latency_command_reports_unavailable_engine(runtime, capsys):
    runtime.available = False

    assert lens_latency.run_latency_test(6) == 1

    assert "Google Lens is unavailable" in capsys.readouterr().out
    assert runtime.calls == 0
    assert runtime.closed


@pytest.mark.parametrize("runs", ["0", "1", "21", "invalid"])
def test_latency_command_rejects_invalid_sample_counts(runtime, runs):
    with pytest.raises(SystemExit) as exc:
        lens_latency.main(["--runs", runs])
    assert exc.value.code == 2
    assert runtime.calls == 0
