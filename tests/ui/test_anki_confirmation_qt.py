import os
from datetime import datetime, timedelta
from types import SimpleNamespace

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import numpy as np
import pytest
from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import QApplication

from GameSentenceMiner.ui import anki_confirmation_qt
from GameSentenceMiner.ui import audio_waveform_widget


class _UnavailableAudioPlayer:
    audio_available = False

    def __init__(self, finished_callback=None):
        self.finished_callback = finished_callback


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


class _WidgetProbe:
    def __init__(self):
        self.text = ""
        self.style = ""
        self.visible = None

    def setText(self, text):
        self.text = text

    def setStyleSheet(self, style):
        self.style = style

    def setVisible(self, visible):
        self.visible = visible

    def setEnabled(self, enabled):
        self.enabled = enabled

    def setToolTip(self, tooltip):
        self.tooltip = tooltip


def test_regenerate_sentence_meaning_is_enabled_by_default(monkeypatch):
    app = QApplication.instance() or QApplication([])
    monkeypatch.setattr(anki_confirmation_qt, "AudioPlayer", _UnavailableAudioPlayer)
    monkeypatch.setattr(anki_confirmation_qt.gsm_state, "current_replay_context", None)
    monkeypatch.setattr(anki_confirmation_qt.gsm_state, "audio_edit_context", None)
    monkeypatch.setattr(anki_confirmation_qt.gsm_state, "vad_result", None)

    dialog = anki_confirmation_qt.AnkiConfirmationDialog()
    dialog.regen_translation_checkbox.setChecked(False)
    dialog.populate_ui(
        expression="",
        sentence="",
        screenshot_path=None,
        previous_screenshot_path=None,
        audio_path=None,
        translation="",
        screenshot_timestamp=0,
        previous_screenshot_timestamp=0,
    )

    assert dialog.regen_translation_checkbox.isChecked()

    dialog.deleteLater()
    app.processEvents()


def test_apply_window_behavior_preferences_sets_show_without_activating(monkeypatch):
    config = SimpleNamespace(anki=SimpleNamespace(confirmation_always_on_top=True))
    monkeypatch.setattr(anki_confirmation_qt, "get_config", lambda: config)

    probe = _WindowBehaviorProbe(focus_on_show=False)
    anki_confirmation_qt.AnkiConfirmationDialog._apply_window_behavior_preferences(probe)

    assert probe.attributes == [(Qt.WidgetAttribute.WA_ShowWithoutActivating, True)]
    assert probe.flags & Qt.WindowType.WindowStaysOnTopHint
    assert probe.flags & Qt.WindowType.WindowSystemMenuHint
    assert probe.flags & Qt.WindowType.WindowCloseButtonHint


def test_apply_window_behavior_preferences_clears_show_without_activating_when_focus_enabled(
    monkeypatch,
):
    config = SimpleNamespace(anki=SimpleNamespace(confirmation_always_on_top=False))
    monkeypatch.setattr(anki_confirmation_qt, "get_config", lambda: config)

    probe = _WindowBehaviorProbe(focus_on_show=True)
    anki_confirmation_qt.AnkiConfirmationDialog._apply_window_behavior_preferences(probe)

    assert probe.attributes == [(Qt.WidgetAttribute.WA_ShowWithoutActivating, False)]
    assert not (probe.flags & Qt.WindowType.WindowStaysOnTopHint)
    assert probe.flags & Qt.WindowType.WindowSystemMenuHint
    assert probe.flags & Qt.WindowType.WindowCloseButtonHint


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


@pytest.mark.parametrize(
    ("use_audio", "expected"),
    [
        (True, "voice"),
        (False, "no_voice"),
    ],
)
def test_gamepad_confirmation_action_uses_explicit_audio_choice(use_audio, expected):
    calls = []
    probe = SimpleNamespace(
        _on_voice=lambda: calls.append("voice"),
        _on_no_voice=lambda: calls.append("no_voice"),
        _cancel_auto_accept=lambda: calls.append("cancel_timer"),
    )

    anki_confirmation_qt.AnkiConfirmationDialog._apply_gamepad_confirmation_action(
        probe,
        use_audio=use_audio,
    )

    assert calls == ["cancel_timer", expected]


