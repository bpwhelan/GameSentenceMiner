import json
import os
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest

from GameSentenceMiner import anki, saved_line_cards
from GameSentenceMiner.util import saved_lines, text_log
from GameSentenceMiner.util.models.model import AnkiField
from GameSentenceMiner.util.text_log import GameLine

BASE = datetime(2026, 9, 27, 12, 0, 0)


def _config(output_folder="/out"):
    return SimpleNamespace(
        anki=SimpleNamespace(
            sentence_field="Sentence",
            word_field="Word",
            sentence_audio_field="SentenceAudio",
            picture_field="Picture",
            previous_image_field="PrevImage",
            video_field="",
            previous_sentence_field="PrevSentence",
            sentence_furigana_field="SentenceFurigana",
            game_name_field="GameName",
            add_game_tag=True,
            parent_tag="",
            custom_tags=[],
            tags_to_check=[],
            reuse_audio_for_same_selected_lines_different_mined_line=True,
            reuse_screenshot_for_same_selected_lines_different_mined_line=False,
        ),
        ai=SimpleNamespace(anki_field="Translation", provider="gemini"),
        paths=SimpleNamespace(output_folder=output_folder),
        obs=SimpleNamespace(get_game_from_scene=False),
        screenshot=SimpleNamespace(animated=False),
    )


@pytest.fixture
def config(monkeypatch):
    cfg = _config()
    for module in (text_log, saved_line_cards, anki):
        monkeypatch.setattr(module, "get_config", lambda: cfg)
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


def _write_saved(root, name, entries, end_seconds, game="FFVII"):
    folder = root / "2026-09-27" / name
    folder.mkdir(parents=True)
    manifest = {
        "version": 1,
        "game": game,
        "sentence": "".join(text for _, text, role, _ in entries if role == "selected"),
        "selected_line_ids": [line_id for line_id, _, role, _ in entries if role == "selected"],
        "lines": [
            {"id": i, "text": t, "time": (BASE + timedelta(seconds=s)).isoformat(), "role": r} for i, t, r, s in entries
        ],
        "clip": {"file": "clip.mkv", "end_time": (BASE + timedelta(seconds=end_seconds)).isoformat()},
    }
    (folder / saved_lines.MANIFEST_NAME).write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
    (folder / "clip.mkv").write_bytes(b"clip")
    return folder


# --- which new cards belong to a saved line -----------------------------------


@pytest.fixture
def saved_root(tmp_path, monkeypatch):
    monkeypatch.setattr(saved_lines, "get_saved_lines_root", lambda output_folder=None: str(tmp_path))
    monkeypatch.setattr(anki.gsm_state, "last_overlay_scan_line", None, raising=False)
    monkeypatch.setattr(anki.gsm_state, "replay_buffer_length", 300, raising=False)
    return tmp_path


def test_new_card_goes_to_the_saved_line_when_no_live_line_matches(config, saved_root, monkeypatch):
    _write_saved(saved_root, "a", [("s", "心当たりはねえのかこの声の主", "selected", 10)], 20)
    live = GameLine(id="live", text="全く関係のない今の台詞", time=datetime.now(), prev=None, next=None)
    monkeypatch.setattr(saved_line_cards, "get_all_lines", lambda: [live])

    saved, line = saved_line_cards.match_new_card(FakeCard("心当たりはねえのか<b>この声</b>の主"))

    assert line.id == "s" and os.path.basename(saved.folder) == "a"


def test_live_line_wins_over_a_saved_line_with_the_same_sentence(config, saved_root, monkeypatch):
    _write_saved(saved_root, "a", [("s", "心当たりはねえのかこの声の主", "selected", 10)], 20)
    live = GameLine(id="live", text="心当たりはねえのかこの声の主", time=datetime.now(), prev=None, next=None)
    monkeypatch.setattr(saved_line_cards, "get_all_lines", lambda: [live])

    assert saved_line_cards.match_new_card(FakeCard("心当たりはねえのかこの声の主")) is None


def test_overlay_scan_line_and_overlay_cards_stay_with_the_live_flow(config, saved_root, monkeypatch):
    _write_saved(saved_root, "a", [("s", "心当たりはねえのかこの声の主", "selected", 10)], 20)
    monkeypatch.setattr(saved_line_cards, "get_all_lines", lambda: [])
    card = FakeCard("心当たりはねえのかこの声の主")

    scan = GameLine(id="scan", text="心当たりはねえのかこの声の主", time=datetime.now(), prev=None, next=None)
    monkeypatch.setattr(anki.gsm_state, "last_overlay_scan_line", scan, raising=False)
    assert saved_line_cards.match_new_card(card) is None

    monkeypatch.setattr(anki.gsm_state, "last_overlay_scan_line", None, raising=False)
    card.tags = ["overlay"]
    assert saved_line_cards.match_new_card(card) is None


