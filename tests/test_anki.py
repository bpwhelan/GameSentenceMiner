import sys
from contextlib import contextmanager
from datetime import datetime, timedelta
from types import ModuleType, SimpleNamespace

import pytest


_MISSING = object()


@contextmanager
def _temporary_sys_modules(stubs: dict[str, ModuleType]):
    originals: dict[str, object] = {}
    for name, module in stubs.items():
        originals[name] = sys.modules.get(name, _MISSING)
        sys.modules[name] = module
    try:
        yield
    finally:
        for name, original in originals.items():
            if original is _MISSING:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = original


rapidfuzz_stub = ModuleType("rapidfuzz")
rapidfuzz_stub.process = SimpleNamespace()

obs_stub = ModuleType("GameSentenceMiner.obs")
obs_stub.get_current_game = lambda: ""
obs_stub.update_current_game = lambda: None
obs_stub.save_replay_buffer = lambda: None

ai_prompting_stub = ModuleType("GameSentenceMiner.ai.ai_prompting")
ai_prompting_stub.get_ai_prompt_result = lambda *args, **kwargs: ""

mecab_pkg = ModuleType("GameSentenceMiner.mecab")
mecab_pkg.mecab = SimpleNamespace()

db_stub = ModuleType("GameSentenceMiner.util.database.db")
db_stub.GameLinesTable = object

ffmpeg_stub = ModuleType("GameSentenceMiner.util.media.ffmpeg")
ffmpeg_stub.get_raw_screenshot = lambda *args, **kwargs: ""
ffmpeg_stub.get_screenshot = lambda *args, **kwargs: ""
ffmpeg_stub.get_audio = lambda *args, **kwargs: ""
ffmpeg_stub.encode_screenshot = lambda path: path
media_pkg = ModuleType("GameSentenceMiner.util.media")
media_pkg.ffmpeg = ffmpeg_stub

model_stub = ModuleType("GameSentenceMiner.util.models.model")
model_stub.AnkiCard = object

notification_stub = ModuleType("GameSentenceMiner.util.platform.notification")
notification_stub.send_error_no_anki_update = lambda *args, **kwargs: None
platform_pkg = ModuleType("GameSentenceMiner.util.platform")
platform_pkg.notification = notification_stub

live_stats_stub = ModuleType("GameSentenceMiner.util.stats.live_stats")
live_stats_stub.live_stats_tracker = SimpleNamespace()

text_log_stub = ModuleType("GameSentenceMiner.util.text_log")
text_log_stub.GameLine = object
text_log_stub.TextSource = object
text_log_stub.get_all_lines = lambda *args, **kwargs: []
text_log_stub.get_text_event = lambda *args, **kwargs: None
text_log_stub.get_mined_line = lambda card, lines=None: SimpleNamespace(id="line-1", text="Line")
text_log_stub.lines_match = lambda *args, **kwargs: False
text_log_stub.strip_whitespace_and_punctuation = lambda text: "".join(ch for ch in text if ch.isalnum())

texthooking_stub = ModuleType("GameSentenceMiner.web.texthooking_page")
texthooking_stub.get_selected_lines = lambda: []
texthooking_stub.reset_checked_lines = lambda: None
web_pkg = ModuleType("GameSentenceMiner.web")
web_pkg.texthooking_page = texthooking_stub

gsm_websocket_stub = ModuleType("GameSentenceMiner.web.gsm_websocket")
gsm_websocket_stub.websocket_manager = SimpleNamespace(send_message=lambda *_args, **_kwargs: None)
gsm_websocket_stub.ID_OVERLAY = "overlay"

