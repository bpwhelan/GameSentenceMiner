from types import SimpleNamespace

import pytest

from GameSentenceMiner.native import anki_edit
from GameSentenceMiner.util.communication import bus_client


def test_busy_tag_resumes_at_rejected_step_and_shutdown_interrupts(monkeypatch):
    calls = []

    def request(_dst, topic, data, timeout):
        assert topic == "anki.edit" and timeout >= 30
        calls.append(data["step"])
        return {"busy": "addTags" if len(calls) == 1 else None}

    monkeypatch.setattr(bus_client, "get_bus", lambda: SimpleNamespace(request=request))
    args = ("http://localhost", {"id": 17, "fields": {"語": "文"}}, ["a"], True)
    waits = []
    assert anki_edit.commit(*args, wait=lambda delay: waits.append(delay))
    assert calls == ["updateNoteFields", "addTags"] and waits == [1]
    calls.clear()
    with pytest.raises(RuntimeError, match="collection operation"):
        anki_edit.commit(*args, wait=lambda delay: True)
    assert calls == ["updateNoteFields"]


def test_oversize_edit_falls_back_before_first_mutation():
    assert not anki_edit.commit("http://localhost", {"id": 1, "fields": {"x": "字" * 3_000_000}}, [], False, wait=None)
