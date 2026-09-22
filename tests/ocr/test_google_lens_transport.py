import json
import threading
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

import pytest
from PIL import Image

from GameSentenceMiner.owocr.owocr import ocr as ocr_module


@pytest.fixture
def lens(monkeypatch):
    monkeypatch.setattr(ocr_module, "get_ocr_language", lambda: "ja")
    monkeypatch.setattr(ocr_module, "get_ocr_advanced_debug_logging", lambda: False)
    monkeypatch.setattr(ocr_module.GoogleLens, "_get_locale_metadata", lambda self: ("DE", "Europe/Berlin"))
    engine = ocr_module.GoogleLens(get_furigana_sens_from_file=False)
    yield engine
    engine.close()


@pytest.fixture
def fake_sessions(monkeypatch):
    sessions = []

    class FakeSession:
        def __init__(self, **kwargs):
            self.options = kwargs
            self.requests = []
            self.closed = False
            sessions.append(self)

        def post(self, url, **kwargs):
            assert not self.closed
            self.requests.append((url, kwargs))
            return SimpleNamespace(status_code=200, content=b"", infos={})

        def close(self):
            assert not self.closed
            self.closed = True

    def unexpected_post(*args, **kwargs):
        pytest.fail("Lens must reuse sessions instead of making one-off requests")

    monkeypatch.setattr(ocr_module.curl_cffi, "Session", FakeSession)
    monkeypatch.setattr(ocr_module.curl_cffi, "post", unexpected_post)
    return sessions


def test_lens_reuses_session_and_keeps_lossless_image_payload(lens, fake_sessions):
    image = Image.new("RGB", (100, 60), (12, 34, 56))
    for _ in range(2):
        assert lens(image)[0] is True

    assert len(fake_sessions) == 1
    session = fake_sessions[0]
    assert session.options["use_thread_local_curl"] is False
    assert session.options["discard_cookies"] is True
    assert len(session.requests) == 2
    request = lens._lens_proto_deps["LensOverlayServerRequestPb2"]()
    request.ParseFromString(session.requests[0][1]["data"])
    assert request.objects_request.image_data.payload.image_bytes == ocr_module.pil_image_to_bytes(image)
    assert request.objects_request.request_context.client_context.locale_context.region == "DE"
    assert request.objects_request.request_context.client_context.locale_context.time_zone == "Europe/Berlin"


def test_lens_language_tracks_ocr_setting_independently_of_region(lens, fake_sessions, monkeypatch):
    monkeypatch.setattr(ocr_module, "get_ocr_language", lambda: "ko")
    assert lens(Image.new("RGB", (10, 10)))[0] is True
    request = lens._lens_proto_deps["LensOverlayServerRequestPb2"]()
    request.ParseFromString(fake_sessions[0].requests[0][1]["data"])
    locale = request.objects_request.request_context.client_context.locale_context
    assert (locale.language, locale.region, locale.time_zone) == ("ko", "DE", "Europe/Berlin")


def test_concurrent_requests_use_separate_sessions_and_close_safely(lens, fake_sessions):
    ready = threading.Barrier(3)
    release = threading.Event()

    def request():
        with lens._request_session() as session:
            ready.wait(timeout=5)
            assert release.wait(timeout=5)
            assert not session.closed
            return session

    with ThreadPoolExecutor(max_workers=2) as executor:
        pending = [executor.submit(request) for _ in range(2)]
        try:
            ready.wait(timeout=5)
            lens.close()
            assert all(not session.closed for session in fake_sessions)
        finally:
            release.set()
        used = [future.result(timeout=5) for future in pending]

    assert used[0] is not used[1]
    assert all(session.closed for session in used)
    assert lens(Image.new("RGB", (10, 10))) == (False, "Google Lens is not available.")
    lens.close()


def test_close_releases_idle_sessions(lens, fake_sessions):
    assert lens(Image.new("RGB", (10, 10)))[0] is True
    lens.close()
    assert fake_sessions[0].closed
    lens.close()