_STUB_MODULES = {
    "rapidfuzz": rapidfuzz_stub,
    "GameSentenceMiner.obs": obs_stub,
    "GameSentenceMiner.ai.ai_prompting": ai_prompting_stub,
    "GameSentenceMiner.mecab": mecab_pkg,
    "GameSentenceMiner.util.database.db": db_stub,
    "GameSentenceMiner.util.media": media_pkg,
    "GameSentenceMiner.util.media.ffmpeg": ffmpeg_stub,
    "GameSentenceMiner.util.models.model": model_stub,
    "GameSentenceMiner.util.platform": platform_pkg,
    "GameSentenceMiner.util.platform.notification": notification_stub,
    "GameSentenceMiner.util.stats.live_stats": live_stats_stub,
    "GameSentenceMiner.util.text_log": text_log_stub,
    "GameSentenceMiner.web": web_pkg,
    "GameSentenceMiner.web.texthooking_page": texthooking_stub,
    "GameSentenceMiner.web.gsm_websocket": gsm_websocket_stub,
}

with _temporary_sys_modules(_STUB_MODULES):
    from GameSentenceMiner import anki  # noqa: E402


@pytest.fixture(autouse=True)
def _reset_state():
    anki.sentence_audio_cache.clear()
    anki.gsm_state.last_mined_line = None
    anki.gsm_state.replay_buffer_length = 300


def test_add_wildcards():
    assert anki.add_wildcards("abc") == "*a*b*c*"


def test_normalize_for_signature_uses_html_strip_and_text_normalization(monkeypatch):
    monkeypatch.setattr(anki, "remove_html_and_cloze_tags", lambda text: "Hello, World!")
    monkeypatch.setattr(anki, "strip_whitespace_and_punctuation", lambda text: text.replace(",", "").replace(" ", ""))
    assert anki._normalize_for_signature("<b>ignored</b>") == "helloworld!"


def test_build_sentence_audio_key_from_selected_lines(monkeypatch):
    monkeypatch.setattr(anki, "_normalize_for_signature", lambda text: text.strip().lower())
    selected = [SimpleNamespace(text=" One "), None, SimpleNamespace(text="Two")]

    key = anki._build_sentence_audio_key(SimpleNamespace(text="unused"), selected)

    assert key == ("onetwo", ("one", "two"))


def test_build_sentence_audio_key_falls_back_to_game_line(monkeypatch):
    monkeypatch.setattr(anki, "_normalize_for_signature", lambda text: text.lower())
    key = anki._build_sentence_audio_key(SimpleNamespace(text="Single"), None)
    assert key == ("single", ("single",))


def test_build_sentence_audio_key_returns_none_when_empty_signature(monkeypatch):
    monkeypatch.setattr(anki, "_normalize_for_signature", lambda text: "")
    key = anki._build_sentence_audio_key(SimpleNamespace(text=""), [SimpleNamespace(text="   ")])
    assert key is None


def test_set_sentence_audio_cache_entry_and_prune():
    key = ("sig", ("sig",))
    anki._set_sentence_audio_cache_entry(key, "line-1", "word")
    assert key in anki.sentence_audio_cache
    assert anki.sentence_audio_cache[key].line_id == "line-1"

    stale_key = ("stale", ("stale",))
    anki.sentence_audio_cache[stale_key] = anki.SentenceAudioCacheEntry(
        line_id="old",
        word="old",
        created_at=datetime.now() - timedelta(seconds=10_000),
    )
    anki.gsm_state.replay_buffer_length = 60
    anki._prune_sentence_audio_cache()

    assert stale_key not in anki.sentence_audio_cache
    assert key in anki.sentence_audio_cache


def test_sentence_is_same_as_previous(monkeypatch):
    anki.gsm_state.last_mined_line = SimpleNamespace(id="line-1")
    monkeypatch.setattr(anki, "get_mined_line", lambda card, lines=None: SimpleNamespace(id="line-1"))
    assert anki.sentence_is_same_as_previous(SimpleNamespace()) is True

    monkeypatch.setattr(anki, "get_mined_line", lambda card, lines=None: SimpleNamespace(id="line-2"))
    assert anki.sentence_is_same_as_previous(SimpleNamespace()) is False


