from types import SimpleNamespace

from GameSentenceMiner.ui import qt_main


def test_shutdown_quits_qt_even_when_settings_have_never_been_opened(monkeypatch):
    queued = []
    calls = []
    monkeypatch.setattr(qt_main, "_qt_app", SimpleNamespace(quit=lambda: calls.append("quit")))
    monkeypatch.setattr(qt_main, "_config_window", None)
    monkeypatch.setattr(
        qt_main, "_dialog_manager", SimpleNamespace(_execute_on_gui_thread=SimpleNamespace(emit=queued.append))
    )

    qt_main.shutdown_qt_app()

    assert len(queued) == 1
    assert calls == []
    queued[0]()
    assert calls == ["quit"]


def test_shutdown_closes_existing_settings_on_the_gui_thread(monkeypatch):
    queued = []
    calls = []
    monkeypatch.setattr(qt_main, "_qt_app", SimpleNamespace(quit=lambda: calls.append("quit")))
    monkeypatch.setattr(qt_main, "_config_window", SimpleNamespace(close_window=lambda: calls.append("close")))
    monkeypatch.setattr(
        qt_main, "_dialog_manager", SimpleNamespace(_execute_on_gui_thread=SimpleNamespace(emit=queued.append))
    )

    qt_main.shutdown_qt_app()
    assert calls == []
    queued[0]()
    assert calls == ["close", "quit"]
