from types import SimpleNamespace

from PyQt6.QtCore import Qt

from GameSentenceMiner.ui import anki_confirmation_qt
from GameSentenceMiner.ui import audio_waveform_widget


class _WindowBehaviorProbe:
    def __init__(self, focus_on_show: bool):
        self.focus_on_show = focus_on_show
        self.attributes = []
        self.flags = None

    def _should_focus_on_show(self):
        return self.focus_on_show

    def setAttribute(self, attribute, value):
        self.attributes.append((attribute, value))

    def setWindowFlags(self, flags):
        self.flags = flags


class _ExecRoutingProbe:
    def __init__(self, focus_on_show: bool):
        self.focus_on_show = focus_on_show
        self.calls = []

    def _apply_window_behavior_preferences(self):
        self.calls.append("apply")

    def _should_focus_on_show(self):
        return self.focus_on_show

    def _exec_with_activation(self):
        self.calls.append("with")
        return "with"

    def _exec_without_activation(self):
        self.calls.append("without")
        return "without"


def test_apply_window_behavior_preferences_sets_show_without_activating(monkeypatch):
    config = SimpleNamespace(anki=SimpleNamespace(confirmation_always_on_top=True))
    monkeypatch.setattr(anki_confirmation_qt, "get_config", lambda: config)

    probe = _WindowBehaviorProbe(focus_on_show=False)
    anki_confirmation_qt.AnkiConfirmationDialog._apply_window_behavior_preferences(probe)

    assert probe.attributes == [(Qt.WidgetAttribute.WA_ShowWithoutActivating, True)]
    assert probe.flags & Qt.WindowType.WindowStaysOnTopHint


def test_apply_window_behavior_preferences_clears_show_without_activating_when_focus_enabled(
    monkeypatch,
):
    config = SimpleNamespace(anki=SimpleNamespace(confirmation_always_on_top=False))
    monkeypatch.setattr(anki_confirmation_qt, "get_config", lambda: config)

    probe = _WindowBehaviorProbe(focus_on_show=True)
    anki_confirmation_qt.AnkiConfirmationDialog._apply_window_behavior_preferences(probe)

    assert probe.attributes == [(Qt.WidgetAttribute.WA_ShowWithoutActivating, False)]
    assert not (probe.flags & Qt.WindowType.WindowStaysOnTopHint)


def test_exec_routes_to_non_activating_path_when_focus_disabled():
    probe = _ExecRoutingProbe(focus_on_show=False)

    result = anki_confirmation_qt.AnkiConfirmationDialog.exec(probe)

    assert result == "without"
    assert probe.calls == ["apply", "without"]


def test_exec_routes_to_modal_exec_when_focus_enabled():
    probe = _ExecRoutingProbe(focus_on_show=True)

    result = anki_confirmation_qt.AnkiConfirmationDialog.exec(probe)

    assert result == "with"
    assert probe.calls == ["apply", "with"]


def test_calculate_audio_expanded_range_clamps_to_source_bounds():
    start, end = anki_confirmation_qt.AnkiConfirmationDialog._calculate_audio_expanded_range(
        12.0,
        18.0,
        25.0,
        expand_start=15.0,
        expand_end=15.0,
    )

    assert start == 0.0
    assert end == 25.0


def test_normalize_audio_edit_context_uses_provided_duration(monkeypatch):
    monkeypatch.setattr(anki_confirmation_qt.os.path, "isfile", lambda path: path == "source.opus")

    result = anki_confirmation_qt.AnkiConfirmationDialog._normalize_audio_edit_context(
        {
            "source_audio_path": "source.opus",
            "source_duration": 30.0,
            "range_start": 8.0,
            "range_end": 11.0,
        }
    )

    assert result == {
        "source_audio_path": "source.opus",
        "source_duration": 30.0,
        "range_start": 8.0,
        "range_end": 11.0,
        "rebase_on_selection_trim": False,
    }


def test_normalize_audio_edit_context_falls_back_to_probe_duration(monkeypatch):
    monkeypatch.setattr(anki_confirmation_qt.os.path, "isfile", lambda path: path == "source.opus")
    monkeypatch.setattr(anki_confirmation_qt, "get_audio_length", lambda path: 42.0)

    result = anki_confirmation_qt.AnkiConfirmationDialog._normalize_audio_edit_context(
        {
            "source_audio_path": "source.opus",
            "range_start": 8.0,
            "range_end": 0.0,
        }
    )

    assert result == {
        "source_audio_path": "source.opus",
        "source_duration": 42.0,
        "range_start": 8.0,
        "range_end": 42.0,
        "rebase_on_selection_trim": False,
    }


