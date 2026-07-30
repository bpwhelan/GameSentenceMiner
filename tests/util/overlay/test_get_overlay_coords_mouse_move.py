from types import SimpleNamespace

from GameSentenceMiner.util.overlay import get_overlay_coords


def test_mouse_move_scan_is_allowed_without_target_hwnd(monkeypatch):
    processor = SimpleNamespace(
        window_monitor=SimpleNamespace(
            target_hwnd=None,
            last_state=None,
        )
    )

    monkeypatch.setattr(get_overlay_coords, "is_windows", lambda: True)
    monkeypatch.setattr(get_overlay_coords, "user32", None)

    assert get_overlay_coords._cursor_allows_mouse_move_scan(processor, (100, 200))