def test_no_saved_matching_without_an_output_folder(monkeypatch):
    cfg = _config(output_folder="")
    monkeypatch.setattr(saved_line_cards, "get_config", lambda: cfg)
    monkeypatch.setattr(anki.gsm_state, "last_overlay_scan_line", None, raising=False)
    monkeypatch.setattr(saved_line_cards, "get_all_lines", lambda: [])

    assert saved_line_cards.match_new_card(FakeCard("何か")) is None


# --- the live flow hands saved-line cards over ------------------------------


def _live_flow(monkeypatch, selected=()):
    calls = {"queued": [], "saved": []}
    monkeypatch.setattr(
        anki,
        "_get_texthooking_page_module",
        lambda: SimpleNamespace(get_selected_lines=lambda: list(selected), reset_checked_lines=lambda: None),
    )
    monkeypatch.setattr(anki, "find_anki_field_mismatch", lambda *a, **k: None)
    monkeypatch.setattr(anki, "queue_card_for_processing", lambda *a, **k: calls["queued"].append(a))
    monkeypatch.setattr(
        saved_line_cards, "enrich_from_saved_line", lambda card, saved, line, **k: calls["saved"].append(line)
    )
    return calls


def test_update_single_card_hands_saved_line_cards_to_the_saved_flow(config, monkeypatch):
    calls = _live_flow(monkeypatch)
    line = SimpleNamespace(id="s")
    monkeypatch.setattr(saved_line_cards, "match_new_card", lambda card: (SimpleNamespace(folder="saved"), line))

    anki.update_single_card(FakeCard("心当たり"))

    assert calls == {"queued": [], "saved": [line]}


def test_checked_lines_keep_the_card_in_the_live_flow(config, monkeypatch):
    checked = SimpleNamespace(id="checked", text="心当たり", source="")
    calls = _live_flow(monkeypatch, selected=[checked])
    monkeypatch.setattr(saved_line_cards, "match_new_card", lambda card: pytest.fail("saved lines consulted"))
    monkeypatch.setattr(anki, "_resolve_mined_line_for_card", lambda card, lines: checked)

    anki.update_single_card(FakeCard("心当たり"))

    assert calls["saved"] == [] and len(calls["queued"]) == 1


def test_live_flow_skips_notes_enriched_from_a_saved_line(config, monkeypatch):
    calls = _live_flow(monkeypatch)
    monkeypatch.setattr(anki.gsm_state, "saved_line_note_ids", {42}, raising=False)
    monkeypatch.setattr(saved_line_cards, "match_new_card", lambda card: pytest.fail("should not match"))

    anki.update_single_card(FakeCard("心当たり", note_id=42))

    assert calls == {"queued": [], "saved": []}


# --- running the Anki flow on a saved clip ------------------------------------


def test_saved_clip_job_uses_a_temporary_copy_and_records_the_card(config, tmp_path, monkeypatch):
    folder = _write_saved(
        tmp_path, "a", [("p", "前", "previous", 10), ("s", "今", "selected", 15), ("n", "次", "next", 20)], 25
    )
    saved = saved_lines.load_saved_line(str(folder))
    temp = tmp_path / "temp"
    temp.mkdir()
    monkeypatch.setattr(saved_line_cards, "get_temporary_directory", lambda: str(temp))
    seen = {}

    def fake_process_replay(video_path, queued_job):
        seen["video"] = video_path
        seen["mtime"] = os.path.getmtime(video_path)
        seen["job"] = queued_job
        os.remove(video_path)  # what "remove video" does after a live card
        return SimpleNamespace(background_update_started=True)

    monkeypatch.setattr(saved_line_cards, "_process_replay", fake_process_replay)
    card = FakeCard("今", word="今")

    saved_line_cards._process_saved_line_card(card, saved, saved.selected[0], rewrite=False)

    assert seen["video"] != saved.clip_path and os.path.dirname(seen["video"]) == str(temp)
    assert seen["mtime"] == pytest.approx(saved.clip_end_time.timestamp(), abs=0.01)
    last_note, creation_time, selected, mined_line, *rest = seen["job"]
    assert (last_note, creation_time, selected, mined_line.id) == (card, saved.clip_end_time, [], "s")
    assert os.path.isfile(saved.clip_path)
    assert [c["note_id"] for c in saved_lines.read_manifest(str(folder))["cards"]] == [42]


