from types import SimpleNamespace

import pytest

from GameSentenceMiner import anki
from GameSentenceMiner.native import anki_grouping
from GameSentenceMiner.util.communication import bus_client


def test_incompatible_source_payload_stays_local_before_dispatch(monkeypatch):
    monkeypatch.setattr(bus_client, "get_bus", lambda: pytest.fail("incompatible payload reached desktop"))
    assert anki_grouping.request("http://local", "merge", value="\ud800") is None
    assert anki_grouping.request("http://local", "merge", value="x" * (7 * 1024 * 1024)) is None


@pytest.mark.parametrize("lost_reply", [True, False], ids=["lost", "malformed"])
def test_managed_merge_never_replays_an_uncertain_write(monkeypatch, lost_reply):
    source = SimpleNamespace(noteId=300, tags=["mined"], get_field=lambda _: "context")
    cfg = SimpleNamespace(
        anki=SimpleNamespace(url="http://anki", word_field="Word", sentence_field="Sentence"),
        ai=SimpleNamespace(add_to_anki=False),
    )
    requests = []

    def lost(_, topic, data, timeout):
        requests.append((topic, data["action"]))
        if lost_reply:
            raise ConnectionError("lost merge receipt")
        return False

    monkeypatch.setattr(anki, "backend_manages", lambda flag: flag == "GSM_NATIVE_ANKI_GROUPING")
    monkeypatch.setattr(bus_client, "get_bus", lambda: SimpleNamespace(request=lost))
    monkeypatch.setattr(anki, "invoke", lambda *_a, **_k: pytest.fail("a lost write must never be repeated"))
    with pytest.raises((ConnectionError, RuntimeError), match="receipt"):
        anki._apply_field_grouping_merge(source, {"fields": {}}, [], {"target_note_id": 20}, cfg)
    assert requests == [("anki.group", "merge")]
