"""Opt-in, session-only audio corpus recording for the Development menu."""

import hashlib
import json
import shutil
import threading
import time
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import asdict, is_dataclass
from datetime import UTC, datetime
from functools import lru_cache
from importlib import metadata
from pathlib import Path

from GameSentenceMiner.util.data_directory import get_app_directory

VAD_DEBUG_TOPIC = "dev.vad_debug"
_current_capture = ContextVar("vad_debug_capture", default=None)


def current_capture():
    return _current_capture.get()


def _json_default(value):
    if is_dataclass(value):
        return asdict(value)
    return str(value)


def _file_info(path):
    with path.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    return {"file": path.name, "bytes": path.stat().st_size, "sha256": digest}


@lru_cache(maxsize=4)
def asset_sha256(path):
    return _file_info(Path(path))["sha256"]


@lru_cache(maxsize=1)
def _versions():
    versions = {}
    for package in ("GameSentenceMiner", "onnxruntime", "onnxruntime-gpu", "kaldi-native-fbank", "faster-whisper"):
        try:
            versions[package] = metadata.version(package)
        except metadata.PackageNotFoundError:
            pass
    return versions


def notify_error(message):
    from GameSentenceMiner.util.communication.electron_ipc import send_message

    send_message("vad_debug_error", {"error": message})


def _settings(config):
    vad = dict(vars(config.vad))
    vad.pop("tts_url", None)
    return {
        "vad": vad,
        "audio": {
            key: getattr(config.audio, key, None)
            for key in ("extension", "beginning_offset", "end_offset", "pre_vad_end_offset", "ffmpeg_reencode_options")
        },
        "language": getattr(config.general, "target_language", None),
    }


class VADDebugCapture:
    def __init__(self, owner, input_audio, config, game_line, text):
        self.owner = owner
        now = datetime.now(UTC)
        self.directory = owner.root / f"{now:%Y%m%dT%H%M%S_%fZ}_{uuid.uuid4().hex[:8]}"
        self.directory.mkdir(parents=True, exist_ok=False)
        self.started = time.perf_counter()
        self.result = None
        self.firered_attempted = False
        self.analysis_only = False
        self.report = {
            "schema": "gsm_vad_debug_v1",
            "recorded_at_utc": now.isoformat(),
            "versions": _versions(),
            "source_filename": Path(input_audio).name,
            "context": {
                "profile": getattr(config, "name", None),
                "text": text,
                "line": {
                    key: getattr(game_line, key, None) for key in ("id", "index", "text", "time", "source", "game_name")
                },
            },
            "settings": _settings(config),
            "audio": {"pre_vad": None, "post_vad": None},
            "attempts": [],
            "firered": None,
            "review": {
                "expected_speech_start_seconds": None,
                "expected_speech_end_seconds": None,
                "verdict": None,
                "notes": "",
            },
        }
        pre = self.directory / f"pre_vad{Path(input_audio).suffix}"
        shutil.copyfile(input_audio, pre)
        self.report["audio"]["pre_vad"] = _file_info(pre)

    def attempt(self, model, detection, decision, result, timings, error=None):
        if model == "FIRERED":
            self.firered_attempted = True
            if self.report["firered"] is None:
                self.report["firered"] = {
                    "analysis_only": False,
                    "segments": [asdict(segment) for segment in detection.segments] if detection else [],
                    "error": error,
                }
        self.report["attempts"].append(
            {
                "model": model,
                "detection": asdict(detection) if detection is not None else None,
                "decision": decision,
                "result": vars(result) if result is not None else None,
                "timings_seconds": timings,
                "error": error,
            }
        )

    def finish(self):
        result = self.result
        if result is not None:
            self.report["result"] = dict(vars(result))
            output = getattr(result, "output_audio", None)
            if result.success and output and Path(output).is_file():
                post = self.directory / f"post_vad{Path(output).suffix}"
                shutil.copyfile(output, post)
                self.report["audio"]["post_vad"] = _file_info(post)
        self.report["elapsed_seconds"] = time.perf_counter() - self.started
        with (self.directory / "result.json").open("x", encoding="utf-8") as stream:
            json.dump(self.report, stream, ensure_ascii=False, indent=2, default=_json_default, allow_nan=False)
            stream.write("\n")


