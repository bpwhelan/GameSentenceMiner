import os
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest

from GameSentenceMiner import anki, clip_cards
from GameSentenceMiner.util import clips, text_log
from GameSentenceMiner.util.models.model import AnkiField
from GameSentenceMiner.util.text_log import GameLine
from tests.clip_helpers import BASE, write_clip


def _config():
    return SimpleNamespace(
        anki=SimpleNamespace(
            sentence_field="Sentence",
            word_field="Word",
            add_game_tag=True,
            parent_tag="",
            custom_tags=[],
            tags_to_check=[],
        ),
        ai=SimpleNamespace(add_to_anki=False),
        obs=SimpleNamespace(get_game_from_scene=False),
    )


@pytest.fixture
def config(monkeypatch):
    cfg = _config()
    for module in (text_log, clips, clip_cards, anki):
        monkeypatch.setattr(module, "get_config", lambda: cfg)
    monkeypatch.setattr(anki, "lines_match", text_log.lines_match)
    return cfg


class FakeCard:
    def __init__(self, sentence, word="声", note_id=42, **extra):
        values = {"Sentence": sentence, "Word": word, "SentenceAudio": "", "Picture": "", **extra}
        self.noteId = note_id
        self.tags = []
        self.fields = {name: AnkiField(value=value, order=i) for i, (name, value) in enumerate(values.items())}

    def get_field(self, name):
        return self.fields[name].value

    def has_field(self, name):
        return name in self.fields


# --- which new cards belong to a clip line -----------------------------------


@pytest.fixture
def clips_root(tmp_path, monkeypatch):
    monkeypatch.setattr(clips, "get_clips_root", lambda: str(tmp_path))
    monkeypatch.setattr(anki.gsm_state, "last_overlay_scan_line", None, raising=False)
    monkeypatch.setattr(anki.gsm_state, "replay_buffer_length", 300, raising=False)
    return tmp_path


def test_new_card_goes_to_the_clip_when_no_live_line_matches(config, clips_root, monkeypatch):
    write_clip(clips_root, "a", [("s", "心当たりはねえのかこの声の主", "selected", 10)], 20)
    live = GameLine(id="live", text="全く関係のない今の台詞", time=datetime.now(), prev=None, next=None)
    monkeypatch.setattr(clip_cards, "get_all_lines", lambda: [live])

    line = clip_cards.match_new_card(FakeCard("心当たりはねえのか<b>この声</b>の主"))
    clip = line.clip

    assert line.id == "s" and os.path.basename(clip.folder) == "a"


def test_live_line_wins_over_a_clip_with_the_same_sentence(config, clips_root, monkeypatch):
    write_clip(clips_root, "a", [("s", "心当たりはねえのかこの声の主", "selected", 10)], 20)
    live = GameLine(id="live", text="心当たりはねえのかこの声の主", time=datetime.now(), prev=None, next=None)
    monkeypatch.setattr(clip_cards, "get_all_lines", lambda: [live])

    assert clip_cards.match_new_card(FakeCard("心当たりはねえのかこの声の主")) is None


def test_matching_overlay_scan_line_stays_with_the_live_flow(config, clips_root, monkeypatch):
    write_clip(clips_root, "a", [("s", "心当たりはねえのかこの声の主", "selected", 10)], 20)
    monkeypatch.setattr(clip_cards, "get_all_lines", lambda: [])
    card = FakeCard("心当たりはねえのかこの声の主")

    scan = GameLine(id="scan", text="心当たりはねえのかこの声の主", time=datetime.now(), prev=None, next=None)
    monkeypatch.setattr(anki.gsm_state, "last_overlay_scan_line", scan, raising=False)
    assert clip_cards.match_new_card(card) is None


def test_overlay_card_uses_saved_clip_when_history_and_scan_do_not_match(config, clips_root, monkeypatch):
    write_clip(clips_root, "a", [("s", "心当たりはねえのかこの声の主", "selected", 10)], 20)
    now = datetime.now().astimezone().replace(tzinfo=None)
    live = GameLine(id="live", text="全く関係のない今の台詞", time=now, prev=None, next=None)
    monkeypatch.setattr(clip_cards, "get_all_lines", lambda: [live])
    monkeypatch.setattr(anki.gsm_state, "last_overlay_scan_line", live, raising=False)
    card = FakeCard("心当たりはねえのか<b>この声</b>の主")
    card.tags = ["overlay"]

    assert clip_cards.match_new_card(card).id == "s"


@pytest.mark.parametrize("saved_text", ["この声の主", "心当たりはないのかこの声の主"])
def test_saved_clip_requires_a_confident_sentence_match(config, clips_root, monkeypatch, saved_text):
    write_clip(clips_root, "a", [("s", saved_text, "selected", 10)], 20)
    monkeypatch.setattr(clip_cards, "get_all_lines", list)

    assert clip_cards.match_new_card(FakeCard("心当たりはねえのかこの声の主")) is None


