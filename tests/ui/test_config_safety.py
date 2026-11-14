from __future__ import annotations

from types import SimpleNamespace


from GameSentenceMiner.ui.config.safety import safe_config_call, safe_config_callback, safe_config_methods


def test_safe_config_call_logs_and_swallows_exceptions(monkeypatch) -> None:
    logged: list[tuple[str, bool]] = []
    monkeypatch.setattr(
        "GameSentenceMiner.ui.config.safety.logger",
        SimpleNamespace(error=lambda message, exc_info=False: logged.append((message, exc_info))),
    )

    @safe_config_call(name="demo.callback", default="fallback")
    def callback() -> str:
        raise RuntimeError("boom")

    assert callback() == "fallback"
    assert logged == [("Config GUI error in demo.callback: boom", True)]


def test_safe_config_call_ignores_extra_signal_args() -> None:
    calls: list[str] = []

    @safe_config_call(name="demo.clicked")
    def callback() -> None:
        calls.append("ran")

    callback(False, "extra")

    assert calls == ["ran"]


def test_safe_config_methods_uses_annotation_fallback(monkeypatch) -> None:
    logged: list[tuple[str, bool]] = []
    monkeypatch.setattr(
        "GameSentenceMiner.ui.config.safety.logger",
        SimpleNamespace(error=lambda message, exc_info=False: logged.append((message, exc_info))),
    )

    @safe_config_methods()
    class DemoConfigGui:
        def should_continue(self) -> bool:
            raise RuntimeError("stop")

    assert DemoConfigGui().should_continue() is False
    assert logged == [("Config GUI error in DemoConfigGui.should_continue: stop", True)]


def test_safe_config_methods_ignore_extra_signal_args() -> None:
    calls: list[str] = []

    @safe_config_methods()
    class DemoConfigGui:
        def trigger(self) -> None:
            calls.append("ran")

    DemoConfigGui().trigger(False, "extra")  # NOSONAR(S930) decorator wraps trigger to absorb extra Qt signal args

    assert calls == ["ran"]


def test_safe_config_callback_ignores_extra_signal_args() -> None:
    calls: list[str] = []
    callback = safe_config_callback(lambda: calls.append("ran"), name="demo.signal")

    callback(False, "extra")

    assert calls == ["ran"]
