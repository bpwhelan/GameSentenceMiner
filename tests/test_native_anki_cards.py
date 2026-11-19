from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from GameSentenceMiner import anki
from GameSentenceMiner.util.communication import bus_client
from GameSentenceMiner.util.models import model


@pytest.fixture
def desktop(monkeypatch):
    cfg = SimpleNamespace(
        anki=SimpleNamespace(
            url="http://anki",
            word_field="Word",
            sentence_field="Sentence",
            picture_field="Picture",
            sentence_audio_field="Audio",
            sentence_furigana_field="",
        )
    )
    monkeypatch.setattr(anki, "get_config", lambda: cfg)
    monkeypatch.setattr(model, "get_config", lambda: cfg)
    monkeypatch.setattr(anki, "backend_manages", lambda flag: flag == "GSM_NATIVE_ANKI_CARDS")
    send = Mock()
    monkeypatch.setattr(bus_client, "get_bus", lambda: SimpleNamespace(request=send))
    monkeypatch.setattr(anki.requests, "post", lambda *a, **k: pytest.fail("unexpected direct HTTP request"))
    return send


def test_managed_latest_keeps_anki_field_order_and_metadata(desktop):
    desktop.return_value = {
        "result": [[15, ["読書"], [["Word", "語", 3], ["Sentence", "文", 0]], [412], "M"]],
        "error": None,
    }
    card = anki.get_last_anki_card()
    assert card.noteId == 15 and card.tags == ["読書"] and card.cards == [412] and card.modelName == "M"
    assert list(card.fields.items()) == [("Word", model.AnkiField("語", 3)), ("Sentence", model.AnkiField("文", 0))]
    assert desktop.call_args.args[2]["action"] == "latest"
    desktop.return_value = {"result": [], "error": None}
    assert anki.get_last_anki_card() == {}


def test_batch_read_retries_only_busy_and_skips_one_bad_note(desktop, monkeypatch):
    desktop.side_effect = [
        {"result": None, "error": "A collection operation is active."},
        {"result": ['{"noteId":14}', [15, [], [], [], "M"]], "error": None},
    ]
    wait = Mock(return_value=False)
    monkeypatch.setattr(anki._anki_monitor_stop, "wait", wait)
    update = Mock()
    monkeypatch.setattr(anki, "update_single_card", update)
    timing = anki.AnkiCardTimingContext(timing_id="note-read")
    log = Mock()
    monkeypatch.setattr(anki, "log_anki_card_timing", log)
    anki.update_new_cards([14, 15], timing_context=timing)
    assert update.call_args.args[0].noteId == 15
    assert update.call_args.kwargs == {"timing_context": timing}
    assert desktop.call_count == 2 and wait.call_args.args == (1.0,)
    assert [(call.args[1], call.kwargs["attempt"]) for call in log.call_args_list] == [
        ("anki_connect.invoke_failed", 1),
        ("anki_connect.invoke", 2),
    ]


def test_over_limit_read_uses_direct_anki_once(desktop, monkeypatch):
    desktop.return_value = None
    post = Mock()
    post.return_value.json.return_value = {
        "result": [{"noteId": 15, "fields": {}, "tags": [], "cards": []}],
        "error": None,
    }
    monkeypatch.setattr(anki.requests, "post", post)
    update = Mock()
    monkeypatch.setattr(anki, "update_single_card", update)
    anki.update_new_cards([15])
    desktop.assert_called_once()
    post.assert_called_once()
    assert update.call_args.args[0].noteId == 15


def test_over_limit_latest_keeps_the_id_already_selected(desktop, monkeypatch):
    desktop.return_value = {"fallback_note": 19}
    invoke = Mock(return_value=[{"noteId": 19, "fields": {}, "tags": [], "cards": []}])
    monkeypatch.setattr(anki, "invoke", invoke)
    assert anki.get_last_anki_card().noteId == 19
    invoke.assert_called_once_with("notesInfo", notes=[19])


def test_field_repair_still_uses_an_original_case_sensitive_name(desktop, monkeypatch):
    desktop.return_value = {"result": [[19, [], [["WORD", "a", 3], ["word", "b", 2]], [], ""]], "error": None}
    save = Mock()
    monkeypatch.setattr(model, "save_current_config", save)
    card = anki.get_last_anki_card()
    assert list(card.fields) == ["WORD", "word"]
    assert anki.get_config().anki.word_field == "WORD"
    save.assert_called_once()
