from __future__ import annotations

from types import SimpleNamespace

from GameSentenceMiner.ui.config.tabs import experimental


class _FakeLineEdit:
    def __init__(self, text: str = "") -> None:
        self._text = text

    def text(self) -> str:
        return self._text

    def setText(self, text: str) -> None:
        self._text = text


def test_append_csv_entry_text_appends_with_normalized_spacing() -> None:
    updated_text, added = experimental._append_csv_entry_text("steam.exe, discord.exe", "game.exe")

    assert added is True
    assert updated_text == "steam.exe, discord.exe, game.exe"


def test_append_csv_entry_text_skips_duplicates_case_insensitively() -> None:
    updated_text, added = experimental._append_csv_entry_text("steam.exe, game.exe", "GAME.EXE")

    assert added is False
    assert updated_text == "steam.exe, game.exe"


def test_add_current_target_window_to_list_updates_line_edit(monkeypatch) -> None:
    line_edit = _FakeLineEdit("steam.exe")
    info_calls: list[tuple[str, str]] = []

    monkeypatch.setattr(
        experimental,
        "_get_current_target_window_details",
        lambda: ("game.exe", "Test Window"),
    )
    monkeypatch.setattr(
        experimental.QMessageBox,
        "information",
        lambda _parent, title, text: info_calls.append((title, text)),
    )

    experimental._add_current_target_window_to_list(SimpleNamespace(), line_edit, "allowlist")

    assert line_edit.text() == "steam.exe, game.exe"
    assert info_calls == [
        (
            "Allowlist Updated",
            "Added game.exe (Test Window) to the allowlist.",
        )
    ]


def test_add_current_target_window_to_list_shows_warning_when_target_lookup_fails(monkeypatch) -> None:
    line_edit = _FakeLineEdit("steam.exe")
    warning_calls: list[tuple[str, str]] = []

    monkeypatch.setattr(
        experimental,
        "_get_current_target_window_details",
        lambda: (_ for _ in ()).throw(RuntimeError("No current target window found.")),
    )
    monkeypatch.setattr(
        experimental.QMessageBox,
        "warning",
        lambda _parent, title, text: warning_calls.append((title, text)),
    )

    experimental._add_current_target_window_to_list(SimpleNamespace(), line_edit, "denylist")

    assert line_edit.text() == "steam.exe"
    assert warning_calls == [
        (
            "Add Current Target Failed",
            "No current target window found.",
        )
    ]