def test_saved_clip_can_match_the_bold_word_context_in_a_combined_sentence(config, clips_root):
    write_clip(clips_root, "a", [("s", "心当たりはねえのかこの声の主", "selected", 10)], 20)

    line = clips.match_card_to_clip(
        FakeCard("長い前の台詞がここにあります。心当たりはねえのか<b>この声</b>の主"), str(clips_root)
    )

    assert line.id == "s"


def test_saved_clip_without_video_is_not_used(config, clips_root):
    folder = write_clip(clips_root, "a", [("s", "心当たりはねえのかこの声の主", "selected", 10)], 20)
    (folder / "clip.mkv").unlink()

    assert clips.match_card_to_clip(FakeCard("心当たりはねえのかこの声の主"), str(clips_root)) is None


def test_lines_that_left_the_buffer_use_their_saved_clip_as_the_replay(clips_root, monkeypatch):
    write_clip(clips_root, "a", [("s", "今", "selected", 10)], 20)
    monkeypatch.setattr(clip_cards, "make_unique_temp_file", lambda path: str(clips_root / "copy.mkv"))
    expired = GameLine(id="s", text="今", time=BASE, prev=None, next=None)

    replay = clip_cards.replay_for_lines([expired])

    assert replay == str(clips_root / "copy.mkv")
    assert os.path.getmtime(replay) == pytest.approx((BASE + timedelta(seconds=20)).timestamp(), abs=0.01)
    # Still in the buffer, or never saved: the Text Feed saves a new OBS replay as usual.
    assert clip_cards.replay_for_lines([GameLine(id="s", text="今", time=datetime.now(), prev=None, next=None)]) is None
    assert clip_cards.replay_for_lines([GameLine(id="other", text="今", time=BASE, prev=None, next=None)]) is None


# --- the live flow hands clip-line cards over ------------------------------


def _live_flow(monkeypatch, selected=()):
    calls = {"queued": [], "clip": []}
    monkeypatch.setattr(
        anki,
        "_get_texthooking_page_module",
        lambda: SimpleNamespace(get_selected_lines=lambda: list(selected), reset_checked_lines=lambda: None),
    )
    monkeypatch.setattr(anki, "find_anki_field_mismatch", lambda *a, **k: None)
    monkeypatch.setattr(anki, "queue_card_for_processing", lambda *a, **k: calls["queued"].append(a))
    monkeypatch.setattr(clip_cards, "queue_clip_card", lambda card, line, **k: calls["clip"].append(line))
    return calls


def test_update_single_card_hands_clip_cards_to_the_clip_flow(config, monkeypatch):
    calls = _live_flow(monkeypatch)
    line = GameLine(id="s", text="心当たり", time=BASE, prev=None, next=None)
    line.clip = SimpleNamespace(clip_end_time=BASE)
    monkeypatch.setattr(anki, "_resolve_mined_line_for_card", lambda card, lines: line)

    anki.update_single_card(FakeCard("心当たり"))

    assert calls == {"queued": [], "clip": [line]}


def test_update_single_card_routes_history_fallback_to_saved_media(config, clips_root, monkeypatch):
    folder = write_clip(clips_root, "a", [("s", "心当たりはねえのかこの声の主", "selected", 10)], 20)
    now = datetime.now().astimezone().replace(tzinfo=None)
    live = GameLine(id="live", text="全く関係のない今の台詞", time=now, prev=None, next=None)
    monkeypatch.setattr(text_log, "get_all_lines", lambda: [live])
    monkeypatch.setattr(anki, "get_mined_line", text_log.get_mined_line)
    calls = _live_flow(monkeypatch)
    card = FakeCard("心当たりはねえのか<b>この声</b>の主")
    card.tags = ["overlay"]

    anki.update_single_card(card)

    assert calls["queued"] == []
    (line,) = calls["clip"]
    assert line.id == "s" and line.clip.folder == str(folder)
    assert line.mined_time == line.clip.clip_end_time


def test_checked_lines_keep_the_card_in_the_live_flow(config, monkeypatch):
    checked = SimpleNamespace(id="checked", text="心当たり", source="")
    calls = _live_flow(monkeypatch, selected=[checked])
    monkeypatch.setattr(clips, "match_card_to_clip", lambda *args: pytest.fail("clip lines consulted"))
    monkeypatch.setattr(anki, "_resolve_mined_line_for_card", lambda card, lines: checked)

    anki.update_single_card(FakeCard("心当たり"))

    assert calls["clip"] == [] and len(calls["queued"]) == 1