def test_audio_expand_seconds_shared_between_dialog_and_waveform_labels():
    assert audio_waveform_widget.AUDIO_EXPAND_SECONDS == 0.25
    assert anki_confirmation_qt.AUDIO_EXPAND_SECONDS == audio_waveform_widget.AUDIO_EXPAND_SECONDS
    assert audio_waveform_widget.EXPAND_BUTTON_SECONDS_TEXT == "0.25s"


def test_sync_audio_edit_selection_maps_to_current_source_window():
    probe = SimpleNamespace(
        waveform_widget=SimpleNamespace(audio_data=[1], duration=4.0),
        audio_path="current.opus",
        _audio_edit_rebase_on_selection_trim=False,
        _audio_edit_source_path="source.opus",
        _audio_edit_source_duration=30.0,
        _audio_edit_source_window=(10.0, 14.0),
        _audio_edit_range=(10.0, 14.0),
    )

    anki_confirmation_qt.AnkiConfirmationDialog._sync_audio_edit_selection_to_current_clip(probe, 0.5, 2.5)

    assert probe._audio_edit_source_path == "source.opus"
    assert probe._audio_edit_source_window == (10.0, 14.0)
    assert probe._audio_edit_range == (10.5, 12.5)


def test_sync_audio_edit_selection_preserves_original_source_for_rebased_clips():
    probe = SimpleNamespace(
        waveform_widget=SimpleNamespace(audio_data=[1], duration=4.0),
        audio_path="current.opus",
        _audio_edit_rebase_on_selection_trim=True,
        _audio_edit_source_path="source.opus",
        _audio_edit_source_duration=30.0,
        _audio_edit_source_window=(10.0, 14.0),
        _audio_edit_range=(10.0, 14.0),
    )

    anki_confirmation_qt.AnkiConfirmationDialog._sync_audio_edit_selection_to_current_clip(probe, 0.5, 2.5)

    assert probe._audio_edit_source_path == "source.opus"
    assert probe._audio_edit_source_duration == 30.0
    assert probe._audio_edit_source_window == (10.0, 14.0)
    assert probe._audio_edit_range == (10.5, 12.5)


def test_sync_audio_edit_selection_scales_rebased_clip_selection_to_absolute_window():
    probe = SimpleNamespace(
        waveform_widget=SimpleNamespace(audio_data=[1], duration=4.17),
        audio_path="current.opus",
        _audio_edit_rebase_on_selection_trim=True,
        _audio_edit_source_path="source.opus",
        _audio_edit_source_duration=300.0,
        _audio_edit_source_window=(116.13, 120.30),
        _audio_edit_range=(116.13, 120.30),
    )

    anki_confirmation_qt.AnkiConfirmationDialog._sync_audio_edit_selection_to_current_clip(probe, 0.0, 4.17)

    assert probe._audio_edit_source_path == "source.opus"
    assert probe._audio_edit_source_window == (116.13, 120.30)
    assert probe._audio_edit_range == (116.13, 120.30)


def test_expand_audio_start_resets_existing_start_trim_and_keeps_end_trim():
    captured = {"apply": None, "render": None}
    probe = SimpleNamespace(
        _audio_edit_range=(11.0, 14.0),
        _audio_edit_source_path="source.opus",
        _audio_edit_source_window=(10.0, 20.0),
        _audio_edit_source_duration=30.0,
        _has_performed_audio_expand=True,
    )
    probe._get_current_clip_selection = lambda: (1.0, 4.0, 10.0)
    probe._apply_audio_selection = lambda start, end: captured.__setitem__("apply", (start, end))
    probe._calculate_audio_expanded_range = anki_confirmation_qt.AnkiConfirmationDialog._calculate_audio_expanded_range
    probe._render_audio_edit_range = lambda start, end, selection_start=0.0, selection_end=None: captured.__setitem__(
        "render",
        (start, end, selection_start, selection_end),
    )

    anki_confirmation_qt.AnkiConfirmationDialog._expand_audio_window(probe, expand_start=0.25)

    assert captured["apply"] == (0.0, 4.0)
    assert captured["render"] is None