def test_check_tags_for_should_update(monkeypatch):
    config = SimpleNamespace(anki=SimpleNamespace(tags_to_check=["target"], sentence_field="Sentence"))
    monkeypatch.setattr(anki, "get_config", lambda: config)

    card = SimpleNamespace(tags=["Target", "Other"])
    assert anki.check_tags_for_should_update(card) is True

    card2 = SimpleNamespace(tags=["Other"])
    assert anki.check_tags_for_should_update(card2) is False

    config.anki.tags_to_check = []
    assert anki.check_tags_for_should_update(card2) is True


def test_get_sentence_uses_configured_field(monkeypatch):
    config = SimpleNamespace(anki=SimpleNamespace(sentence_field="Sentence"))
    monkeypatch.setattr(anki, "get_config", lambda: config)
    card = SimpleNamespace(get_field=lambda field: f"value-for-{field}")
    assert anki.get_sentence(card) == "value-for-Sentence"


def _base_config():
    return SimpleNamespace(
        anki=SimpleNamespace(
            sentence_audio_field="SentenceAudio",
            picture_field="Picture",
            previous_image_field="PrevImage",
            game_name_field="GameName",
            sentence_field="Sentence",
            overwrite_audio=False,
            overwrite_picture=False,
            add_game_tag=True,
            parent_tag="Game",
            custom_tags=["GSM"],
            tags_to_check=[],
            url="http://127.0.0.1:8765",
            auto_accept_timer=1,
            video_field="VideoField",
            word_field="Word",
            tag_unvoiced_cards=False,
        ),
        screenshot=SimpleNamespace(
            enabled=True,
            animated=False,
            use_screenshot_selector=False,
            animated_settings=SimpleNamespace(extension="webm", scaled_quality=20, fps=15),
            remove_screenshot=False,
        ),
        ai=SimpleNamespace(add_to_anki=False, anki_field="AIField"),
        audio=SimpleNamespace(external_tool="", external_tool_enabled=False, anki_media_collection="media"),
        features=SimpleNamespace(
            open_anki_in_browser=False,
            open_anki_edit=False,
            notify_on_update=False,
            browser_query="",
        ),
        paths=SimpleNamespace(
            output_folder="",
            copy_temp_files_to_output_folder=False,
            copy_trimmed_replay_to_output_folder=False,
            open_output_folder_on_card_creation=False,
            remove_screenshot=False,
        ),
        obs=SimpleNamespace(get_game_from_scene=False),
    )


def _overlay_furigana_config():
    cfg = _base_config()
    cfg.anki.overwrite_sentence = True
    cfg.anki.sentence_furigana_field = "SentenceFurigana"
    cfg.anki.previous_sentence_field = ""
    cfg.general = SimpleNamespace(target_language=anki.CommonLanguages.JAPANESE.value)
    cfg.overlay = SimpleNamespace(websocket_port=0)
    cfg.advanced = SimpleNamespace(multi_line_line_break="|", multi_line_sentence_storage_field="")
    return cfg


def test_preserve_html_tags_keeps_furigana_inside_wrapped_word():
    original = "お前が<b>感傷的</b>になって殴りかかったからじゃないか？"
    furigana = "お前[まえ]が感傷的[かんしょうてき]になって殴[なぐ]りかかったからじゃないか？"

    result = anki.preserve_html_tags(original, furigana)

    assert result == "お前[まえ]が<b>感傷的[かんしょうてき]</b>になって殴[なぐ]りかかったからじゃないか？"


def test_preserve_html_tags_for_furigana_keeps_mecab_spacing():
    source = "V:<b>ABCDE</b>"
    furigana = "V: A[a]B C[c]D E[e]"

    result = anki._preserve_html_tags_for_furigana(source, furigana)

    assert result == "V: <b>A[a]B C[c]D E[e]</b>"


def test_preserve_html_tags_for_furigana_preserves_real_source_whitespace():
    source = "I love ABC"
    furigana = "I love A[a] B[b]C"

    result = anki._preserve_html_tags_for_furigana(source, furigana)

    assert result == "I love A[a] B[b]C"


