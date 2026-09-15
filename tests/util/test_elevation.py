from types import SimpleNamespace

import pytest

from GameSentenceMiner.util import elevation


@pytest.mark.parametrize("admin", [0, 1])
def test_windows_admin_checks_current_process(monkeypatch, admin):
    monkeypatch.setattr(elevation, "sys", SimpleNamespace(platform="win32"))
    monkeypatch.setattr(
        elevation.ctypes,
        "windll",
        SimpleNamespace(shell32=SimpleNamespace(IsUserAnAdmin=lambda: admin)),
        raising=False,
    )

    assert elevation.is_windows_admin() is bool(admin)


@pytest.mark.parametrize("platform", ["linux", "darwin"])
def test_other_platforms_do_not_call_windows_api(monkeypatch, platform):
    monkeypatch.setattr(elevation, "sys", SimpleNamespace(platform=platform))
    monkeypatch.setattr(elevation.ctypes, "windll", None, raising=False)

    assert elevation.is_windows_admin() is False