@pytest.mark.parametrize(
    ("exc_type", "message"),
    [
        (ocr_module.curl_cffi.requests.exceptions.Timeout, "Request timeout!"),
        (ocr_module.curl_cffi.requests.exceptions.ConnectionError, "Connection error!"),
    ],
)
def test_transport_error_does_not_retry_or_break_next_scan(lens, fake_sessions, monkeypatch, exc_type, message):
    image = Image.new("RGB", (10, 10))
    assert lens(image)[0] is True
    session = fake_sessions[0]
    original_post = session.post
    failures = []

    def fail(*args, **kwargs):
        failures.append(True)
        raise exc_type("network unavailable", code=28)

    monkeypatch.setattr(session, "post", fail)
    assert lens(image) == (False, message)
    assert len(failures) == 1
    monkeypatch.setattr(session, "post", original_post)
    assert lens(image)[0] is True
    assert len(fake_sessions) == 1


@pytest.mark.parametrize(
    ("locale_name", "region"),
    [("de_DE", "DE"), ("ko-KR", "KR"), ("zh_Hant_TW", "TW"), ("en_US.UTF-8", "US"), (None, ""), ("C", "")],
)
def test_lens_uses_system_locale_region_and_iana_timezone(monkeypatch, locale_name, region):
    monkeypatch.setattr(ocr_module, "sys", SimpleNamespace(platform="linux"))
    monkeypatch.setattr(ocr_module, "locale", SimpleNamespace(getlocale=lambda: (locale_name, None)))
    monkeypatch.setattr(ocr_module, "get_localzone_name", lambda: "Europe/Berlin")
    assert ocr_module.GoogleLens._get_locale_metadata() == (region, "Europe/Berlin")


def test_lens_reads_windows_bcp47_locale_instead_of_legacy_locale_names(monkeypatch):
    def locale_name(buffer, length):
        buffer.value = "zh-Hant-TW"
        return len(buffer.value) + 1

    monkeypatch.setattr(ocr_module, "sys", SimpleNamespace(platform="win32"))
    monkeypatch.setattr(
        ocr_module,
        "ctypes",
        SimpleNamespace(
            create_unicode_buffer=ocr_module.ctypes.create_unicode_buffer,
            windll=SimpleNamespace(kernel32=SimpleNamespace(GetUserDefaultLocaleName=locale_name)),
        ),
    )
    monkeypatch.setattr(ocr_module, "get_localzone_name", lambda: "Asia/Taipei")
    assert ocr_module.GoogleLens._get_locale_metadata() == ("TW", "Asia/Taipei")


def test_lens_omits_unavailable_locale_metadata(monkeypatch):
    def fail():
        raise ValueError("locale or timezone unavailable")

    monkeypatch.setattr(ocr_module, "sys", SimpleNamespace(platform="linux"))
    monkeypatch.setattr(ocr_module, "locale", SimpleNamespace(getlocale=fail))
    monkeypatch.setattr(ocr_module, "get_localzone_name", fail)
    assert ocr_module.GoogleLens._get_locale_metadata() == ("", "")


