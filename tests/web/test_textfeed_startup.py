import threading
from http.client import HTTPConnection
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from GameSentenceMiner.util.concurrency.transport import AsyncTransportRuntime
from GameSentenceMiner.web import texthooking_page


@pytest.mark.parametrize("admin, enabled", [(True, True), (False, True), (True, False), (False, False)])
def test_textfeed_startup_respects_elevation_without_stopping_server(monkeypatch, admin, enabled):
    config = SimpleNamespace(
        general=SimpleNamespace(open_multimine_on_startup=enabled, single_port=7275),
        advanced=SimpleNamespace(localhost_bind_address="127.0.0.1"),
    )
    open_browser = Mock()
    browser_opened = threading.Event()
    open_browser.side_effect = lambda _url: browser_opened.set()

    def start_gateway(host, port, *, on_ready=None):
        open_browser.assert_not_called()
        if on_ready is not None:
            on_ready()
        return True

    gateway = Mock(side_effect=start_gateway)
    info = Mock()
    monkeypatch.setattr(texthooking_page, "get_config", lambda: config)
    monkeypatch.setattr(texthooking_page, "is_windows_admin", lambda: admin)
    monkeypatch.setattr(texthooking_page.webbrowser, "open", open_browser)
    monkeypatch.setattr(texthooking_page.logger, "info", info)
    monkeypatch.setattr(texthooking_page, "start_default_websocket_server", lambda: None)
    monkeypatch.setattr(texthooking_page, "_start_legacy_moved_page_server", lambda: None)
    monkeypatch.setattr(texthooking_page, "_try_start_single_port_gateway", gateway)

    texthooking_page.start_web_server()

    gateway.assert_called_once()
    assert gateway.call_args.args == ("127.0.0.1", 7275)
    assert config.general.open_multimine_on_startup is enabled
    if enabled and not admin:
        assert browser_opened.wait(timeout=2)
        open_browser.assert_called_once_with("http://localhost:7275")
    else:
        open_browser.assert_not_called()
    if enabled and admin:
        assert any("administrator" in call.args[0] for call in info.call_args_list)
    else:
        info.assert_not_called()


@pytest.mark.parametrize("bind_fails", [False, True])
def test_textfeed_fallback_opens_only_after_waitress_binds(monkeypatch, bind_fails):
    config = SimpleNamespace(
        general=SimpleNamespace(open_multimine_on_startup=True, single_port=8123),
        advanced=SimpleNamespace(localhost_bind_address="127.0.0.1"),
    )
    browser_opened = threading.Event()
    open_browser = Mock(side_effect=lambda _url: browser_opened.set())
    server = Mock()

    def create_server(*args, **kwargs):
        open_browser.assert_not_called()
        if bind_fails:
            raise OSError("Address already in use")
        return server

    def run():
        assert browser_opened.wait(timeout=2)

    server.run.side_effect = run
    monkeypatch.setattr(texthooking_page, "get_config", lambda: config)
    monkeypatch.setattr(texthooking_page, "is_windows_admin", lambda: False)
    monkeypatch.setattr(texthooking_page.webbrowser, "open", open_browser)
    monkeypatch.setattr(texthooking_page, "start_default_websocket_server", lambda: None)
    monkeypatch.setattr(texthooking_page, "_start_legacy_moved_page_server", lambda: None)
    monkeypatch.setattr(texthooking_page, "_try_start_single_port_gateway", lambda *_args, **_kwargs: False)
    monkeypatch.setattr(texthooking_page, "create_server", create_server)

    if bind_fails:
        with pytest.raises(OSError, match="Address already in use"):
            texthooking_page.start_web_server()
        open_browser.assert_not_called()
        server.run.assert_not_called()
    else:
        texthooking_page.start_web_server()
        open_browser.assert_called_once_with("http://localhost:8123")
        server.run.assert_called_once()


