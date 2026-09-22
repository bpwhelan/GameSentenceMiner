from __future__ import annotations

import copy

import pytest

from GameSentenceMiner import _native
from GameSentenceMiner.native import overlay


def test_native_copy_preserves_nested_aliases_without_sharing_mutable_input():
    shared = {"text": "𠮷🙂\ud800", "box": [1, 2.5, True, None], "meta": {3: "value"}}
    source = [{"words": [shared, shared], "extra": shared}]
    actual = _native.copy_overlay_payload(source)
    assert actual == copy.deepcopy(source)
    assert actual is not source
    assert actual[0]["words"][0] is actual[0]["words"][1] is actual[0]["extra"]
    actual[0]["words"][0]["box"][0] = 100
    assert shared["box"][0] == 1


def test_native_copy_preserves_cycles():
    source = {"list": []}
    source["list"].append(source)
    actual = _native.copy_overlay_payload(source)
    assert actual is not source
    assert actual["list"][0] is actual


@pytest.mark.parametrize("mode", ["native", "python", "shadow"])
def test_custom_metadata_uses_python_deepcopy_protocol_once(monkeypatch, mode):
    monkeypatch.setenv("GSM_NATIVE_OVERLAY_MODE", mode)
    calls = []

    class Metadata:
        def __deepcopy__(self, memo):
            calls.append(self)
            return {"copied": True}

    source = {"text": "line", "metadata": Metadata()}
    assert overlay.copy_payload(source) == {"text": "line", "metadata": {"copied": True}}
    assert len(calls) == 1


def test_old_extension_uses_python_copy(monkeypatch):
    monkeypatch.setattr(overlay.ocr, "_extension", object())
    source = {"words": [{"text": "日本語"}]}
    actual = overlay.copy_payload(source)
    assert actual == source
    assert actual["words"][0] is not source["words"][0]


def test_shadow_copy_handles_recursive_metadata(monkeypatch):
    monkeypatch.setenv("GSM_NATIVE_OVERLAY_MODE", "shadow")
    source = []
    source.append(source)
    actual = overlay.copy_payload(source)
    assert actual is not source
    assert actual[0] is actual
