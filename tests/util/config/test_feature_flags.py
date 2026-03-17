from types import SimpleNamespace

from GameSentenceMiner.util.config import feature_flags


def test_is_experimental_enabled_false_when_master_missing(monkeypatch):
    monkeypatch.setattr(feature_flags, "get_master_config", lambda: None)
    assert feature_flags._is_experimental_enabled() is False


def test_is_experimental_enabled_reads_nested_config(monkeypatch):
    master = SimpleNamespace(experimental=SimpleNamespace(enable_experimental_features=True))
    monkeypatch.setattr(feature_flags, "get_master_config", lambda: master)
    assert feature_flags._is_experimental_enabled() is True


def test_experimental_feature_returns_default_when_disabled(monkeypatch):
    monkeypatch.setattr(feature_flags, "get_master_config", lambda: None)

    @feature_flags.experimental_feature(default_return="disabled")
    def run():
        return "enabled"

    assert run() == "disabled"


def test_experimental_feature_executes_when_enabled(monkeypatch):
    master = SimpleNamespace(experimental=SimpleNamespace(enable_experimental_features=True))
    monkeypatch.setattr(feature_flags, "get_master_config", lambda: master)

    @feature_flags.experimental_feature(default_return="disabled")
    def run(value):
        return f"enabled:{value}"

    assert run("ok") == "enabled:ok"


def test_process_pausing_feature_returns_default_when_disabled(monkeypatch):
    master = SimpleNamespace(process_pausing=SimpleNamespace(enabled=False))
    monkeypatch.setattr(feature_flags, "get_master_config", lambda: master)

    @feature_flags.process_pausing_feature(default_return=123)
    def run():
        return 999

    assert run() == 123


def test_process_pausing_feature_executes_when_enabled(monkeypatch):
    master = SimpleNamespace(process_pausing=SimpleNamespace(enabled=True))
    monkeypatch.setattr(feature_flags, "get_master_config", lambda: master)

    @feature_flags.process_pausing_feature(default_return=None)
    def run(x, y):
        return x + y

    assert run(2, 3) == 5