def test_gamepad_capture_registers_a_b_x_and_dpad(monkeypatch):
    registrations = []

    class _DispatcherProbe:
        def __init__(self):
            self.registrations = registrations

        def register(self, button, callback):
            self.registrations.append(button)
            return True

    class _ClientProbe:
        def __init__(self, dispatcher, *, exclusive):
            self.dispatcher = dispatcher
            self.exclusive = exclusive
            self.started = False

        def start(self):
            self.started = True

    monkeypatch.setattr(anki_confirmation_qt, "GamepadHotkeyDispatcher", _DispatcherProbe)
    monkeypatch.setattr(anki_confirmation_qt, "GamepadInputClient", _ClientProbe)
    probe = SimpleNamespace(
        _gamepad_client=None,
        gamepad_button_signal=SimpleNamespace(emit=lambda _button: None),
    )

    anki_confirmation_qt.AnkiConfirmationDialog._start_gamepad_capture(probe)

    assert registrations == [0, 1, 2, 12, 13, 14, 15]
    assert probe._gamepad_capture_active is True
    assert probe._gamepad_client.started is True


def test_gamepad_buttons_map_x_to_audio_b_to_no_audio_and_a_to_focused_component(monkeypatch):
    calls = []

    class _ApplicationProbe:
        @staticmethod
        def activeModalWidget():
            return None

    monkeypatch.setattr(anki_confirmation_qt, "QApplication", _ApplicationProbe)
    probe = SimpleNamespace(
        _gamepad_capture_active=True,
        isVisible=lambda: True,
        _on_voice=lambda: calls.append("voice"),
        _on_no_voice=lambda: calls.append("no_voice"),
        _cancel_auto_accept=lambda: calls.append("cancel_timer"),
        _click_active_component=lambda: calls.append("click"),
    )

    def apply_audio_choice(*, use_audio):
        calls.append("cancel_timer")
        calls.append("voice" if use_audio else "no_voice")

    probe._apply_gamepad_confirmation_action = apply_audio_choice

    anki_confirmation_qt.AnkiConfirmationDialog._on_gamepad_button(probe, 2)
    anki_confirmation_qt.AnkiConfirmationDialog._on_gamepad_button(probe, 1)
    anki_confirmation_qt.AnkiConfirmationDialog._on_gamepad_button(probe, 0)

    assert calls == [
        "cancel_timer",
        "voice",
        "cancel_timer",
        "no_voice",
        "cancel_timer",
        "click",
    ]


def test_click_active_component_invokes_focused_clickable_widget(monkeypatch):
    calls = []
    focused_widget = SimpleNamespace(click=lambda: calls.append("clicked"))

    class _ApplicationProbe:
        @staticmethod
        def focusWidget():
            return focused_widget

    monkeypatch.setattr(anki_confirmation_qt, "QApplication", _ApplicationProbe)
    probe = SimpleNamespace(isAncestorOf=lambda widget: widget is focused_widget)

    anki_confirmation_qt.AnkiConfirmationDialog._click_active_component(probe)

    assert calls == ["clicked"]


def test_apply_exit_choice_cancel_keeps_dialog_open():
    probe = SimpleNamespace(result="existing", _exit_confirmed=False)

    result = anki_confirmation_qt.AnkiConfirmationDialog._apply_exit_choice(
        probe,
        anki_confirmation_qt.EXIT_CHOICE_CANCEL,
    )

    assert result is False
    assert probe.result == "existing"
    assert probe._exit_confirmed is False