def test_expand_audio_start_extends_clip_and_preserves_end_trim():
    captured = {"apply": None, "render": None}
    probe = SimpleNamespace(
        _audio_edit_range=(10.0, 17.0),
        _audio_edit_source_path="source.opus",
        _audio_edit_source_window=(10.0, 20.0),
        _audio_edit_source_duration=30.0,
        _has_performed_audio_expand=True,
    )
    probe._get_current_clip_selection = lambda: (0.0, 7.0, 10.0)
    probe._apply_audio_selection = lambda start, end: captured.__setitem__("apply", (start, end))
    probe._calculate_audio_expanded_range = anki_confirmation_qt.AnkiConfirmationDialog._calculate_audio_expanded_range
    probe._render_audio_edit_range = lambda start, end, selection_start=0.0, selection_end=None: captured.__setitem__(
        "render",
        (start, end, selection_start, selection_end),
    )

    anki_confirmation_qt.AnkiConfirmationDialog._expand_audio_window(probe, expand_start=0.25)

    assert captured["apply"] is None
    assert captured["render"] == (9.75, 20.0, 0.0, 7.25)


def test_expand_audio_end_resets_existing_end_trim_and_keeps_start_trim():
    captured = {"apply": None, "render": None}
    probe = SimpleNamespace(
        _audio_edit_range=(11.0, 14.0),
        _audio_edit_source_path="source.opus",
        _audio_edit_source_window=(10.0, 20.0),
        _audio_edit_source_duration=30.0,
        _has_performed_audio_expand=True,
    )
    probe._get_current_clip_selection = lambda: (1.0, 4.0, 10.0)
    probe._apply_audio_selection = lambda start, end: captured.__setitem__("apply", (start, end))
    probe._calculate_audio_expanded_range = anki_confirmation_qt.AnkiConfirmationDialog._calculate_audio_expanded_range
    probe._render_audio_edit_range = lambda start, end, selection_start=0.0, selection_end=None: captured.__setitem__(
        "render",
        (start, end, selection_start, selection_end),
    )

    anki_confirmation_qt.AnkiConfirmationDialog._expand_audio_window(probe, expand_end=0.25)

    assert captured["apply"] == (1.0, 10.0)
    assert captured["render"] is None


def test_expand_audio_end_extends_clip_and_preserves_start_trim():
    captured = {"apply": None, "render": None}
    probe = SimpleNamespace(
        _audio_edit_range=(11.0, 20.0),
        _audio_edit_source_path="source.opus",
        _audio_edit_source_window=(10.0, 20.0),
        _audio_edit_source_duration=30.0,
        _has_performed_audio_expand=True,
    )
    probe._get_current_clip_selection = lambda: (1.0, 10.0, 10.0)
    probe._apply_audio_selection = lambda start, end: captured.__setitem__("apply", (start, end))
    probe._calculate_audio_expanded_range = anki_confirmation_qt.AnkiConfirmationDialog._calculate_audio_expanded_range
    probe._render_audio_edit_range = lambda start, end, selection_start=0.0, selection_end=None: captured.__setitem__(
        "render",
        (start, end, selection_start, selection_end),
    )

    anki_confirmation_qt.AnkiConfirmationDialog._expand_audio_window(probe, expand_end=0.25)

    assert captured["apply"] is None
    assert captured["render"] == (10.0, 20.25, 1.0, 10.25)


def test_first_expand_audio_start_resets_full_selection_after_extending_clip():
    captured = {"apply": None, "render": None}
    probe = SimpleNamespace(
        _audio_edit_range=(11.0, 14.0),
        _audio_edit_source_path="source.opus",
        _audio_edit_source_window=(10.0, 20.0),
        _audio_edit_source_duration=30.0,
        _has_performed_audio_expand=False,
    )
    probe._get_current_clip_selection = lambda: (1.0, 4.0, 10.0)
    probe._apply_audio_selection = lambda start, end: captured.__setitem__("apply", (start, end))
    probe._calculate_audio_expanded_range = anki_confirmation_qt.AnkiConfirmationDialog._calculate_audio_expanded_range
    probe._render_audio_edit_range = lambda start, end, selection_start=0.0, selection_end=None: captured.__setitem__(
        "render",
        (start, end, selection_start, selection_end),
    )

    anki_confirmation_qt.AnkiConfirmationDialog._expand_audio_window(probe, expand_start=0.25)

    assert captured["apply"] is None
    assert captured["render"] == (9.75, 20.0, 0.0, None)
    assert probe._has_performed_audio_expand is True