def test_get_initial_card_info_preserves_html_and_wraps_furigana(monkeypatch):
    cfg = _overlay_furigana_config()
    monkeypatch.setattr(anki, "get_config", lambda: cfg)
    monkeypatch.setattr(anki, "TextSource", SimpleNamespace(HOTKEY="hotkey"))

    sentence_in_anki = "お前が<b>感傷的</b>になって殴りかかったからじゃないか？"
    furigana = "お前[まえ]が感傷的[かんしょうてき]になって殴[なぐ]りかかったからじゃないか？"
    monkeypatch.setattr(anki.mecab, "reading", lambda _text: furigana, raising=False)

    class FakeCard:
        def __init__(self, sentence):
            self.noteId = 1
            self.tags = []
            self.fields = {"Sentence": SimpleNamespace(value=sentence)}

        def get_field(self, field):
            return self.fields.get(field, SimpleNamespace(value="")).value

    last_note = FakeCard(sentence_in_anki)
    game_line = SimpleNamespace(
        text="お前が感傷的になって殴りかかったからじゃないか？",
        source="overlay",
        prev=None,
    )

    note, _ = anki.get_initial_card_info(last_note, selected_lines=[], game_line=game_line)

    assert note["fields"]["Sentence"] == sentence_in_anki
    assert note["fields"]["SentenceFurigana"] == "お前[まえ]が<b>感傷的[かんしょうてき]</b>になって殴[なぐ]りかかったからじゃないか？"


def test_get_initial_card_info_keeps_br_and_bold_in_furigana(monkeypatch):
    cfg = _overlay_furigana_config()
    monkeypatch.setattr(anki, "get_config", lambda: cfg)
    monkeypatch.setattr(anki, "TextSource", SimpleNamespace(HOTKEY="hotkey"))

    sentence_in_anki = "V:hello?<br>M:<b>ABCDE</b>FG"
    furigana = "V: hello?M: A[a]B C[c]D E[e]FG"
    monkeypatch.setattr(anki.mecab, "reading", lambda _text: furigana, raising=False)

    class FakeCard:
        def __init__(self, sentence):
            self.noteId = 1
            self.tags = []
            self.fields = {"Sentence": SimpleNamespace(value=sentence)}

        def get_field(self, field):
            return self.fields.get(field, SimpleNamespace(value="")).value

    last_note = FakeCard(sentence_in_anki)
    game_line = SimpleNamespace(
        text="V:hello?M:ABCDEFG",
        source="overlay",
        prev=None,
    )

    note, _ = anki.get_initial_card_info(last_note, selected_lines=[], game_line=game_line)

    assert note["fields"]["Sentence"] == sentence_in_anki
    assert note["fields"]["SentenceFurigana"] == "V: hello?<br>M: <b>A[a]B C[c]D E[e]</b>FG"


def test_migrate_old_word_folders_exits_when_output_missing(monkeypatch):
    cfg = _base_config()
    cfg.paths.output_folder = ""
    monkeypatch.setattr(anki, "get_config", lambda: cfg)
    anki.migrate_old_word_folders()


def test_determine_update_conditions(monkeypatch):
    cfg = _base_config()
    monkeypatch.setattr(anki, "get_config", lambda: cfg)

    note_missing = SimpleNamespace(get_field=lambda field: "")
    assert anki._determine_update_conditions(note_missing) == (True, True)

    note_filled = SimpleNamespace(get_field=lambda field: "value")
    assert anki._determine_update_conditions(note_filled) == (False, False)


def test_prepare_anki_tags(monkeypatch):
    cfg = _base_config()
    cfg.anki.parent_tag = "MyParent"
    monkeypatch.setattr(anki, "get_config", lambda: cfg)
    monkeypatch.setattr(anki, "get_current_game", lambda: "My Game::Test")

    tags = anki._prepare_anki_tags()
    assert tags[0] == "MyParent::MyGameTest"
    assert "GSM" in tags