def test_apply_exit_choice_ok_discards_update():
    probe = SimpleNamespace(result="existing", _exit_confirmed=False)

    result = anki_confirmation_qt.AnkiConfirmationDialog._apply_exit_choice(
        probe,
        anki_confirmation_qt.EXIT_CHOICE_DISCARD,
    )

    assert result is True
    assert probe.result is None
    assert probe._exit_confirmed is True


def test_apply_exit_choice_delete_card_sets_cancel_action():
    probe = SimpleNamespace(result="existing", _exit_confirmed=False)

    result = anki_confirmation_qt.AnkiConfirmationDialog._apply_exit_choice(
        probe,
        anki_confirmation_qt.EXIT_CHOICE_DELETE_CARD,
    )

    assert result is True
    assert probe.result == {
        anki_confirmation_qt.CONFIRMATION_CANCEL_ACTION_KEY: anki_confirmation_qt.CONFIRMATION_CANCEL_ACTION_DELETE_CARD
    }
    assert probe._exit_confirmed is True


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


def test_calculate_audio_keep_ranges_removes_multiple_middle_cuts():
    result = anki_confirmation_qt.AnkiConfirmationDialog._calculate_audio_keep_ranges(
        1.0,
        9.0,
        [(5.0, 6.0), (2.0, 3.0)],
    )

    assert result == [(1.0, 2.0), (3.0, 5.0), (6.0, 9.0)]


def test_preview_audio_data_omits_cut_samples():
    data = np.arange(20)

    result = anki_confirmation_qt.AnkiConfirmationDialog._build_audio_preview_data(
        data,
        samplerate=2,
        start_position=1.0,
        cut_ranges=[(2.0, 3.0), (5.0, 6.0)],
    )

    assert result.tolist() == [2, 3, 6, 7, 8, 9, 12, 13, 14, 15, 16, 17, 18, 19]


def test_preview_elapsed_time_maps_back_across_removed_audio():
    cuts = [(2.0, 3.0), (5.0, 6.0)]

    assert anki_confirmation_qt.AnkiConfirmationDialog._source_position_for_preview_elapsed(
        1.0, 0.5, cuts
    ) == pytest.approx(1.5)
    assert anki_confirmation_qt.AnkiConfirmationDialog._source_position_for_preview_elapsed(
        1.0, 1.0, cuts
    ) == pytest.approx(3.0)
    assert anki_confirmation_qt.AnkiConfirmationDialog._source_position_for_preview_elapsed(
        1.0, 3.0, cuts
    ) == pytest.approx(6.0)


def test_seek_while_idle_moves_cursor_without_starting_playback():
    calls = []
    probe = SimpleNamespace(
        audio_player=SimpleNamespace(
            is_playing=False,
            stop_audio=lambda: calls.append(("stop",)),
        ),
        playback_timer=SimpleNamespace(stop=lambda: calls.append(("timer_stop",))),
        waveform_widget=SimpleNamespace(
            end_time=9.0,
            get_selection_range=lambda: (1.0, 9.0),
            get_cut_ranges=lambda: [(4.0, 5.0)],
            set_playback_position=lambda position: calls.append(("cursor", position)),
        ),
        _cancel_auto_accept=lambda: calls.append(("cancel_auto_accept",)),
        _normalize_audio_seek_position=lambda position: position,
        _update_audio_buttons=lambda: calls.append(("buttons",)),
        _start_range_playback=lambda position: calls.append(("play", position)),
        _playback_resume_position=None,
        _playing_full_audio=False,
    )

    anki_confirmation_qt.AnkiConfirmationDialog._seek_audio(probe, 3.25)

    assert probe._playback_resume_position == 3.25
    assert ("cursor", 3.25) in calls
    assert not any(call[0] == "stop" for call in calls)
    assert not any(call[0] == "play" for call in calls)