def test_first_expand_audio_resets_full_selection_when_clip_cannot_expand():
    captured = {"apply": None, "render": None}
    probe = SimpleNamespace(
        _audio_edit_range=(1.0, 8.0),
        _audio_edit_source_path="source.opus",
        _audio_edit_source_window=(0.0, 10.0),
        _audio_edit_source_duration=10.0,
        _has_performed_audio_expand=False,
    )
    probe._get_current_clip_selection = lambda: (1.0, 8.0, 10.0)
    probe._apply_audio_selection = lambda start, end: captured.__setitem__("apply", (start, end))
    probe._calculate_audio_expanded_range = anki_confirmation_qt.AnkiConfirmationDialog._calculate_audio_expanded_range
    probe._render_audio_edit_range = lambda start, end, selection_start=0.0, selection_end=None: captured.__setitem__(
        "render",
        (start, end, selection_start, selection_end),
    )

    anki_confirmation_qt.AnkiConfirmationDialog._expand_audio_window(probe, expand_start=0.25)

    assert captured["apply"] == (0.0, 10.0)
    assert captured["render"] is None
    assert probe._has_performed_audio_expand is True


def test_apply_dialogue_line_change_refreshes_audio_edit_context(monkeypatch):
    monkeypatch.setattr(anki_confirmation_qt.gsm_state, "audio_edit_context", None, raising=False)
    monkeypatch.setattr(anki_confirmation_qt.gsm_state, "vad_result", None, raising=False)

    first_line = SimpleNamespace(id="line-1")
    second_line = SimpleNamespace(id="line-2", get_next_time=lambda: "line-2-cutoff")
    selected_lines = [first_line, second_line]

    audio_edit_context = SimpleNamespace(source_audio_path="updated.opus")
    vad_result = SimpleNamespace(output_audio="updated.opus")
    audio_result = SimpleNamespace(
        vad_result=vad_result,
        final_audio_output="updated.opus",
        audio_edit_context=audio_edit_context,
    )

    calls = {}
    replay_context = SimpleNamespace(
        selected_lines=[],
        mined_line=SimpleNamespace(id="line-2"),
        start_line=None,
        line_cutoff=None,
        full_text="",
        sentence_for_translation="",
        audio_result="stale",
    )
    probe = SimpleNamespace(
        _dialogue_line_expansion_enabled=lambda: True,
        _dialogue_line_update_in_progress=False,
        _auto_line_expand_timer=SimpleNamespace(stop=lambda: calls.__setitem__("timer_stopped", True)),
        _pending_auto_line_direction="start",
        _dialog_selected_lines=[second_line],
        _dialog_original_selected_line_ids=("line-2",),
        _line_ids_for_dialogue=anki_confirmation_qt.AnkiConfirmationDialog._line_ids_for_dialogue,
        _build_dialogue_sentence=lambda lines: "combined sentence",
        _regenerate_dialogue_translation=lambda sentence: ("combined translation", True),
        _regenerate_dialogue_audio=lambda lines, sentence: audio_result,
        _load_audio_edit_context=lambda context: calls.__setitem__("loaded_context", context),
        _selected_lines_for_pipeline=lambda: list(selected_lines),
        _replay_context=replay_context,
        _refresh_dialog_after_line_change=lambda sentence, translation: calls.__setitem__(
            "refreshed",
            (sentence, translation),
        ),
        _dialog_audio_result="stale",
        _dialog_translation_regenerated=False,
        vad_result=None,
        audio_path="old.opus",
    )

    anki_confirmation_qt.AnkiConfirmationDialog._apply_dialogue_line_change(probe, selected_lines)

    assert probe._dialog_selected_lines == selected_lines
    assert probe._dialog_line_selection_changed is True
    assert probe._dialog_audio_result is audio_result
    assert probe._dialog_translation_regenerated is True
    assert probe.audio_path == "updated.opus"
    assert calls["loaded_context"] is audio_edit_context
    assert calls["refreshed"] == ("combined sentence", "combined translation")
    assert replay_context.selected_lines == selected_lines
    assert replay_context.start_line is first_line
    assert replay_context.line_cutoff == "line-2-cutoff"
    assert replay_context.full_text == "combined sentence"
    assert replay_context.sentence_for_translation == "combined sentence"
    assert replay_context.audio_result is audio_result
    assert anki_confirmation_qt.gsm_state.audio_edit_context is audio_edit_context
    assert anki_confirmation_qt.gsm_state.vad_result is vad_result