@pytest.mark.parametrize("mode", ["shared_gateway", "standalone_gateway", "waitress"])
def test_startup_browser_can_load_textfeed_on_its_first_request(monkeypatch, mode):
    port = texthooking_page._find_free_port("127.0.0.1")
    config = SimpleNamespace(
        general=SimpleNamespace(open_multimine_on_startup=True, single_port=port),
        advanced=SimpleNamespace(localhost_bind_address="127.0.0.1"),
    )
    runtime = AsyncTransportRuntime(name="test-textfeed-startup") if mode == "shared_gateway" else None
    browser_finished = threading.Event()
    server_ready = threading.Event()
    failures = []
    on_ready = texthooking_page._open_texthooker_on_startup

    def open_browser(url):
        connection = HTTPConnection("127.0.0.1", port, timeout=3)
        try:
            assert url == f"http://localhost:{port}"
            connection.request("GET", "/")
            response = connection.getresponse()
            assert response.status == 302
            textfeed_path = response.getheader("Location")
            response.read()
            connection.request("GET", textfeed_path)
            response = connection.getresponse()
            assert response.status == 200
            assert b"<html" in response.read()
        except Exception as error:  # noqa: BLE001 - report browser failures on the test thread
            failures.append(error)
        finally:
            connection.close()
            browser_finished.set()

    def ready():
        on_ready()
        server_ready.set()

    def start():
        try:
            texthooking_page.start_web_server()
        except Exception as error:  # noqa: BLE001 - report server failures on the test thread
            failures.append(error)
            server_ready.set()
            browser_finished.set()

    browser = Mock(side_effect=open_browser)
    monkeypatch.setattr(texthooking_page, "get_config", lambda: config)
    monkeypatch.setattr(texthooking_page, "is_windows_admin", lambda: False)
    monkeypatch.setattr(texthooking_page.webbrowser, "open", browser)
    monkeypatch.setattr(texthooking_page, "start_default_websocket_server", lambda: None)
    monkeypatch.setattr(texthooking_page, "_start_legacy_moved_page_server", lambda: None)
    monkeypatch.setattr(texthooking_page, "_legacy_notice_server", None)
    monkeypatch.setattr(texthooking_page, "_legacy_notice_thread", None)
    monkeypatch.setattr(texthooking_page, "_waitress_servers", [])
    monkeypatch.setattr(texthooking_page, "_waitress_threads", [])
    monkeypatch.setattr(texthooking_page, "_open_texthooker_on_startup", ready)
    monkeypatch.setattr(
        texthooking_page,
        "_wait_for_tcp_port",
        Mock(side_effect=AssertionError("Use the listener's bound event instead of racing TCP probes")),
    )
    monkeypatch.setattr(
        texthooking_page, "websocket_manager", SimpleNamespace(_transport_runtime=runtime, get_ingress_port=lambda: 0)
    )
    if mode == "waitress":
        monkeypatch.setattr(texthooking_page, "_AIOHTTP_IMPORT_ERROR", ImportError("aiohttp unavailable"))

    thread = threading.Thread(target=start, name="test-textfeed-web-server")
    if runtime is not None:
        runtime.start()
    thread.start()
    try:
        assert server_ready.wait(timeout=5), "Web server did not become ready"
        assert browser_finished.wait(timeout=5), "Text Feed did not open"
        assert not failures
        browser.assert_called_once_with(f"http://localhost:{port}")
        if runtime is not None:
            # Let the startup caller observe readiness before shutting down.
            thread.join(timeout=3)
            assert not thread.is_alive()
    finally:
        texthooking_page.stop_web_server(timeout=3)
        thread.join(timeout=3)
        if runtime is not None:
            runtime.stop(timeout=3)
    assert not thread.is_alive()


@pytest.mark.parametrize("bind_host", ["127.0.0.1", "0.0.0.0"])
def test_legacy_redirect_listener_does_not_wait_for_reverse_dns(monkeypatch, bind_host):
    port = texthooking_page._find_free_port(bind_host)
    monkeypatch.setattr(texthooking_page, "_get_single_port", lambda: 7275)
    monkeypatch.setattr(texthooking_page, "_get_legacy_texthooker_port", lambda: port)
    monkeypatch.setattr(
        texthooking_page,
        "get_config",
        lambda: SimpleNamespace(advanced=SimpleNamespace(localhost_bind_address=bind_host)),
    )
    monkeypatch.setattr(texthooking_page, "_legacy_notice_server", None)
    monkeypatch.setattr(texthooking_page, "_legacy_notice_thread", None)
    monkeypatch.setattr(
        texthooking_page.socket, "getfqdn", Mock(side_effect=AssertionError("A local redirect needs no DNS lookup"))
    )

    texthooking_page._start_legacy_moved_page_server()
    server = texthooking_page._legacy_notice_server
    connection = HTTPConnection("127.0.0.1", port, timeout=2)
    try:
        connection.request("GET", "/stats?day=today")
        response = connection.getresponse()
        assert response.status == 301
        assert response.getheader("Location") == "http://localhost:7275/stats?day=today"
        response.read()
    finally:
        connection.close()
        server.shutdown()
        server.server_close()
        texthooking_page._legacy_notice_thread.join(timeout=2)
