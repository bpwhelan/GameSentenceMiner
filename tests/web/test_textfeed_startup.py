from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from GameSentenceMiner.web import texthooking_page


@pytest.mark.parametrize("admin, enabled", [(True, True), (False, True), (True, False), (False, False)])
def test_textfeed_startup_respects_elevation_without_stopping_server(monkeypatch, admin, enabled):
    config = SimpleNamespace(
        general=SimpleNamespace(open_multimine_on_startup=enabled, single_port=7275),
        advanced=SimpleNamespace(localhost_bind_address="127.0.0.1"),
    )
    open_browser = Mock()
    gateway = Mock(return_value=True)
    info = Mock()
    monkeypatch.setattr(texthooking_page, "get_config", lambda: config)
    monkeypatch.setattr(texthooking_page, "is_windows_admin", lambda: admin)
    monkeypatch.setattr(texthooking_page.webbrowser, "open", open_browser)
    monkeypatch.setattr(texthooking_page.logger, "info", info)
    monkeypatch.setattr(texthooking_page, "start_default_websocket_server", lambda: None)
    monkeypatch.setattr(texthooking_page, "_start_legacy_moved_page_server", lambda: None)
    monkeypatch.setattr(texthooking_page, "_try_start_single_port_gateway", gateway)

    texthooking_page.start_web_server()

    gateway.assert_called_once_with("127.0.0.1", 7275)
    assert config.general.open_multimine_on_startup is enabled
    if enabled and not admin:
        open_browser.assert_called_once_with("http://localhost:7275")
    else:
        open_browser.assert_not_called()
    if enabled and admin:
        assert any("administrator" in call.args[0] for call in info.call_args_list)
    else:
        info.assert_not_called()