def test_seek_while_playing_restarts_preview_at_requested_position():
    calls = []
    probe = SimpleNamespace(
        audio_player=SimpleNamespace(
            is_playing=True,
            stop_audio=lambda: calls.append(("stop",)),
        ),
        playback_timer=SimpleNamespace(stop=lambda: calls.append(("timer_stop",))),
        waveform_widget=SimpleNamespace(
            end_time=9.0,
            set_playback_position=lambda position: calls.append(("cursor", position)),
        ),
        _cancel_auto_accept=lambda: calls.append(("cancel_auto_accept",)),
        _normalize_audio_seek_position=lambda position: position,
        _update_audio_buttons=lambda: calls.append(("buttons",)),
        _start_range_playback=lambda position: calls.append(("play", position)),
        _playback_resume_position=None,
        _playing_full_audio=False,
    )

    anki_confirmation_qt.AnkiConfirmationDialog._seek_audio(probe, 6.5)

    assert ("stop",) in calls
    assert ("timer_stop",) in calls
    assert ("play", 6.5) in calls


def test_play_range_restarts_from_selection_start_when_cursor_is_near_end():
    starts = []
    probe = SimpleNamespace(
        audio_player=SimpleNamespace(is_playing=False),
        waveform_widget=SimpleNamespace(get_selection_range=lambda: (1.0, 5.0)),
        _playback_resume_position=4.995,
        _start_range_playback=starts.append,
    )

    anki_confirmation_qt.AnkiConfirmationDialog._play_range(probe)

    assert starts == [1.0]


def test_stopped_playback_timer_resets_near_end_cursor_to_selection_start():
    calls = []
    probe = SimpleNamespace(
        audio_player=SimpleNamespace(is_playing=False),
        playback_timer=SimpleNamespace(stop=lambda: calls.append(("timer_stop",))),
        waveform_widget=SimpleNamespace(
            start_time=1.0,
            end_time=5.0,
            set_playback_position=lambda position: calls.append(("cursor", position)),
        ),
        _playback_resume_position=4.995,
        _update_audio_buttons=lambda: calls.append(("buttons",)),
    )

    anki_confirmation_qt.AnkiConfirmationDialog._update_playback_cursor(probe)

    assert probe._playback_resume_position == 1.0
    assert ("cursor", 1.0) in calls


def test_save_trimmed_audio_splices_around_middle_cuts(monkeypatch):
    splice_calls = []
    monkeypatch.setattr(anki_confirmation_qt, "make_unique_file_name", lambda path: path)
    monkeypatch.setattr(anki_confirmation_qt, "get_temporary_directory", lambda: "temp")
    monkeypatch.setattr(
        anki_confirmation_qt,
        "splice_audio",
        lambda **kwargs: splice_calls.append(kwargs),
    )
    monkeypatch.setattr(anki_confirmation_qt.gsm_state, "current_game", "Game")

    probe = SimpleNamespace(
        waveform_widget=SimpleNamespace(
            audio_data=np.arange(10),
            duration=10.0,
            get_selection_range=lambda: (1.0, 9.0),
            get_cut_ranges=lambda: [(2.0, 3.0), (5.0, 6.0)],
        ),
        audio_path="source.opus",
        _sync_audio_edit_selection_to_current_clip=lambda _start, _end: None,
        _calculate_audio_keep_ranges=anki_confirmation_qt.AnkiConfirmationDialog._calculate_audio_keep_ranges,
    )

    result = anki_confirmation_qt.AnkiConfirmationDialog._save_trimmed_audio(probe)

    assert anki_confirmation_qt.os.path.basename(result).startswith("Game_trimmed_")
    assert result.endswith(".opus")
    assert splice_calls == [
        {
            "input_audio": "source.opus",
            "output_audio": result,
            "keep_ranges": [(1.0, 2.0), (3.0, 5.0), (6.0, 9.0)],
            "fade_duration": 0.05,
        }
    ]


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


