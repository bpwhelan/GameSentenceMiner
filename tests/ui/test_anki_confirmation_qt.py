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
    }


def test_audio_expand_seconds_shared_between_dialog_and_waveform_labels():
    assert audio_waveform_widget.AUDIO_EXPAND_SECONDS == 0.25
    assert anki_confirmation_qt.AUDIO_EXPAND_SECONDS == audio_waveform_widget.AUDIO_EXPAND_SECONDS
    assert audio_waveform_widget.EXPAND_BUTTON_SECONDS_TEXT == "0.25s"