class VADDebugRecorder:
    def __init__(self, root=None):
        self.root = Path(root) if root is not None else Path(get_app_directory()) / "vad-debug"
        self._lock = threading.RLock()
        self._enabled = False
        self._error = ""

    @property
    def enabled(self):
        with self._lock:
            return self._enabled

    def status(self):
        with self._lock:
            return {"enabled": self._enabled, "directory": str(self.root), "error": self._error}

    def set_enabled(self, enabled):
        with self._lock:
            if enabled:
                self.root.mkdir(parents=True, exist_ok=True)
                self._error = ""
            self._enabled = enabled
            return self.status()

    def fail(self, error):
        from GameSentenceMiner.util.config.configuration import logger

        with self._lock:
            first_error = not self._error
            self._enabled = False
            self._error = str(error)
        logger.warning(f"VAD debug recording stopped: {error}")
        if first_error:
            try:
                notify_error(str(error))
            except Exception:  # noqa: BLE001 - Debug reporting must never interrupt mining.
                logger.exception("Could not notify Electron about the VAD debug error")

    @contextmanager
    def capture(self, input_audio, config, game_line, text):
        capture = None
        if self.enabled:
            try:
                capture = VADDebugCapture(self, input_audio, config, game_line, text)
            except Exception as error:  # noqa: BLE001 - Audio processing must survive diagnostic failures.
                self.fail(error)
        token = _current_capture.set(capture)
        try:
            yield capture
        except Exception as error:
            if capture:
                capture.report["pipeline_error"] = str(error)
            raise
        finally:
            _current_capture.reset(token)
            if capture:
                try:
                    capture.finish()
                except Exception as error:  # noqa: BLE001 - Preserve the actual mining result.
                    self.fail(error)


def record_firered(wav_path, duration, processor, probabilities, decisions, segments):
    capture = current_capture()
    if capture is None:
        return
    try:
        from GameSentenceMiner.vad import FIRERED_FRAME_LENGTH_S, FIRERED_FRAME_SHIFT_S, _get_firered_asset_path

        destination = capture.directory / "firered_input.wav"
        shutil.copyfile(wav_path, destination)
        postprocessor = processor._postprocessor
        smoothed = postprocessor._smooth_prob(probabilities) if len(probabilities) else []
        capture.report["audio"]["firered_input"] = _file_info(destination)
        capture.report["firered"] = {
            "analysis_only": capture.analysis_only,
            "preprocessing": {"sample_rate_hz": 16000, "channels": 1, "sample_width_bits": 16, "filters": []},
            "duration_seconds": duration,
            "frame_shift_seconds": FIRERED_FRAME_SHIFT_S,
            "frame_length_seconds": FIRERED_FRAME_LENGTH_S,
            "frame_count": len(probabilities),
            "raw_probabilities": list(map(float, probabilities)),
            "smoothed_probabilities": list(map(float, smoothed)),
            "thresholded_frames": postprocessor._apply_threshold(smoothed),
            "decisions": decisions,
            "segments": [asdict(segment) for segment in segments],
            "reaches_clip_end": bool(segments and duration - segments[-1].end <= FIRERED_FRAME_LENGTH_S),
            "postprocessor": dict(vars(postprocessor)),
            "providers": processor.vad_model.get_providers(),
            "model_sha256": asset_sha256(_get_firered_asset_path("fireredvad_vad.onnx")),
            "cmvn_sha256": asset_sha256(_get_firered_asset_path("cmvn.ark")),
        }
    except Exception as error:  # noqa: BLE001 - Diagnostics cannot change a detection result.
        capture.owner.fail(error)


recorder = VADDebugRecorder()


def handle_debug_request(message):
    from GameSentenceMiner.util.config import configuration

    if not configuration.is_dev:
        raise PermissionError("VAD debugging is only available in development builds")
    payload = message.get("data") or {}
    if not isinstance(payload, dict):
        raise TypeError("VAD debug request must be an object")
    if "enabled" not in payload:
        return recorder.status()
    if not isinstance(payload["enabled"], bool):
        raise TypeError("enabled must be a boolean")
    return recorder.set_enabled(payload["enabled"])