def test_checked_lines_do_not_switch_to_an_automatic_saved_match(config, clips_root, monkeypatch):
    write_clip(clips_root, "a", [("s", "心当たりはねえのかこの声の主", "selected", 10)], 20)
    now = datetime.now().astimezone().replace(tzinfo=None)
    checked = GameLine(id="checked", text="全く関係のない今の台詞", time=now, prev=None, next=None)
    calls = _live_flow(monkeypatch, selected=[checked])
    monkeypatch.setattr(anki, "get_mined_line", text_log.get_mined_line)
    monkeypatch.setattr(clips, "match_card_to_clip", lambda *args: pytest.fail("saved clips searched"))

    anki.update_single_card(FakeCard("心当たりはねえのかこの声の主"))

    assert calls["clip"] == []
    assert calls["queued"][0][2] is checked


def test_matching_overlay_scan_keeps_its_media_when_a_saved_clip_exists(config, clips_root, monkeypatch):
    write_clip(clips_root, "a", [("s", "心当たりはねえのかこの声の主", "selected", 10)], 20)
    now = datetime.now().astimezone().replace(tzinfo=None)
    scan = GameLine(id="scan", text="心当たりはねえのかこの声の主", time=now, prev=None, next=None)
    monkeypatch.setattr(anki.gsm_state, "last_overlay_scan_line", scan, raising=False)
    monkeypatch.setattr(text_log, "get_all_lines", list)
    monkeypatch.setattr(anki, "get_all_lines", list)
    monkeypatch.setattr(anki, "get_mined_line", text_log.get_mined_line)
    calls = _live_flow(monkeypatch)

    anki.update_single_card(FakeCard(scan.text))

    assert calls["clip"] == []
    assert calls["queued"][0][2] is scan


# --- running the Anki flow on a clip ------------------------------------


def test_clip_card_runs_the_anki_flow_on_a_copy(config, tmp_path, monkeypatch):
    folder = write_clip(
        tmp_path, "a", [("p", "前", "previous", 10), ("s", "今", "selected", 15), ("n", "次", "next", 20)], 25
    )
    clip = clips.load_clip(str(folder))
    card = FakeCard("今", word="今")
    temp_copy = tmp_path / "temp" / "clip_copy.mkv"
    temp_copy.parent.mkdir()
    monkeypatch.setattr(clip_cards, "make_unique_temp_file", lambda path: str(temp_copy))
    seen = {}

    def fake_queue(last_note, lines, line, **kwargs):
        seen.update(last_note=last_note, lines=lines, line=line, **kwargs)
        seen["mtime"] = os.path.getmtime(kwargs["replay_path"])
        os.remove(kwargs["replay_path"])  # what "remove video" does after a live card

    monkeypatch.setattr(anki, "queue_card_for_processing", fake_queue)
    clip_cards.queue_clip_card(card, clip.selected[0])

    assert seen["replay_path"] == str(temp_copy)
    assert seen["mtime"] == pytest.approx(clip.clip_end_time.timestamp(), abs=0.01)
    assert (seen["last_note"], seen["lines"], seen["line"].id) == (card, [], "s")
    assert seen["created_at"] == clip.clip_end_time
    assert os.path.isfile(clip.clip_path)


def test_a_given_replay_is_processed_instead_of_saving_the_obs_buffer(config, monkeypatch):
    from GameSentenceMiner import replay_handler

    monkeypatch.setattr(
        anki,
        "_get_texthooking_page_module",
        lambda: SimpleNamespace(reset_checked_lines=lambda: None),
    )
    monkeypatch.setattr(anki.obs, "save_replay_buffer", lambda: pytest.fail("saved the OBS buffer"))
    monkeypatch.setattr(anki, "card_queue", [])
    submitted = []
    monkeypatch.setattr(replay_handler, "process_replay_file", lambda path, job: submitted.append((path, job)))
    line = GameLine(id="s", text="今", time=BASE, prev=None, next=None)

    anki.queue_card_for_processing(FakeCard("今"), [], line, replay_path="/clip.mkv", created_at=BASE)

    ((path, job),) = submitted
    assert (path, job[1], job[3]) == ("/clip.mkv", BASE, line)
    assert anki.card_queue == []


# --- saved line game name and translation context -----------------------------


def test_tags_and_game_field_use_the_saved_line_scene(config, monkeypatch):
    monkeypatch.setattr(anki, "get_current_game", lambda *a, **k: "Live game")
    clip_line = SimpleNamespace(clip=object(), scene="FFVII Rebirth")

    assert anki._prepare_anki_tags(clip_line) == ["FFVIIRebirth"]
    assert anki._prepare_anki_tags() == ["Livegame"]
    assert anki._game_name_for(clip_line) == "FFVII Rebirth"


def test_ai_context_of_a_saved_line_is_its_clip():
    from GameSentenceMiner.ai import ai_prompting

    context = [SimpleNamespace(text="前"), SimpleNamespace(text="今")]
    saved = SimpleNamespace(clip=SimpleNamespace(lines=context), scene="FFVII")

    assert ai_prompting._clip_context(["live"], saved, "Live game") == (context, "FFVII")
    assert ai_prompting._clip_context(["live"], SimpleNamespace(), "Live game") == (["live"], "Live game")