def test_cancelled_saved_clip_job_records_nothing(config, tmp_path, monkeypatch):
    folder = _write_saved(tmp_path, "a", [("s", "今", "selected", 15)], 25)
    saved = saved_lines.load_saved_line(str(folder))
    monkeypatch.setattr(saved_line_cards, "get_temporary_directory", lambda: str(tmp_path))
    monkeypatch.setattr(
        saved_line_cards, "_process_replay", lambda v, queued_job: SimpleNamespace(background_update_started=False)
    )

    saved_line_cards._process_saved_line_card(FakeCard("今"), saved, saved.selected[0], rewrite=False)

    assert "cards" not in saved_lines.read_manifest(str(folder))


def test_rewrite_treats_the_card_as_freshly_created_from_the_saved_line(config, tmp_path):
    folder = _write_saved(tmp_path, "a", [("s", "心当たりはねえのかこの声の主", "selected", 15)], 25)
    saved = saved_lines.load_saved_line(str(folder))
    card = FakeCard(
        "全く<b>声</b>の違う台詞",
        word="声",
        SentenceAudio="[sound:wrong.mp3]",
        Picture='<img src="wrong.png">',
        PrevSentence="wrong",
        Translation="wrong",
        GameName="Other game",
    )

    fresh = saved_line_cards._card_for_rewrite(card, saved)

    assert fresh.get_field("Sentence") == "心当たりはねえのかこの<b>声</b>の主"
    for name in ("SentenceAudio", "Picture", "PrevSentence", "Translation", "GameName"):
        assert fresh.get_field(name) == ""
    assert fresh.get_field("Word") == "声"
    assert card.get_field("SentenceAudio") == "[sound:wrong.mp3]"  # the real card is untouched


# --- checks before "Enrich latest card" -------------------------------------


def _saved(tmp_path, text="心当たりはねえのかこの声の主"):
    return saved_lines.load_saved_line(str(_write_saved(tmp_path, "a", [("s", text, "selected", 15)], 25)))


def test_enrich_check_passes_for_a_matching_fresh_card(config, tmp_path, monkeypatch):
    monkeypatch.setattr(anki, "card_queue", [])

    result = saved_line_cards.check_enrich(FakeCard("心当たりはねえのか<b>この声</b>の主"), _saved(tmp_path))

    assert result["warnings"] == []


def test_enrich_check_warns_about_mismatch_existing_media_and_pending_live_work(config, tmp_path, monkeypatch):
    card = FakeCard("全く関係のない文", SentenceAudio="[sound:a.mp3]")
    monkeypatch.setattr(anki, "card_queue", [(card, None, [], None)])

    result = saved_line_cards.check_enrich(card, _saved(tmp_path))

    assert {w["code"] for w in result["warnings"]} == {"sentence_mismatch", "has_media", "live_pending"}
    assert result["card_sentence"] == "全く関係のない文"
    assert result["card_media"] == {"audio": True, "picture": False}


# --- saved game name and translation context -----------------------------


def test_tags_and_game_field_use_the_saved_game(config, monkeypatch):
    monkeypatch.setattr(anki, "get_current_game", lambda *a, **k: "Live game")
    saved_line = SimpleNamespace(saved_game="FFVII Rebirth")

    assert anki._prepare_anki_tags(saved_line) == ["FFVIIRebirth"]
    assert anki._prepare_anki_tags() == ["Livegame"]
    assert anki._game_name_for(saved_line) == "FFVII Rebirth"


def test_ai_translation_uses_the_saved_neighbours_as_context(config, monkeypatch):
    live_lines = [SimpleNamespace(text="live")]
    monkeypatch.setattr(anki, "get_all_lines", lambda: live_lines)
    monkeypatch.setattr(anki, "get_current_game", lambda *a, **k: "Live game")
    captured = {}

    def fake_prompt(lines, sentence, line, game):
        captured.update(lines=lines, game=game)
        return "translation"

    monkeypatch.setattr(anki, "_get_ai_prompt_result", lambda: fake_prompt)
    context = [SimpleNamespace(text="前"), SimpleNamespace(text="今")]
    line = SimpleNamespace(saved_context_lines=context, saved_game="FFVII", translation="")

    assert anki.prefetch_ai_translation("今", line) == "translation"
    assert captured == {"lines": context, "game": "FFVII"}
