import datetime
import os
import shutil
import threading
from typing import Callable, Optional

from GameSentenceMiner.util.config.configuration import get_config, gsm_state
from GameSentenceMiner.util.gsm_utils import (
    make_unique_file_name,
    make_unique_temp_file,
    sanitize_filename,
)
from GameSentenceMiner.util.text_log import get_all_lines


class LongPlayHandler:
    """Owns longplay recording/SRT state and OBS-event-driven lifecycle."""

    def __init__(
        self,
        feature_enabled_getter: Optional[Callable[[], bool]] = None,
        game_name_getter: Optional[Callable[[], str]] = None,
    ):
        self._feature_enabled_getter = feature_enabled_getter or self._default_feature_enabled
        self._game_name_getter = game_name_getter or (lambda: "longplay")
        self._lock = threading.RLock()
        self._record_active = bool(gsm_state.recording_started_time)

    def add_srt_line(self, line_time, new_line):
        prev_line = getattr(new_line, "prev", None)
        if not prev_line or not self._is_enabled():
            return

        with self._lock:
            if not self._record_active and not gsm_state.recording_started_time:
                return

            self._begin_session_locked(start_time=datetime.datetime.now(), preserve_existing=True)
            self._ensure_srt_path_locked()
            if not gsm_state.current_srt:
                return

            self._write_srt_line_locked(line_time=line_time, previous_line=prev_line)

    def on_record_start_requested(self):
        if not self._is_enabled():
            return

        with self._lock:
            self._record_active = True
            self._begin_session_locked(start_time=datetime.datetime.now(), preserve_existing=True)

    def on_record_state_changed(self, output_active: Optional[bool], output_path: Optional[str] = None):
        if output_active is None:
            return

        with self._lock:
            if output_active:
                if not self._is_enabled():
                    return
                self._record_active = True
                self._begin_session_locked(start_time=datetime.datetime.now(), preserve_existing=True)
                if output_path:
                    self._set_recording_path_locked(output_path)
                return

            self._finalize_locked(
                end_time=datetime.datetime.now(),
                output_path=output_path,
                reset=True,
            )

    def on_record_file_changed(self, new_output_path: Optional[str]):
        if not new_output_path or not self._is_enabled():
            return

        with self._lock:
            now = datetime.datetime.now()
            new_norm = self._normalize_path(new_output_path)
            current_recording = gsm_state.current_recording
            current_norm = self._normalize_path(current_recording)

            if self._record_active and current_norm and current_norm != new_norm:
                self._finalize_locked(end_time=now, output_path=current_recording, reset=True)
                self._record_active = True
                self._begin_session_locked(start_time=now, preserve_existing=False)
            else:
                self._record_active = True
                self._begin_session_locked(start_time=now, preserve_existing=True)

            self._set_recording_path_locked(new_output_path)

    def on_record_stop_response(self, output_path: Optional[str] = None):
        with self._lock:
            if not self._record_active and not gsm_state.recording_started_time and not gsm_state.current_srt:
                return

            self._finalize_locked(
                end_time=datetime.datetime.now(),
                output_path=output_path,
                reset=True,
            )

    def reset_state(self):
        with self._lock:
            self._record_active = False
            gsm_state.recording_started_time = None
            gsm_state.current_srt = None
            gsm_state.current_recording = None
            gsm_state.srt_index = 1

    def _begin_session_locked(self, start_time: datetime.datetime, preserve_existing: bool):
        if not preserve_existing or gsm_state.recording_started_time is None:
            gsm_state.recording_started_time = start_time

        if not preserve_existing or not isinstance(gsm_state.srt_index, int) or gsm_state.srt_index < 1:
            gsm_state.srt_index = 1

    def _ensure_srt_path_locked(self):
        if gsm_state.current_srt:
            return

        if gsm_state.current_recording:
            gsm_state.current_srt = self._build_srt_path(gsm_state.current_recording)
            return

        game_name = self._safe_game_name()
        gsm_state.current_srt = make_unique_temp_file(f"{game_name}.srt")

    def _set_recording_path_locked(self, recording_path: str):
        if not recording_path:
            return

        recording_path = os.path.normpath(str(recording_path))
        target_srt_path = self._build_srt_path(recording_path)
        current_srt = gsm_state.current_srt

        if current_srt and self._normalize_path(current_srt) != self._normalize_path(target_srt_path):
            moved_target = target_srt_path
            if os.path.exists(current_srt):
                if os.path.exists(moved_target):
                    moved_target = make_unique_file_name(moved_target)
                target_dir = os.path.dirname(moved_target)
                if target_dir:
                    os.makedirs(target_dir, exist_ok=True)
                shutil.move(current_srt, moved_target)
            target_srt_path = moved_target

        gsm_state.current_recording = recording_path
        gsm_state.current_srt = target_srt_path

    def _finalize_locked(
        self,
        end_time: datetime.datetime,
        output_path: Optional[str],
        reset: bool,
    ):
        if output_path:
            self._set_recording_path_locked(output_path)

        self._append_last_line_locked(end_time)

        if reset:
            self._record_active = False
            gsm_state.recording_started_time = None
            gsm_state.current_srt = None
            gsm_state.current_recording = None
            gsm_state.srt_index = 1

    def _append_last_line_locked(self, end_time: datetime.datetime):
        if not gsm_state.current_srt or not gsm_state.recording_started_time:
            return

        lines = get_all_lines()
        if not lines:
            return

        last_line = lines[-1]
        prev_line = getattr(last_line, "prev", None)
        if not prev_line:
            return

        self._write_srt_line_locked(line_time=end_time, previous_line=prev_line)

    def _write_srt_line_locked(self, line_time, previous_line):
        try:
            prev_start_time = previous_line.time - gsm_state.recording_started_time
            prev_end_time = (line_time if line_time else datetime.datetime.now()) - gsm_state.recording_started_time
        except Exception:
            return

        if prev_end_time.total_seconds() < prev_start_time.total_seconds():
            return

        srt_path = gsm_state.current_srt
        if not srt_path:
            return

        target_dir = os.path.dirname(srt_path)
        if target_dir:
            os.makedirs(target_dir, exist_ok=True)

        with open(srt_path, "a", encoding="utf-8") as srt_file:
            srt_file.write(f"{gsm_state.srt_index}\n")
            srt_file.write(
                f"{self._format_srt_time(prev_start_time)} --> "
                f"{self._format_srt_time(prev_end_time, offset=-1)}\n"
            )
            srt_file.write(f"{previous_line.text}\n\n")
            gsm_state.srt_index += 1

    def _safe_game_name(self) -> str:
        raw_name = ""
        try:
            raw_name = str(self._game_name_getter() or "")
        except Exception:
            raw_name = ""
        safe_name = sanitize_filename(raw_name.strip()) if raw_name else ""
        return safe_name or "longplay"

    def _default_feature_enabled(self) -> bool:
        try:
            return bool(get_config().features.generate_longplay)
        except Exception:
            return False

    def _is_enabled(self) -> bool:
        try:
            return bool(self._feature_enabled_getter())
        except Exception:
            return False

    @staticmethod
    def _build_srt_path(recording_path: str) -> str:
        base_path, _ = os.path.splitext(str(recording_path))
        return f"{base_path}.srt"

    @staticmethod
    def _normalize_path(path: Optional[str]) -> str:
        if not path:
            return ""
        return os.path.normcase(os.path.normpath(str(path)))

    @staticmethod
    def _format_srt_time(delta: datetime.timedelta, offset: int = 0) -> str:
        total_seconds = int(delta.total_seconds()) + offset
        if total_seconds < 0:
            total_seconds = 0
        hours = total_seconds // 3600
        minutes = (total_seconds % 3600) // 60
        seconds = total_seconds % 60
        milliseconds = int(delta.microseconds / 1000)
        return f"{hours:02}:{minutes:02}:{seconds:02},{milliseconds:03}"