def test_refresh_audio_controls_shows_reused_audio_without_waveform():
    calls = []
    probe = SimpleNamespace(
        reusing_audio=True,
        audio_player=SimpleNamespace(audio_available=True),
        audio_status_label=_WidgetProbe(),
        codec_info_label=_WidgetProbe(),
        waveform_widget=_WidgetProbe(),
        audio_button=_WidgetProbe(),
        play_original_button=_WidgetProbe(),
        reset_audio_button=_WidgetProbe(),
        tts_button=_WidgetProbe(),
        tts_status_label=_WidgetProbe(),
        voice_button=_WidgetProbe(),
        no_voice_button=_WidgetProbe(),
        confirm_button=_WidgetProbe(),
        _update_audio_expand_buttons=lambda **kwargs: calls.append(kwargs),
    )

    anki_confirmation_qt.AnkiConfirmationDialog._refresh_audio_controls(probe, "sentence")

    assert probe.audio_status_label.text == "Reusing audio from the previous mining operation."
    assert probe.waveform_widget.visible is False
    assert probe.audio_button.visible is False
    assert probe.voice_button.visible is False
    assert probe.no_voice_button.visible is False
    assert probe.confirm_button.visible is True
    assert calls == [{"allow_buttons": False}]


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


def test_build_dialog_result_metadata_includes_audio_edit_range():
    selected_lines = [SimpleNamespace(id="line-1")]
    probe = SimpleNamespace(
        _selected_lines_for_pipeline=lambda: selected_lines,
        _dialog_line_selection_changed=False,
        _dialog_audio_result=None,
        _dialog_translation_regenerated=False,
        _audio_edit_range=(10.25, 12.75),
    )

    result = anki_confirmation_qt.AnkiConfirmationDialog._build_dialog_result_metadata(probe)

    assert result["audio_edit_range"] == (10.25, 12.75)


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


def test_handle_moved_does_not_schedule_dialogue_line_expansion():
    calls = []
    probe = SimpleNamespace(
        _sync_audio_edit_selection_to_current_clip=lambda start, end: calls.append(("sync", start, end)),
        _update_audio_expand_buttons=lambda: calls.append(("update_expand_buttons",)),
        _schedule_auto_line_expand=lambda which: calls.append(("schedule_auto_line_expand", which)),
        audio_player=SimpleNamespace(stop_audio=lambda: calls.append(("stop_audio",))),
        waveform_widget=SimpleNamespace(
            set_playback_position=lambda position: calls.append(("set_playback_position", position))
        ),
        _force_autoplay=False,
        _trim_autoplay_timer=SimpleNamespace(start=lambda: calls.append(("start_autoplay_timer",))),
        autoplay_checkbox=SimpleNamespace(isChecked=lambda: True),
    )

    anki_confirmation_qt.AnkiConfirmationDialog._on_handle_moved(probe, "start", 1.25, 3.5)
    anki_confirmation_qt.AnkiConfirmationDialog._on_handle_moved(probe, "end", 1.25, 3.75)

    assert ("schedule_auto_line_expand", "start") not in calls
    assert ("schedule_auto_line_expand", "end") not in calls
    assert ("sync", 1.25, 3.5) in calls
    assert ("sync", 1.25, 3.75) in calls
    assert ("update_expand_buttons",) in calls
    assert ("stop_audio",) in calls
    assert ("set_playback_position", 1.25) in calls
    assert ("start_autoplay_timer",) in calls
    assert probe._force_autoplay is True


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


def test_next_dialogue_line_exposes_line_arriving_after_mine():
    future_line = SimpleNamespace(id="future-line")
    selected_line = SimpleNamespace(next=future_line, next_line=lambda: None)
    probe = SimpleNamespace(_dialog_selected_lines=[selected_line])

    assert anki_confirmation_qt.AnkiConfirmationDialog._next_dialogue_line(probe) is future_line