def test_lens_timing_diagnostics_are_opt_in_and_exclude_request_contents(lens, fake_sessions, monkeypatch):
    events = []
    monkeypatch.setattr(ocr_module, "emit_ocr_debug", lambda enabled, event, **fields: events.append((event, fields)))
    image = Image.new("RGB", (10, 10))
    assert lens(image)[0] is True
    assert events == []

    info = ocr_module.curl_cffi.CurlInfo
    response = SimpleNamespace(
        status_code=200,
        content=b"",
        primary_ip="192.0.2.1",
        http_version=3,
        infos={info.NAMELOOKUP_TIME: 0.002, info.STARTTRANSFER_TIME: 0.25, info.NUM_CONNECTS: 0},
    )
    monkeypatch.setattr(fake_sessions[0], "post", lambda *args, **kwargs: response)
    monkeypatch.setattr(ocr_module, "get_ocr_advanced_debug_logging", lambda: True)
    assert lens(image)[0] is True
    event, fields = events[-1]
    assert event == "google_lens.request"
    assert fields["dns_finished_ms"] == 2
    assert fields["first_byte_ms"] == 250
    assert fields["new_connections"] == 0
    assert fields["status_code"] == 200
    assert fields["payload_bytes"] > fields["image_bytes"] > 0
    assert fields["server_ip"] == "192.0.2.1"
    assert info.STARTTRANSFER_TIME in fake_sessions[0].curl_infos
    serialized = json.dumps(fields)
    assert "X-Goog-Api-Key" not in serialized
    assert isinstance(fields["image_bytes"], int)
    assert "data" not in fields and "headers" not in fields and "content" not in fields


def test_lens_failed_request_records_available_timings(lens, fake_sessions, monkeypatch):
    assert lens(Image.new("RGB", (10, 10)))[0] is True
    events = []
    info = ocr_module.curl_cffi.CurlInfo
    response = SimpleNamespace(status_code=0, infos={info.TOTAL_TIME: 20.0})

    def timeout(*args, **kwargs):
        raise ocr_module.curl_cffi.requests.exceptions.Timeout("private proxy details", code=28, response=response)

    monkeypatch.setattr(fake_sessions[0], "post", timeout)
    monkeypatch.setattr(ocr_module, "get_ocr_advanced_debug_logging", lambda: True)
    monkeypatch.setattr(ocr_module, "emit_ocr_debug", lambda enabled, event, **fields: events.append(fields))
    assert lens(Image.new("RGB", (10, 10))) == (False, "Request timeout!")
    assert events[-1]["transfer_total_ms"] == 20000
    assert events[-1]["error_type"] == "Timeout"
    assert events[-1]["curl_error_code"] == 28
    assert "private proxy details" not in json.dumps(events)


@pytest.mark.parametrize("server_closes_first_connection", [False, True])
def test_real_http_connection_is_reused_across_worker_threads(lens, monkeypatch, server_closes_first_connection):
    connections = []
    events = []
    monkeypatch.setattr(ocr_module, "get_ocr_advanced_debug_logging", lambda: True)
    monkeypatch.setattr(ocr_module, "emit_ocr_debug", lambda enabled, event, **fields: events.append(fields))

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_POST(self):
            self.rfile.read(int(self.headers["Content-Length"]))
            connections.append(self.client_address)
            self.send_response(200)
            self.send_header("Content-Length", "0")
            if server_closes_first_connection and len(connections) == 1:
                self.send_header("Connection", "close")
            self.end_headers()

        def log_message(self, *args):
            pass

    original_post = ocr_module.curl_cffi.Session.post

    with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
        server_thread = threading.Thread(target=server.serve_forever, daemon=True)
        server_thread.start()

        def local_post(session, url, **kwargs):
            return original_post(session, f"http://127.0.0.1:{server.server_port}/", proxy="", **kwargs)

        monkeypatch.setattr(ocr_module.curl_cffi.Session, "post", local_post)
        try:
            # A fresh worker each time: thread-local handles would lose the connection.
            for _ in range(3):
                with ThreadPoolExecutor(max_workers=1) as executor:
                    assert executor.submit(lens, Image.new("RGB", (10, 10))).result(timeout=5)[0] is True
        finally:
            lens.close()
            server.shutdown()
            server_thread.join(timeout=5)

    assert len(connections) == 3
    assert len(set(connections)) == (2 if server_closes_first_connection else 1)
    assert [event["new_connections"] for event in events] == [1, int(server_closes_first_connection), 0]
    assert all(event["upload_finished_ms"] >= 0 for event in events)
    assert all(event["transfer_total_ms"] > 0 for event in events)
