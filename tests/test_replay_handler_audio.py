import importlib
import sys
from contextlib import contextmanager
from types import ModuleType, SimpleNamespace


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


class _NoopLogger:
    def __getattr__(self, _name):
        def _noop(*_args, **_kwargs):
            return None

        return _noop


class _VADResult:
    def __init__(
        self,
        success,
        start,
        end,
        model,
        segments=None,
        output_audio=None,
        trimmed_audio_path=None,
        tts_used=False,
    ):
        self.success = success
        self.start = start
        self.end = end
        self.model = model
        self.segments = segments if segments is not None else []
        self.output_audio = output_audio
        self.trimmed_audio_path = trimmed_audio_path
        self.tts_used = tts_used

    def trim_successful_string(self):
        return "ok"


def test_get_audio_uses_trimmed_clip_for_editing_and_defers_user_reencode(tmp_path):
    source_audio = tmp_path / "source.opus"
    source_audio.write_bytes(b"source")
    trimmed_audio = tmp_path / "trimmed.opus"
    trimmed_audio.write_bytes(b"trimmed")

    logger = _NoopLogger()
    config = SimpleNamespace(
        vad=SimpleNamespace(do_vad_postprocessing=False, trim_beginning=True),
        audio=SimpleNamespace(extension="opus", ffmpeg_reencode_options_to_use="-b:a 64k"),
        anki=SimpleNamespace(show_update_confirmation_dialog_v2=True),
        advanced=SimpleNamespace(multi_line_line_break=" "),
    )

    anki_stub = ModuleType("GameSentenceMiner.anki")
    obs_stub = ModuleType("GameSentenceMiner.obs")
    obs_stub.get_current_game = lambda sanitize=False: "Test Game"

    ffmpeg_stub = ModuleType("GameSentenceMiner.util.media.ffmpeg")
    ffmpeg_stub.get_audio_and_trim = lambda *_args, **_kwargs: (
        str(source_audio),
        str(trimmed_audio),
        1.0,
        4.0,
    )
    ffmpeg_stub.get_audio_length = lambda path: 3.0 if path == str(trimmed_audio) else 30.0
    ffmpeg_stub.reencode_file_with_user_config = lambda *_args, **_kwargs: (_ for _ in ()).throw(
        AssertionError("user re-encode should be deferred")
    )

    media_pkg = ModuleType("GameSentenceMiner.util.media")
    media_pkg.ffmpeg = ffmpeg_stub

    model_stub = ModuleType("GameSentenceMiner.util.models.model")
    model_stub.VADResult = _VADResult

    gsm_utils_stub = ModuleType("GameSentenceMiner.util.gsm_utils")
    gsm_utils_stub.combine_dialogue = lambda lines: lines
    gsm_utils_stub.make_unique_file_name = lambda path: path
    gsm_utils_stub.remove_html_and_cloze_tags = lambda text: text
    gsm_utils_stub.wait_for_stable_file = lambda *_args, **_kwargs: None

    config_module = ModuleType("GameSentenceMiner.util.config.configuration")
    config_module.AnkiUpdateResult = SimpleNamespace
    config_module.anki_results = {}
    config_module.get_config = lambda: config
    config_module.get_temporary_directory = lambda: str(tmp_path)
    config_module.gsm_state = SimpleNamespace()
    config_module.gsm_status = SimpleNamespace(remove_word_being_processed=lambda *_args, **_kwargs: None)
    config_module.logger = logger

    config_pkg = ModuleType("GameSentenceMiner.util.config")
    config_pkg.configuration = config_module

    vad_stub = ModuleType("GameSentenceMiner.vad")
    vad_stub.vad_processor = SimpleNamespace(initialized=False)

    stubs = {
        "GameSentenceMiner.anki": anki_stub,
        "GameSentenceMiner.obs": obs_stub,
        "GameSentenceMiner.util.config": config_pkg,
        "GameSentenceMiner.util.config.configuration": config_module,
        "GameSentenceMiner.util.gsm_utils": gsm_utils_stub,
        "GameSentenceMiner.util.media": media_pkg,
        "GameSentenceMiner.util.media.ffmpeg": ffmpeg_stub,
        "GameSentenceMiner.util.models.model": model_stub,
        "GameSentenceMiner.vad": vad_stub,
    }

    with _temporary_sys_modules(stubs):
        sys.modules.pop("GameSentenceMiner.replay_handler", None)
        replay_handler = importlib.import_module("GameSentenceMiner.replay_handler")

        result = replay_handler.ReplayAudioExtractor.get_audio(
            game_line=SimpleNamespace(text="line"),
            next_line_time=None,
            video_path="video.mp4",
        )

    assert result.final_audio_output == str(trimmed_audio)
    assert result.vad_result.output_audio == str(trimmed_audio)
    assert result.audio_edit_context == replay_handler.AudioEditContext(
        source_audio_path=str(source_audio),
        source_duration=30.0,
        range_start=1.0,
        range_end=4.0,
        rebase_on_selection_trim=False,
    )