def test_next_line_control_stays_visible_and_disabled_while_waiting():
    title = _WidgetProbe()
    previous_button = _WidgetProbe()
    next_button = _WidgetProbe()
    regenerate = _WidgetProbe()
    status = _WidgetProbe()
    probe = SimpleNamespace(
        translation_text=SimpleNamespace(toPlainText=lambda: ""),
        _dialogue_line_expansion_enabled=lambda: True,
        _previous_dialogue_line=lambda: None,
        _next_dialogue_line=lambda: None,
        _dialog_selected_lines=[SimpleNamespace(id="mined")],
        _dialog_line_selection_changed=False,
        _dialogue_replay_future=None,
        dialogue_tools_title=title,
        add_prev_line_button=previous_button,
        add_next_line_button=next_button,
        regen_translation_checkbox=regenerate,
        dialogue_tools_status=status,
        _refresh_dialogue_timeline=lambda: None,
    )

    anki_confirmation_qt.AnkiConfirmationDialog._update_dialogue_line_controls(probe)

    assert next_button.visible is True
    assert next_button.enabled is False
    assert "Waiting" in next_button.tooltip


def test_dialogue_timeline_shows_previous_selected_and_next_lines():
    timeline = _WidgetProbe()
    previous_line = SimpleNamespace(id="previous", text="Previous text")
    mined_line = SimpleNamespace(id="mined", text="Mined text")
    next_line = SimpleNamespace(id="next", text="Next text")
    probe = SimpleNamespace(
        _dialogue_line_expansion_enabled=lambda: True,
        dialogue_timeline=timeline,
        _previous_dialogue_line=lambda: previous_line,
        _next_dialogue_line=lambda: next_line,
        _dialog_selected_lines=[mined_line],
        _replay_context=SimpleNamespace(mined_line=mined_line),
        _timeline_line_text=anki_confirmation_qt.AnkiConfirmationDialog._timeline_line_text,
    )

    anki_confirmation_qt.AnkiConfirmationDialog._refresh_dialogue_timeline(probe)

    assert timeline.visible is True
    assert "Previous text" in timeline.text
    assert "Mined text" in timeline.text
    assert "Next text" in timeline.text


def test_future_next_line_requests_a_new_replay_before_updating_dialogue(monkeypatch):
    mined_at = datetime(2026, 8, 2, 12, 0, 0)
    future_line = SimpleNamespace(id="future", time=mined_at + timedelta(seconds=1))
    mined_line = SimpleNamespace(id="mined", time=mined_at, next=future_line)
    requested = []
    future = SimpleNamespace(done=lambda: False)
    monkeypatch.setattr(
        anki_confirmation_qt,
        "request_dialogue_replay_refresh",
        lambda **kwargs: requested.append(kwargs) or future,
    )
    probe = SimpleNamespace(
        _dialog_selected_lines=[mined_line],
        _next_dialogue_line=lambda: future_line,
        _selection_requires_fresh_replay=lambda lines: True,
        _build_dialogue_sentence=lambda lines: "mined future",
        _replay_context=SimpleNamespace(mined_line=mined_line, timing_context=None),
        _dialogue_replay_future=None,
        _dialogue_replay_selected_lines=None,
        _dialogue_replay_poll_timer=SimpleNamespace(start=lambda: requested.append("poll")),
        _update_dialogue_line_controls=lambda: requested.append("controls"),
        _apply_dialogue_line_change=lambda lines: requested.append(("apply", lines)),
    )
    probe._start_dialogue_replay_refresh = lambda lines: (
        anki_confirmation_qt.AnkiConfirmationDialog._start_dialogue_replay_refresh(probe, lines)
    )

    anki_confirmation_qt.AnkiConfirmationDialog._add_next_dialogue_line(probe)

    assert requested[0]["selected_lines"] == [mined_line, future_line]
    assert requested[0]["full_text"] == "mined future"
    assert probe._dialogue_replay_future is future
    assert "poll" in requested
    assert not any(isinstance(call, tuple) and call[0] == "apply" for call in requested)