def test_prepare_anki_note_fields_sets_expected_fields(monkeypatch):
    cfg = _base_config()
    cfg.ai.add_to_anki = False
    monkeypatch.setattr(anki, "get_config", lambda: cfg)
    monkeypatch.setattr(anki, "get_current_game", lambda: "Current Game")

    note = {"fields": {}}
    last_note = SimpleNamespace(get_field=lambda field: "")
    assets = anki.MediaAssets(video_in_anki="video.mp4", prev_screenshot_in_anki="prev.webp")
    game_line = SimpleNamespace(TL="")

    result = anki._prepare_anki_note_fields(note, last_note, assets, game_line)

    assert result["fields"]["VideoField"] == "video.mp4"
    assert result["fields"]["PrevImage"] == '<img src="prev.webp">'
    assert result["fields"]["GameName"] == "Current Game"


def test_encode_and_replace_raw_image_non_raw_passthrough():
    assert anki._encode_and_replace_raw_image("normal.webp") == "normal.webp"


def test_encode_and_replace_raw_image_encodes_raw_file(monkeypatch, tmp_path):
    raw = tmp_path / "frame_001_raw.png"
    raw.write_bytes(b"raw")
    encoded = tmp_path / "encoded.webp"
    encoded.write_bytes(b"encoded")

    monkeypatch.setattr(anki.ffmpeg, "encode_screenshot", lambda _path, **_kwargs: str(encoded))
    result = anki._encode_and_replace_raw_image(str(raw))

    assert result == str(encoded)
    assert not raw.exists()


def test_process_screenshot_with_existing_files(monkeypatch):
    cfg = _base_config()
    assets = anki.MediaAssets(screenshot_in_anki="image.webp")
    note = {"fields": {}}
    anki._process_screenshot(assets, note, cfg, update_picture_flag=True, use_existing_files=True)
    assert note["fields"]["Picture"] == '<img src="image.webp">'


def test_process_previous_screenshot_uploads_and_sets_field(monkeypatch, tmp_path):
    cfg = _base_config()
    prev = tmp_path / "prev_raw.png"
    prev.write_bytes(b"img")

    monkeypatch.setattr(anki, "_encode_and_replace_raw_image", lambda path, **_kwargs: path)
    monkeypatch.setattr(anki, "store_media_file", lambda path: "prev-in-anki.webp")

    assets = anki.MediaAssets(prev_screenshot_path=str(prev))
    note = {"fields": {}}
    anki._process_previous_screenshot(assets, note, cfg, use_existing_files=False)

    assert assets.prev_screenshot_in_anki == "prev-in-anki.webp"
    assert note["fields"]["PrevImage"] == '<img src="prev-in-anki.webp">'


def test_process_audio_with_existing_files_and_external_tool(monkeypatch):
    cfg = _base_config()
    cfg.audio.external_tool = "tool.exe"
    cfg.audio.external_tool_enabled = True

    called = []
    monkeypatch.setattr(anki, "open_audio_in_external", lambda path: called.append(path))

    assets = anki.MediaAssets(audio_in_anki="audio.mp3")
    note = {"fields": {}}
    anki._process_audio(assets, note, cfg, use_voice=True, use_existing_files=True)

    assert note["fields"]["SentenceAudio"] == "[sound:audio.mp3]"
    assert called and called[0].endswith("audio.mp3")


def test_cleanup_assets_invokes_callback():
    called = []
    assets = anki.MediaAssets(cleanup_callback=lambda: called.append("ok"))
    anki._cleanup_assets(assets)
    assert called == ["ok"]