def test_get_audio_maps_vad_window_back_to_full_source_for_editing(tmp_path):
    source_audio = tmp_path / "source.opus"
    source_audio.write_bytes(b"source")
    trimmed_audio = tmp_path / "trimmed.opus"
    trimmed_audio.write_bytes(b"trimmed")
    vad_audio = tmp_path / "vad.opus"
    vad_audio.write_bytes(b"vad")

    logger = _NoopLogger()
    config = SimpleNamespace(
        vad=SimpleNamespace(
            do_vad_postprocessing=True,
            trim_beginning=True,
            cut_and_splice_segments=False,
            add_audio_on_no_results=False,
            use_tts_as_fallback=False,
        ),
        audio=SimpleNamespace(extension="opus", ffmpeg_reencode_options_to_use="-b:a 64k"),
        anki=SimpleNamespace(show_update_confirmation_dialog_v2=True),
        advanced=SimpleNamespace(multi_line_line_break=" "),
    )

    anki_stub = ModuleType("GameSentenceMiner.anki")
    obs_stub = ModuleType("GameSentenceMiner.obs")
    obs_stub.get_current_game = lambda sanitize=False: "Test Game"

    ffmpeg_stub = ModuleType("GameSentenceMiner.util.media.ffmpeg")
    ffmpeg_stub.get_audio_and_trim = lambda *_args, **_kwargs: (
        str(source_audio),
        str(trimmed_audio),
        1.0,
        4.0,
    )
    ffmpeg_stub.get_audio_length = lambda path: 3.0 if path == str(trimmed_audio) else 30.0
    ffmpeg_stub.reencode_file_with_user_config = lambda *_args, **_kwargs: (_ for _ in ()).throw(
        AssertionError("user re-encode should be deferred")
    )

    media_pkg = ModuleType("GameSentenceMiner.util.media")
    media_pkg.ffmpeg = ffmpeg_stub

    model_stub = ModuleType("GameSentenceMiner.util.models.model")
    model_stub.VADResult = _VADResult

    gsm_utils_stub = ModuleType("GameSentenceMiner.util.gsm_utils")
    gsm_utils_stub.combine_dialogue = lambda lines: lines
    gsm_utils_stub.make_unique_file_name = lambda path: path
    gsm_utils_stub.remove_html_and_cloze_tags = lambda text: text
    gsm_utils_stub.wait_for_stable_file = lambda *_args, **_kwargs: None

    config_module = ModuleType("GameSentenceMiner.util.config.configuration")
    config_module.AnkiUpdateResult = SimpleNamespace
    config_module.anki_results = {}
    config_module.get_config = lambda: config
    config_module.get_temporary_directory = lambda: str(tmp_path)
    config_module.gsm_state = SimpleNamespace()
    config_module.gsm_status = SimpleNamespace(remove_word_being_processed=lambda *_args, **_kwargs: None)
    config_module.logger = logger

    config_pkg = ModuleType("GameSentenceMiner.util.config")
    config_pkg.configuration = config_module

    vad_stub = ModuleType("GameSentenceMiner.vad")
    vad_stub.vad_processor = SimpleNamespace(
        initialized=True,
        trim_audio_with_vad=lambda *_args, **_kwargs: _VADResult(
            True,
            0.5,
            2.0,
            "Silero",
            output_audio=str(vad_audio),
        ),
    )

    stubs = {
        "GameSentenceMiner.anki": anki_stub,
        "GameSentenceMiner.obs": obs_stub,
        "GameSentenceMiner.util.config": config_pkg,
        "GameSentenceMiner.util.config.configuration": config_module,
        "GameSentenceMiner.util.gsm_utils": gsm_utils_stub,
        "GameSentenceMiner.util.media": media_pkg,
        "GameSentenceMiner.util.media.ffmpeg": ffmpeg_stub,
        "GameSentenceMiner.util.models.model": model_stub,
        "GameSentenceMiner.vad": vad_stub,
    }

    with _temporary_sys_modules(stubs):
        sys.modules.pop("GameSentenceMiner.replay_handler", None)
        replay_handler = importlib.import_module("GameSentenceMiner.replay_handler")

        result = replay_handler.ReplayAudioExtractor.get_audio(
            game_line=SimpleNamespace(text="line"),
            next_line_time=None,
            video_path="video.mp4",
        )

    assert result.final_audio_output == str(vad_audio)
    assert result.audio_edit_context == replay_handler.AudioEditContext(
        source_audio_path=str(source_audio),
        source_duration=30.0,
        range_start=1.5,
        range_end=3.0,
        rebase_on_selection_trim=False,
    )


