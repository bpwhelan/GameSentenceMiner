import ctypes
from types import SimpleNamespace

import pytest

from GameSentenceMiner.util.platform import magpie_compat
from GameSentenceMiner.util.platform.magpie_compat import normalize_magpie_info


@pytest.fixture
def magpie_native(monkeypatch):
    # GetProp returns pointer-sized values; negative RECT coordinates are stored
    # as (HANDLE)(INT_PTR)LONG by Magpie.
    native = SimpleNamespace(
        visible=True,
        hwnd=0x123456789,
        props={
            b"Magpie.SrcHWND": 0x234567890,
            b"Magpie.DestLeft": 0,
            b"Magpie.DestTop": 0,
            b"Magpie.DestRight": 2560,
            b"Magpie.DestBottom": 1440,
            b"Magpie.SrcLeft": 320,
            b"Magpie.SrcTop": 196,
            b"Magpie.SrcRight": 2240,
            b"Magpie.SrcBottom": 1276,
        },
    )
    native.FindWindowA = lambda *_: native.hwnd
    native.IsWindowVisible = lambda hwnd: native.visible
    native.GetPropA = lambda hwnd, key: native.props.get(key, 0)
    monkeypatch.setattr(magpie_compat, "IS_WINDOWS", True)
    monkeypatch.setattr(magpie_compat, "user32", native)
    return native


def test_hidden_magpie_window_does_not_publish_stale_geometry(magpie_native):
    magpie_native.visible = False
    assert magpie_compat.get_magpie_info() is None


@pytest.mark.parametrize("target", [0, 42, 0x234567890])
def test_scaling_info_is_scoped_to_the_requested_source_window(magpie_native, target):
    info = magpie_compat.get_magpie_info(target)
    assert bool(info) is (target == magpie_native.props[b"Magpie.SrcHWND"])


def test_missing_source_property_cannot_match_a_target(magpie_native):
    del magpie_native.props[b"Magpie.SrcHWND"]
    assert magpie_compat.get_magpie_info(42) is None


def test_pointer_sized_negative_coordinates_are_read_as_signed_longs(magpie_native):
    for key in (b"Magpie.SrcLeft", b"Magpie.SrcRight", b"Magpie.DestLeft", b"Magpie.DestRight"):
        magpie_native.props[key] = ctypes.c_void_p(magpie_native.props[key] - 2560).value or 0
    info = magpie_compat.get_magpie_info()
    assert info is not None
    assert info["sourceWindowLeftEdgePosition"] == -2240
    assert info["sourceWindowRightEdgePosition"] == -320
    assert info["magpieWindowLeftEdgePosition"] == -2560
    assert info["magpieWindowRightEdgePosition"] == 0


def test_normalize_magpie_info_rejects_zero_or_inverted_rectangles():
    assert (
        normalize_magpie_info(
            {
                "magpieWindowTopEdgePosition": 0,
                "magpieWindowBottomEdgePosition": 0,
                "magpieWindowLeftEdgePosition": 0,
                "magpieWindowRightEdgePosition": 0,
                "sourceWindowLeftEdgePosition": 620,
                "sourceWindowTopEdgePosition": 342,
                "sourceWindowRightEdgePosition": 620,
                "sourceWindowBottomEdgePosition": 1062,
            }
        )
        is None
    )


def test_normalize_magpie_info_coerces_numeric_values_and_preserves_valid_geometry():
    info = normalize_magpie_info(
        {
            "magpieWindowTopEdgePosition": "0",
            "magpieWindowBottomEdgePosition": "1440",
            "magpieWindowLeftEdgePosition": "0",
            "magpieWindowRightEdgePosition": "2560",
            "sourceWindowLeftEdgePosition": "620",
            "sourceWindowTopEdgePosition": "342",
            "sourceWindowRightEdgePosition": "1900",
            "sourceWindowBottomEdgePosition": "1062",
        }
    )

    assert info == {
        "magpieWindowTopEdgePosition": 0,
        "magpieWindowBottomEdgePosition": 1440,
        "magpieWindowLeftEdgePosition": 0,
        "magpieWindowRightEdgePosition": 2560,
        "sourceWindowLeftEdgePosition": 620,
        "sourceWindowTopEdgePosition": 342,
        "sourceWindowRightEdgePosition": 1900,
        "sourceWindowBottomEdgePosition": 1062,
    }
