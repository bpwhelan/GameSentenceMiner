from types import SimpleNamespace

from GameSentenceMiner.util.platform.monitor_selection import (
    apply_monitor_selection_to_overlay,
    monitor_identity_from_bounds,
    resolve_monitor_descriptor,
)


def test_monitor_identity_includes_position_for_same_resolution_monitors():
    left_monitor = {"left": 0, "top": 0, "width": 1920, "height": 1080}
    right_monitor = {"left": 1920, "top": 0, "width": 1920, "height": 1080}

    assert monitor_identity_from_bounds(left_monitor) == "bounds:0:0:1920:1080"
    assert monitor_identity_from_bounds(right_monitor) == "bounds:1920:0:1920:1080"


def test_resolve_monitor_descriptor_prefers_stored_identity_over_index():
    monitors = [
        {"left": 0, "top": 0, "width": 1920, "height": 1080},
        {"left": 1920, "top": 0, "width": 1920, "height": 1080},
    ]

    selection = resolve_monitor_descriptor(
        monitors,
        monitor_index=0,
        monitor_id="bounds:1920:0:1920:1080",
    )

    assert selection["selected_index"] == 1
    assert selection["method"] == "id"


def test_resolve_monitor_descriptor_uses_stored_bounds_when_id_missing():
    monitors = [
        {"left": 0, "top": 0, "width": 1280, "height": 720},
        {"left": -1920, "top": 0, "width": 1920, "height": 1080},
    ]

    selection = resolve_monitor_descriptor(
        monitors,
        monitor_index=0,
        monitor_bounds={"left": -1920, "top": 0, "width": 1920, "height": 1080},
    )

    assert selection["selected_index"] == 1
    assert selection["method"] == "bounds"


def test_resolve_monitor_descriptor_falls_back_to_clamped_index_when_identity_is_stale():
    monitors = [
        {"left": 0, "top": 0, "width": 1920, "height": 1080},
        {"left": 1920, "top": 0, "width": 2560, "height": 1440},
    ]

    selection = resolve_monitor_descriptor(
        monitors,
        monitor_index=9,
        monitor_id="bounds:3840:0:1920:1080",
    )

    assert selection["selected_index"] == 1
    assert selection["method"] == "index-clamped"
    assert selection["used_fallback"] is True


def test_apply_monitor_selection_to_overlay_updates_legacy_index_and_identity():
    overlay = SimpleNamespace(monitor_to_capture=1, monitor_to_capture_id="", monitor_to_capture_bounds={})
    monitors = [
        {"left": 0, "top": 0, "width": 1920, "height": 1080},
        {"left": 0, "top": 1080, "width": 1920, "height": 1080},
    ]

    selection = apply_monitor_selection_to_overlay(overlay, monitors)

    assert selection["selected_index"] == 1
    assert overlay.monitor_to_capture == 1
    assert overlay.monitor_to_capture_id == "bounds:0:1080:1920:1080"
    assert overlay.monitor_to_capture_bounds == {"left": 0, "top": 1080, "width": 1920, "height": 1080}