def test_check_and_update_note_runs_pipeline(monkeypatch):
    calls = []
    cfg = _base_config()
    monkeypatch.setattr(anki, "get_config", lambda: cfg)
    monkeypatch.setattr(anki, "_process_screenshot", lambda *args, **kwargs: calls.append("screenshot"))
    monkeypatch.setattr(anki, "_process_previous_screenshot", lambda *args, **kwargs: calls.append("prev"))
    monkeypatch.setattr(anki, "_process_animated_screenshot", lambda *args, **kwargs: calls.append("animated"))
    monkeypatch.setattr(anki, "_process_video", lambda *args, **kwargs: calls.append("video"))
    monkeypatch.setattr(anki, "_process_audio", lambda *args, **kwargs: calls.append("audio"))
    monkeypatch.setattr(anki, "_update_anki_note", lambda *args, **kwargs: ["id-1"])
    monkeypatch.setattr(anki, "_perform_post_update_actions", lambda *args, **kwargs: calls.append("post"))
    monkeypatch.setattr(anki, "_cleanup_assets", lambda *args, **kwargs: calls.append("cleanup"))

    callback_called = []
    assets = anki.MediaAssets()
    note = {"fields": {}}
    anki.check_and_update_note(
        last_note=SimpleNamespace(noteId=1),
        note=note,
        tags=[],
        assets=assets,
        use_voice=True,
        update_picture_flag=True,
        use_existing_files=False,
        assets_ready_callback=lambda _assets: callback_called.append(True),
    )

    assert callback_called == [True]
    assert calls == ["screenshot", "prev", "animated", "video", "audio", "post", "cleanup"]


def test_convert_to_base64_and_request_payload(tmp_path):
    media = tmp_path / "a.bin"
    media.write_bytes(b"abc")
    assert anki.convert_to_base64(str(media)) == "YWJj"
    assert anki.request("findNotes", query="added:1") == {
        "action": "findNotes",
        "params": {"query": "added:1"},
        "version": 6,
    }


def test_store_media_file_with_sanitized_filename(monkeypatch, tmp_path):
    media = tmp_path / "a b.bin"
    media.write_bytes(b"abc")

    monkeypatch.setattr(anki, "sanitize_filename", lambda name: name.replace(" ", ""))
    monkeypatch.setattr(anki, "invoke", lambda action, **kwargs: kwargs["filename"])

    stored_name = anki.store_media_file(str(media))
    assert stored_name.endswith("ab.bin")


def test_invoke_success_and_failure_retry(monkeypatch):
    cfg = _base_config()
    monkeypatch.setattr(anki, "get_config", lambda: cfg)

    class SuccessResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {"error": None, "result": 42}

    monkeypatch.setattr(anki.requests, "post", lambda *args, **kwargs: SuccessResponse())
    assert anki.invoke("deckNames") == 42

    attempts = {"count": 0}

    class ErrorResponse:
        def raise_for_status(self):
            return None

        def json(self):
            attempts["count"] += 1
            return {"error": "boom", "result": None}

    monkeypatch.setattr(anki.requests, "post", lambda *args, **kwargs: ErrorResponse())
    monkeypatch.setattr(anki.time, "sleep", lambda *_args, **_kwargs: None)
    with pytest.raises(Exception):
        anki.invoke("deckNames", retries=1)
    assert attempts["count"] >= 2


def test_get_last_anki_card_and_get_cards_by_sentence(monkeypatch):
    class FakeCard:
        @staticmethod
        def from_dict(data):
            return {"noteId": data["noteId"]}

    cfg = _base_config()
    monkeypatch.setattr(anki, "get_config", lambda: cfg)
    monkeypatch.setattr(anki, "AnkiCard", FakeCard)

    responses = {
        ("findNotes", "added:1"): [1],
        ("notesInfo", (1,)): [{"noteId": 1}],
        ("findCards", f"{cfg.anki.sentence_audio_field}: {cfg.anki.sentence_field}:{anki.add_wildcards('abc')}"): [2],
        ("notesInfo", (2,)): [{"noteId": 2}],
    }

    def fake_invoke(action, **kwargs):
        if action == "findNotes":
            return responses[(action, kwargs["query"])]
        if action == "findCards":
            return responses[(action, kwargs["query"])]
        if action == "notesInfo":
            return responses[(action, tuple(kwargs["notes"]))]
        return None

    monkeypatch.setattr(anki, "invoke", fake_invoke)

    assert anki.get_last_anki_card() == {"noteId": 1}
    assert anki.get_cards_by_sentence("a b c") == {"noteId": 2}