def test_get_audio_marks_condensed_audio_for_rebased_editing(tmp_path):
    source_audio = tmp_path / "source.opus"
    source_audio.write_bytes(b"source")
    trimmed_audio = tmp_path / "trimmed.opus"
    trimmed_audio.write_bytes(b"trimmed")
    vad_audio = tmp_path / "vad.opus"
    vad_audio.write_bytes(b"vad")

    logger = _NoopLogger()
    config = SimpleNamespace(
        vad=SimpleNamespace(
            do_vad_postprocessing=True,
            trim_beginning=True,
            cut_and_splice_segments=True,
            add_audio_on_no_results=False,
            use_tts_as_fallback=False,
        ),
        audio=SimpleNamespace(extension="opus", ffmpeg_reencode_options_to_use="-b:a 64k"),
        anki=SimpleNamespace(show_update_confirmation_dialog_v2=True),
        advanced=SimpleNamespace(multi_line_line_break=" "),
    )

    anki_stub = ModuleType("GameSentenceMiner.anki")
    obs_stub = ModuleType("GameSentenceMiner.obs")
    obs_stub.get_current_game = lambda sanitize=False: "Test Game"

    ffmpeg_stub = ModuleType("GameSentenceMiner.util.media.ffmpeg")
    ffmpeg_stub.get_audio_and_trim = lambda *_args, **_kwargs: (
        str(source_audio),
        str(trimmed_audio),
        1.0,
        4.0,
    )
    ffmpeg_stub.get_audio_length = lambda path: 3.0 if path == str(trimmed_audio) else 30.0
    ffmpeg_stub.reencode_file_with_user_config = lambda *_args, **_kwargs: (_ for _ in ()).throw(
        AssertionError("user re-encode should be deferred")
    )

    media_pkg = ModuleType("GameSentenceMiner.util.media")
    media_pkg.ffmpeg = ffmpeg_stub

    model_stub = ModuleType("GameSentenceMiner.util.models.model")
    model_stub.VADResult = _VADResult

    gsm_utils_stub = ModuleType("GameSentenceMiner.util.gsm_utils")
    gsm_utils_stub.combine_dialogue = lambda lines: lines
    gsm_utils_stub.make_unique_file_name = lambda path: path
    gsm_utils_stub.remove_html_and_cloze_tags = lambda text: text
    gsm_utils_stub.wait_for_stable_file = lambda *_args, **_kwargs: None

    config_module = ModuleType("GameSentenceMiner.util.config.configuration")
    config_module.AnkiUpdateResult = SimpleNamespace
    config_module.anki_results = {}
    config_module.get_config = lambda: config
    config_module.get_temporary_directory = lambda: str(tmp_path)
    config_module.gsm_state = SimpleNamespace()
    config_module.gsm_status = SimpleNamespace(remove_word_being_processed=lambda *_args, **_kwargs: None)
    config_module.logger = logger

    config_pkg = ModuleType("GameSentenceMiner.util.config")
    config_pkg.configuration = config_module

    vad_stub = ModuleType("GameSentenceMiner.vad")
    vad_stub.vad_processor = SimpleNamespace(
        initialized=True,
        trim_audio_with_vad=lambda *_args, **_kwargs: _VADResult(
            True,
            0.5,
            2.0,
            "Silero",
            output_audio=str(vad_audio),
        ),
    )

    stubs = {
        "GameSentenceMiner.anki": anki_stub,
        "GameSentenceMiner.obs": obs_stub,
        "GameSentenceMiner.util.config": config_pkg,
        "GameSentenceMiner.util.config.configuration": config_module,
        "GameSentenceMiner.util.gsm_utils": gsm_utils_stub,
        "GameSentenceMiner.util.media": media_pkg,
        "GameSentenceMiner.util.media.ffmpeg": ffmpeg_stub,
        "GameSentenceMiner.util.models.model": model_stub,
        "GameSentenceMiner.vad": vad_stub,
    }

    with _temporary_sys_modules(stubs):
        sys.modules.pop("GameSentenceMiner.replay_handler", None)
        replay_handler = importlib.import_module("GameSentenceMiner.replay_handler")

        result = replay_handler.ReplayAudioExtractor.get_audio(
            game_line=SimpleNamespace(text="line"),
            next_line_time=None,
            video_path="video.mp4",
        )

    assert result.final_audio_output == str(vad_audio)
    assert result.audio_edit_context == replay_handler.AudioEditContext(
        source_audio_path=str(source_audio),
        source_duration=30.0,
        range_start=1.5,
        range_end=3.0,
        rebase_on_selection_trim=True,
    )
