"""Windows-only active-window speech recognition proof of concept.

The native helpers deliberately communicate over plain pipes:

    process-loopback PCM -> speech recognizer -> JSON lines

Keeping the process orchestration here makes the audio and recognizer pieces
replaceable without coupling either one to GSM's asyncio runtime.
"""

from __future__ import annotations

import ctypes
import json
import logging
import os
import queue
import shutil
import stat
import subprocess
import sys
import threading
import time
import urllib.request
import uuid
import zipfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any, Protocol

logger = logging.getLogger(__name__)

WINDOWS_SPEECH_BACKENDS = {"embedded", "sapi"}
DEFAULT_RUNTIME_PATH = Path(r"C:\Windows\SystemApps\MicrosoftWindows.Client.Core_cw5n1h2txyewy\LiveCaptions")
DIRECT_LIVE_CAPTIONS_URL = "https://r2.gamesentenceminer.com/DirectLiveCaptions.zip"
DIRECT_LIVE_CAPTIONS_URL_ENV = "GSM_WINDOWS_SPEECH_BUNDLE_URL"
DIRECT_LIVE_CAPTIONS_CACHE_ENV = "GSM_WINDOWS_SPEECH_CACHE_DIR"
DIRECT_LIVE_CAPTIONS_ROOT_NAME = "DirectLiveCaptions"
DIRECT_LIVE_CAPTIONS_ARCHIVE_NAME = f"{DIRECT_LIVE_CAPTIONS_ROOT_NAME}.zip"
DIRECT_LIVE_CAPTIONS_MAX_ARCHIVE_BYTES = 1 * 1024 * 1024 * 1024
DIRECT_LIVE_CAPTIONS_MAX_EXTRACTED_BYTES = 2 * 1024 * 1024 * 1024
DIRECT_LIVE_CAPTIONS_MAX_ENTRIES = 4096

_DIRECT_LIVE_CAPTIONS_LOCK = threading.Lock()


@dataclass(frozen=True)
class ForegroundWindow:
    hwnd: int
    pid: int
    title: str = ""
    process_name: str = ""
    process_path: str = ""


@dataclass(frozen=True)
class SpeechRecognitionEvent:
    text: str
    final: bool
    offset: int | None = None
    duration: int | None = None
    raw: dict[str, Any] | None = None


class ProcessLike(Protocol):
    stdout: Any
    stderr: Any
    stdin: Any

    def poll(self) -> int | None: ...

    def terminate(self) -> Any: ...

    def kill(self) -> Any: ...

    def wait(self, timeout: float | None = None) -> Any: ...


def parse_speech_event(line: str | bytes) -> SpeechRecognitionEvent | None:
    """Parse one native-helper JSON line, ignoring status and malformed lines."""

    try:
        if isinstance(line, bytes):
            line = line.decode("utf-8", errors="replace")
        payload = json.loads(line)
    except (TypeError, ValueError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict) or payload.get("type") != "recognition":
        return None
    text = str(payload.get("text") or "").strip()
    if not text:
        return None
    return SpeechRecognitionEvent(
        text=text,
        final=bool(payload.get("final", False)),
        offset=_optional_int(payload.get("offset")),
        duration=_optional_int(payload.get("duration")),
        raw=payload,
    )


def _optional_int(value: Any) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _window_from_hwnd(hwnd: int | None) -> ForegroundWindow | None:
    """Resolve a concrete HWND into the metadata used by the speech pipeline."""

    if sys.platform != "win32":
        return None
    try:
        hwnd = int(hwnd or 0)
        if not hwnd:
            return None

        user32 = ctypes.windll.user32
        if hasattr(user32, "IsWindow") and not user32.IsWindow(hwnd):
            return None

        pid = ctypes.c_ulong(0)
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if not pid.value:
            return None

        title = ""
        title_length = int(user32.GetWindowTextLengthW(hwnd))
        if title_length:
            title_buffer = ctypes.create_unicode_buffer(title_length + 1)
            user32.GetWindowTextW(hwnd, title_buffer, len(title_buffer))
            title = title_buffer.value

        process_name = ""
        process_path = ""
        try:
            import psutil

            process = psutil.Process(pid.value)
            process_name = process.name()
            process_path = process.exe()
        except Exception:
            # Process metadata is useful context, but should never prevent
            # capture when a protected process denies access to its details.
            logger.debug("Could not query process metadata", exc_info=True)
        return ForegroundWindow(hwnd, int(pid.value), title, process_name, process_path)
    except Exception:
        logger.debug("Could not query window HWND %s", hwnd, exc_info=True)
        return None


def get_foreground_window() -> ForegroundWindow | None:
    """Return the current foreground HWND and its owning process on Windows.

    This remains available for diagnostics and explicit callers. Speech
    recognition does not use it by default; it uses :func:`get_target_window`.
    """

    if sys.platform != "win32":
        return None
    try:
        return _window_from_hwnd(int(ctypes.windll.user32.GetForegroundWindow()))
    except Exception:
        logger.debug("Could not query the foreground window", exc_info=True)
        return None


def _get_window_state_target_hwnd() -> int | None:
    """Read GSM's already-resolved target HWND without changing focus."""

    try:
        from GameSentenceMiner.util.platform.window_state_monitor import get_window_state_monitor

        monitor = get_window_state_monitor()
        hwnd = getattr(monitor, "target_hwnd", None) if monitor is not None else None
        return int(hwnd) if hwnd else None
    except Exception:
        logger.debug("Could not read GSM's target window", exc_info=True)
        return None


def _resolve_obs_target_hwnd() -> int | None:
    """Resolve the current OBS capture window using GSM's existing resolver."""

    try:
        # Reuse the resolver that powers the WGC screenshot backend. It first
        # checks the monitor cache and then matches the current OBS source by
        # title/class/executable, including the same OBS error suppression.
        from GameSentenceMiner.obs.screenshot_capture import screenshot_capture

        hwnd = screenshot_capture._resolve_hwnd("windows-speech-recognition")
        return int(hwnd) if hwnd else None
    except Exception:
        logger.debug("Could not resolve the OBS target window", exc_info=True)
        return None


def get_target_window() -> ForegroundWindow | None:
    """Return only the window currently targeted by GSM/OBS.

    The foreground window is intentionally not used as a fallback. This is
    what keeps the process-loopback capture attached to the game selected by
    OBS/GSM while the user changes focus to another application.
    """

    if sys.platform != "win32":
        return None

    # The window-state monitor is the authoritative GSM target once it has
    # resolved one. The OBS resolver bootstraps the target during startup or
    # when the monitor is not currently running.
    target = _window_from_hwnd(_get_window_state_target_hwnd())
    if target is not None:
        return target
    return _window_from_hwnd(_resolve_obs_target_hwnd())


def normalize_speech_locale(language: str | None) -> str:
    """Map GSM's short language codes to the currently supported Windows models."""

    normalized = str(language or "").strip().lower().replace("_", "-")
    if normalized in {"ja", "ja-jp", "japanese", "1041"} or normalized.startswith("ja-"):
        return "ja-JP"
    if normalized in {"en", "en-us", "english", "1033", ""} or normalized.startswith("en-"):
        return "en-US"
    raise ValueError(f"Windows speech recognition PoC currently supports English and Japanese, not {language!r}.")


def _existing_file(path: str | os.PathLike[str] | None) -> Path | None:
    if not path:
        return None
    candidate = Path(path).expanduser()
    try:
        return candidate if candidate.is_file() else None
    except OSError:
        return None


def _native_root_candidates() -> list[Path]:
    candidates: list[Path] = []
    configured_root = os.environ.get("GSM_NATIVE_HELPER_ROOT", "").strip()
    if configured_root:
        candidates.append(Path(configured_root))

    module_path = Path(__file__).resolve()
    executable_path = Path(sys.executable).resolve()
    candidates.extend(
        [
            module_path.parents[1] / "native",
            Path.cwd() / "native",
            executable_path.parent / "native",
            executable_path.parent.parent / "native",
            executable_path.parent.parent.parent / "native",
        ]
    )

    unique: list[Path] = []
    seen: set[str] = set()
    for candidate in candidates:
        key = os.path.normcase(str(candidate))
        if key not in seen:
            seen.add(key)
            unique.append(candidate)
    return unique


def resolve_native_helper(kind: str, explicit_path: str | None = None, backend: str = "embedded") -> Path | None:
    """Find a helper in the dev checkout, packaged resources, or an override path."""

    if kind == "audio":
        environment_name = "GSM_WINDOWS_AUDIO_HELPER"
        filename = "gsm-windows-audio-capture.exe"
        relative = Path("windows-audio-capture") / "bin" / "x64" / filename
    elif kind == "speech":
        if backend == "sapi":
            environment_name = "GSM_WINDOWS_SAPI_HELPER"
            filename = "gsm-windows-speech-recognition-sapi.exe"
        else:
            environment_name = "GSM_WINDOWS_SPEECH_HELPER"
            filename = "gsm-windows-speech-recognition.exe"
        relative = Path("windows-speech-recognition") / "bin" / "x64" / filename
    else:
        raise ValueError(f"Unknown Windows speech helper kind: {kind!r}")

    explicit = explicit_path or os.environ.get(environment_name, "").strip()
    explicit_candidate = _existing_file(explicit)
    if explicit_candidate:
        return explicit_candidate

    for root in _native_root_candidates():
        candidate = _existing_file(root / relative)
        if candidate:
            return candidate
    return None


def get_windows_speech_cache_dir(cache_dir: str | os.PathLike[str] | None = None) -> Path:
    """Return the writable cache location for the downloaded speech bundle."""

    if cache_dir:
        return Path(cache_dir).expanduser()

    configured_cache = os.environ.get(DIRECT_LIVE_CAPTIONS_CACHE_ENV, "").strip()
    if configured_cache:
        return Path(configured_cache).expanduser()

    data_dir = os.environ.get("GSM_DATA_DIR", "").strip()
    if data_dir:
        return Path(data_dir).expanduser() / "windows-speech"

    appdata = os.environ.get("APPDATA", "").strip() or os.environ.get("LOCALAPPDATA", "").strip()
    if appdata:
        default_app_dir = Path(appdata).expanduser() / "GameSentenceMiner"
        try:
            with (default_app_dir / "data_dir.json").open("r", encoding="utf-8") as pointer:
                pointer_data = json.load(pointer)
                pointed_data_dir = str(
                    pointer_data.get("dataDir", "") if isinstance(pointer_data, dict) else ""
                ).strip()
        except (OSError, TypeError, ValueError):
            pointed_data_dir = ""
        return (Path(pointed_data_dir) if pointed_data_dir else default_app_dir) / "windows-speech"

    if sys.platform == "win32":
        return Path.home() / "AppData" / "Local" / "GameSentenceMiner" / "windows-speech"
    return Path.home() / ".config" / "GameSentenceMiner" / "windows-speech"


def _bundle_root_candidates(root: Path) -> list[Path]:
    candidates = [root / DIRECT_LIVE_CAPTIONS_ROOT_NAME, root]
    unique: list[Path] = []
    seen: set[str] = set()
    for candidate in candidates:
        key = os.path.normcase(str(candidate))
        if key not in seen:
            seen.add(key)
            unique.append(candidate)
    return unique


def _speech_model_package(root: Path, locale: str) -> Path | None:
    prefix = f"MicrosoftWindows.Speech.{locale}.1_".casefold()
    try:
        if (root / "sr.ini").is_file():
            return root
        children = sorted(root.iterdir(), key=lambda child: child.name.casefold())
    except OSError:
        return None
    for child in children:
        try:
            if child.is_dir() and child.name.casefold().startswith(prefix) and (child / "sr.ini").is_file():
                return child
        except OSError:
            continue
    return None


def _speech_runtime_in_root(root: Path) -> Path | None:
    try:
        return root if (root / "Microsoft.CognitiveServices.Speech.core.dll").is_file() else None
    except OSError:
        return None


def _find_cached_speech_model(language: str) -> Path | None:
    locale = normalize_speech_locale(language)
    bases = [get_windows_speech_cache_dir(), Path.cwd(), Path(__file__).resolve().parent]
    seen: set[str] = set()
    for base in bases:
        for root in _bundle_root_candidates(base):
            key = os.path.normcase(str(root))
            if key in seen:
                continue
            seen.add(key)
            model = _speech_model_package(root, locale)
            if model is not None:
                return model
    return None


def _find_cached_speech_runtime() -> Path | None:
    bases = [get_windows_speech_cache_dir(), Path.cwd(), Path(__file__).resolve().parent]
    seen: set[str] = set()
    for base in bases:
        for root in _bundle_root_candidates(base):
            key = os.path.normcase(str(root))
            if key in seen:
                continue
            seen.add(key)
            runtime = _speech_runtime_in_root(root)
            if runtime is not None:
                return runtime
    return None


def _safe_zip_member_path(name: str) -> PurePosixPath:
    normalized = str(name).replace("\\", "/")
    if not normalized or "\x00" in normalized or normalized.startswith("/"):
        raise ValueError(f"Unsafe path in DirectLiveCaptions.zip: {name!r}")
    if PureWindowsPath(normalized).drive:
        raise ValueError(f"Unsafe path in DirectLiveCaptions.zip: {name!r}")
    relative = PurePosixPath(normalized)
    if any(part in {"", ".", ".."} for part in relative.parts):
        raise ValueError(f"Unsafe path in DirectLiveCaptions.zip: {name!r}")
    return relative


def _validate_zip_info(info: zipfile.ZipInfo) -> PurePosixPath:
    relative = _safe_zip_member_path(info.filename)
    mode = (info.external_attr >> 16) & 0xFFFF
    if stat.S_ISLNK(mode):
        raise ValueError(f"Symbolic links are not allowed in DirectLiveCaptions.zip: {info.filename!r}")
    if info.file_size < 0:
        raise ValueError(f"Invalid file size in DirectLiveCaptions.zip: {info.filename!r}")
    return relative


def _is_complete_direct_live_captions_root(root: Path) -> bool:
    if _speech_runtime_in_root(root) is None:
        return False
    for locale in ("en-US", "ja-JP", "zh-CN"):
        model = _speech_model_package(root, locale)
        if model is not None:
            try:
                if (model / "svad.quantized.onnx").is_file():
                    return True
            except OSError:
                pass
    return False


def _locate_complete_direct_live_captions_root(root: Path) -> Path | None:
    for candidate in _bundle_root_candidates(root):
        if _is_complete_direct_live_captions_root(candidate):
            return candidate
    return None


def _report_download_progress(
    progress_callback: Callable[[int, int | None], None] | None,
    downloaded: int,
    total: int | None,
) -> None:
    if progress_callback is None:
        return
    try:
        progress_callback(downloaded, total)
    except Exception:
        logger.debug("Windows speech bundle progress callback failed", exc_info=True)


def _download_direct_live_captions_archive(
    archive_path: Path,
    url: str,
    progress_callback: Callable[[int, int | None], None] | None,
) -> None:
    partial_path = archive_path.with_suffix(archive_path.suffix + ".part")
    logger.info("Downloading Windows speech recognition bundle from %s", url)
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/zip, application/octet-stream",
            "User-Agent": "GameSentenceMiner Windows Speech PoC",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response, partial_path.open("wb") as output:
            raw_total = response.headers.get("Content-Length")
            try:
                total = int(raw_total) if raw_total else None
            except (TypeError, ValueError):
                total = None
            if total is not None and total > DIRECT_LIVE_CAPTIONS_MAX_ARCHIVE_BYTES:
                raise ValueError("The Windows speech bundle is larger than the configured safety limit.")

            downloaded = 0
            _report_download_progress(progress_callback, downloaded, total)
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                downloaded += len(chunk)
                if downloaded > DIRECT_LIVE_CAPTIONS_MAX_ARCHIVE_BYTES:
                    raise ValueError("The Windows speech bundle is larger than the configured safety limit.")
                output.write(chunk)
                _report_download_progress(progress_callback, downloaded, total)
            if total is not None and downloaded != total:
                raise OSError(f"Windows speech bundle download was truncated ({downloaded} of {total} bytes).")
            output.flush()
            os.fsync(output.fileno())
        os.replace(partial_path, archive_path)
    except Exception:
        try:
            partial_path.unlink(missing_ok=True)
        except OSError:
            logger.debug("Could not remove partial Windows speech bundle download", exc_info=True)
        raise


def _extract_direct_live_captions_archive(archive_path: Path, cache_dir: Path) -> Path:
    with zipfile.ZipFile(archive_path) as archive:
        infos = archive.infolist()
        if not infos:
            raise ValueError("The Windows speech bundle archive is empty.")
        if len(infos) > DIRECT_LIVE_CAPTIONS_MAX_ENTRIES:
            raise ValueError("The Windows speech bundle contains too many files.")

        total_uncompressed = 0
        safe_members: list[tuple[zipfile.ZipInfo, PurePosixPath]] = []
        for info in infos:
            relative = _validate_zip_info(info)
            total_uncompressed += info.file_size
            if total_uncompressed > DIRECT_LIVE_CAPTIONS_MAX_EXTRACTED_BYTES:
                raise ValueError("The Windows speech bundle is larger than the configured extraction limit.")
            safe_members.append((info, relative))

        staging = cache_dir / f".{DIRECT_LIVE_CAPTIONS_ROOT_NAME}.staging-{uuid.uuid4().hex}"
        try:
            staging.mkdir(parents=True, exist_ok=False)
            for info, relative in safe_members:
                destination = staging.joinpath(*relative.parts)
                if info.is_dir():
                    destination.mkdir(parents=True, exist_ok=True)
                    continue
                destination.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(info) as source, destination.open("wb") as output:
                    shutil.copyfileobj(source, output, length=1024 * 1024)

            extracted_root = _locate_complete_direct_live_captions_root(staging)
            if extracted_root is None:
                raise ValueError("The Windows speech bundle is missing its runtime or model packages.")

            target = cache_dir / DIRECT_LIVE_CAPTIONS_ROOT_NAME
            if target.exists():
                quarantine = cache_dir / f".{target.name}.invalid-{uuid.uuid4().hex}"
                os.replace(target, quarantine)
            os.replace(extracted_root, target)
            return target
        finally:
            shutil.rmtree(staging, ignore_errors=True)


def ensure_direct_live_captions_bundle(
    cache_dir: str | os.PathLike[str] | None = None,
    *,
    url: str = DIRECT_LIVE_CAPTIONS_URL,
    progress_callback: Callable[[int, int | None], None] | None = None,
) -> Path:
    """Download and atomically extract the direct-call speech bundle on demand."""

    cache_root = get_windows_speech_cache_dir(cache_dir)
    with _DIRECT_LIVE_CAPTIONS_LOCK:
        existing = _locate_complete_direct_live_captions_root(cache_root)
        if existing is not None:
            return existing

        cache_root.mkdir(parents=True, exist_ok=True)
        archive_path = cache_root / DIRECT_LIVE_CAPTIONS_ARCHIVE_NAME
        if archive_path.exists():
            try:
                if archive_path.stat().st_size > DIRECT_LIVE_CAPTIONS_MAX_ARCHIVE_BYTES:
                    raise ValueError("The Windows speech bundle is larger than the configured safety limit.")
                with zipfile.ZipFile(archive_path):
                    pass
            except (OSError, ValueError, zipfile.BadZipFile):
                archive_path.unlink(missing_ok=True)

        if not archive_path.exists():
            _download_direct_live_captions_archive(archive_path, url, progress_callback)

        try:
            result = _extract_direct_live_captions_archive(archive_path, cache_root)
        except (OSError, ValueError, zipfile.BadZipFile):
            archive_path.unlink(missing_ok=True)
            raise
        else:
            # The extracted model set is the cache; retaining another 375 MB zip
            # serves no runtime purpose and makes the first-run disk cost worse.
            archive_path.unlink(missing_ok=True)
            return result


def discover_speech_model(language: str, configured_path: str | None = None) -> Path | None:
    """Locate a MicrosoftWindows.Speech AppX model package without copying it."""

    configured = Path(configured_path).expanduser() if configured_path else None
    if configured:
        if (configured / "sr.ini").is_file():
            return configured
        try:
            locale = normalize_speech_locale(language)
            configured_model = next(
                (
                    model
                    for root in _bundle_root_candidates(configured)
                    if (model := _speech_model_package(root, locale)) is not None
                ),
                None,
            )
        except ValueError:
            configured_model = None
        if configured_model is not None:
            return configured_model

    environment_path = os.environ.get("GSM_WINDOWS_SPEECH_MODEL_PATH", "").strip()
    if environment_path:
        candidate = Path(environment_path).expanduser()
        if (candidate / "sr.ini").is_file():
            return candidate
        locale = normalize_speech_locale(language)
        configured_model = next(
            (
                model
                for root in _bundle_root_candidates(candidate)
                if (model := _speech_model_package(root, locale)) is not None
            ),
            None,
        )
        if configured_model is not None:
            return configured_model

    cached = _find_cached_speech_model(language)
    if cached is not None:
        return cached

    if sys.platform != "win32":
        return None
    locale = normalize_speech_locale(language)
    package_name = f"MicrosoftWindows.Speech.{locale}.1"

    # Get-AppxPackage is the reliable route when WindowsApps directory access
    # is restricted to the package manager service.
    try:
        result = subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                f"(Get-AppxPackage -Name '{package_name}').InstallLocation",
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=5,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        for line in result.stdout.splitlines():
            candidate = Path(line.strip())
            if (candidate / "sr.ini").is_file():
                return candidate
    except (OSError, subprocess.SubprocessError):
        pass

    # This fallback is useful in an elevated/dev shell and costs nothing on
    # systems where WindowsApps is readable.
    try:
        root = Path(r"C:\Program Files\WindowsApps")
        for candidate in root.glob(f"{package_name}_*"):
            if (candidate / "sr.ini").is_file():
                return candidate
    except OSError:
        pass
    return None


def discover_speech_runtime(configured_path: str | None = None) -> Path | None:
    configured = Path(configured_path).expanduser() if configured_path else None
    if configured and (configured / "Microsoft.CognitiveServices.Speech.core.dll").is_file():
        return configured
    if configured:
        for root in _bundle_root_candidates(configured):
            runtime = _speech_runtime_in_root(root)
            if runtime is not None:
                return runtime

    environment_path = os.environ.get("GSM_WINDOWS_SPEECH_RUNTIME_PATH", "").strip()
    if environment_path:
        candidate = Path(environment_path).expanduser()
        if (candidate / "Microsoft.CognitiveServices.Speech.core.dll").is_file():
            return candidate
        for root in _bundle_root_candidates(candidate):
            runtime = _speech_runtime_in_root(root)
            if runtime is not None:
                return runtime

    cached = _find_cached_speech_runtime()
    if cached is not None:
        return cached

    if (DEFAULT_RUNTIME_PATH / "Microsoft.CognitiveServices.Speech.core.dll").is_file():
        return DEFAULT_RUNTIME_PATH
    return None


class _ProcessPair:
    def __init__(
        self,
        audio: ProcessLike,
        speech: ProcessLike,
        generation: int,
        log: logging.Logger,
    ) -> None:
        self.audio = audio
        self.speech = speech
        self.generation = generation
        self.events: queue.Queue[str] = queue.Queue()
        self.stop_event = threading.Event()
        self.utterance_id = 0
        self._log = log
        self._threads: list[threading.Thread] = []
        self._start_pumps()

    def _start_pumps(self) -> None:
        pump = threading.Thread(target=self._pump_audio, name="windows-speech-audio-pump", daemon=True)
        reader = threading.Thread(target=self._read_speech, name="windows-speech-json-reader", daemon=True)
        audio_errors = threading.Thread(
            target=self._read_stderr,
            args=(self.audio.stderr, "audio"),
            name="windows-speech-audio-stderr",
            daemon=True,
        )
        speech_errors = threading.Thread(
            target=self._read_stderr,
            args=(self.speech.stderr, "recognizer"),
            name="windows-speech-recognizer-stderr",
            daemon=True,
        )
        self._threads = [pump, reader, audio_errors, speech_errors]
        for thread in self._threads:
            thread.start()

    def _pump_audio(self) -> None:
        try:
            while not self.stop_event.is_set():
                chunk = self.audio.stdout.read(64 * 1024)
                if not chunk:
                    break
                if self.speech.stdin is None:
                    break
                self.speech.stdin.write(chunk)
                self.speech.stdin.flush()
        except (OSError, ValueError, BrokenPipeError) as exc:
            if not self.stop_event.is_set():
                self._log.debug("Windows speech audio pump stopped: %s", exc)
        finally:
            try:
                if self.speech.stdin is not None:
                    self.speech.stdin.close()
            except (OSError, ValueError):
                pass

    def _read_speech(self) -> None:
        try:
            while not self.stop_event.is_set():
                line = self.speech.stdout.readline()
                if not line:
                    break
                if isinstance(line, bytes):
                    line = line.decode("utf-8", errors="replace")
                self.events.put(str(line))
        except (OSError, ValueError) as exc:
            if not self.stop_event.is_set():
                self._log.debug("Windows speech JSON reader stopped: %s", exc)

    def _read_stderr(self, stream: Any, name: str) -> None:
        if stream is None:
            return
        try:
            for line in iter(stream.readline, b""):
                if self.stop_event.is_set():
                    break
                if isinstance(line, bytes):
                    line = line.decode("utf-8", errors="replace")
                message = str(line).strip()
                if message:
                    self._log.debug("Windows speech %s helper: %s", name, message)
        except (OSError, ValueError):
            pass

    def stop(self) -> None:
        self.stop_event.set()
        # Closing stdin tells the recognizer to finish; terminating the audio
        # producer also unblocks the pump if it is waiting on a pipe read.
        for process in (self.audio, self.speech):
            try:
                process.terminate()
            except (AttributeError, OSError, subprocess.SubprocessError, ValueError) as exc:
                self._log.debug("Could not terminate Windows speech helper: %s", exc)
        for process in (self.audio, self.speech):
            try:
                process.wait(timeout=1)
            except (AttributeError, OSError, subprocess.SubprocessError, ValueError):
                try:
                    process.kill()
                except (AttributeError, OSError, subprocess.SubprocessError, ValueError) as exc:
                    self._log.debug("Could not kill Windows speech helper: %s", exc)
        for stream in (self.audio.stdout, self.audio.stderr, self.speech.stdout, self.speech.stderr):
            try:
                stream.close()
            except (AttributeError, OSError, ValueError):
                pass
        for thread in self._threads:
            if thread is not threading.current_thread():
                thread.join(timeout=0.25)


class WindowsSpeechRecognitionService:
    """Capture only the GSM/OBS-targeted process and forward recognition events."""

    def __init__(
        self,
        on_text: Callable[[SpeechRecognitionEvent, ForegroundWindow, str], None],
        *,
        language: str = "ja-JP",
        backend: str = "embedded",
        model_path: str = "",
        runtime_path: str = "",
        license_file: str = "",
        audio_helper: str = "",
        speech_helper: str = "",
        target_window_provider: Callable[[], ForegroundWindow | None] | None = None,
        foreground_provider: Callable[[], ForegroundWindow | None] | None = None,
        popen_factory: Callable[..., ProcessLike] = subprocess.Popen,
        poll_interval: float = 0.25,
        retry_delay: float = 2.0,
        log: logging.Logger | None = None,
    ) -> None:
        self.on_text = on_text
        self.language = normalize_speech_locale(language)
        self.backend = str(backend or "embedded").strip().lower()
        if self.backend not in WINDOWS_SPEECH_BACKENDS:
            raise ValueError(f"Unknown Windows speech backend: {backend!r}")
        self.configured_model_path = str(model_path or "").strip()
        self.configured_runtime_path = str(runtime_path or "").strip()
        self.license_file = str(license_file or os.environ.get("GSM_WINDOWS_SPEECH_LICENSE_FILE", "")).strip()
        self.audio_helper_override = str(audio_helper or "").strip()
        self.speech_helper_override = str(speech_helper or "").strip()
        # ``foreground_provider`` is retained as a compatibility/testing
        # injection point, but the default is deliberately the GSM/OBS target.
        provider = target_window_provider or foreground_provider or get_target_window
        self.target_window_provider = provider
        self.foreground_provider = provider
        self.popen_factory = popen_factory
        self.poll_interval = max(0.05, float(poll_interval))
        self.retry_delay = max(0.25, float(retry_delay))
        self.log = log or logger
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._pair: _ProcessPair | None = None
        self._generation = 0
        self._resolved_model_path: Path | None = None
        self._resolved_runtime_path: Path | None = None

    @property
    def is_running(self) -> bool:
        return bool(self._thread and self._thread.is_alive())

    def start(self) -> bool:
        if sys.platform != "win32":
            self.log.warning("Windows speech recognition is only available on Windows.")
            return False
        if self.is_running:
            return True
        try:
            self._validate_configuration()
        except (OSError, ValueError, subprocess.SubprocessError) as exc:
            self.log.error("Windows speech recognition is unavailable: %s", exc)
            return False
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, name="windows-speech-recognition", daemon=True)
        self._thread.start()
        return True

    def stop(self) -> None:
        self._stop_event.set()
        pair = self._pair
        self._pair = None
        if pair is not None:
            pair.stop()
        thread = self._thread
        if thread and thread is not threading.current_thread():
            thread.join(timeout=3)
        self._thread = None

    def _validate_configuration(self) -> None:
        self._resolved_model_path = None
        self._resolved_runtime_path = None
        audio_helper = resolve_native_helper("audio", self.audio_helper_override, self.backend)
        speech_helper = resolve_native_helper("speech", self.speech_helper_override, self.backend)
        if audio_helper is None:
            raise FileNotFoundError(
                "gsm-windows-audio-capture.exe was not found; build the Windows helper or set GSM_WINDOWS_AUDIO_HELPER."
            )
        if speech_helper is None:
            raise FileNotFoundError(
                f"Windows {self.backend} speech helper was not found; build it or set a helper override."
            )
        if self.backend == "embedded":
            model, runtime = self._resolve_embedded_assets()
            if model is None:
                raise FileNotFoundError(f"No MicrosoftWindows.Speech.{self.language}.1 model package was found.")
            if runtime is None:
                raise FileNotFoundError(
                    "The Live Captions Embedded Speech runtime was not found; set GSM_WINDOWS_SPEECH_RUNTIME_PATH "
                    "or allow the DirectLiveCaptions bundle to download."
                )
            self._resolved_model_path = model
            self._resolved_runtime_path = runtime

    def _resolve_embedded_assets(self) -> tuple[Path | None, Path | None]:
        """Prefer the cached DirectLiveCaptions bundle, with installed-runtime fallback."""

        model_override = self.configured_model_path or os.environ.get("GSM_WINDOWS_SPEECH_MODEL_PATH", "").strip()
        runtime_override = self.configured_runtime_path or os.environ.get("GSM_WINDOWS_SPEECH_RUNTIME_PATH", "").strip()
        if sys.platform == "win32" and not (model_override and runtime_override):
            bundle_url = os.environ.get(DIRECT_LIVE_CAPTIONS_URL_ENV, DIRECT_LIVE_CAPTIONS_URL).strip()
            try:
                ensure_direct_live_captions_bundle(
                    url=bundle_url or DIRECT_LIVE_CAPTIONS_URL,
                    progress_callback=self._on_bundle_download_progress,
                )
            except (OSError, ValueError, zipfile.BadZipFile) as exc:
                # An installed Windows 11 package is still a useful fallback if
                # the network, cache directory, or uploaded archive is unavailable.
                self.log.warning("Could not prepare the DirectLiveCaptions bundle: %s", exc)

        return (
            discover_speech_model(self.language, self.configured_model_path),
            discover_speech_runtime(self.configured_runtime_path),
        )

    def _on_bundle_download_progress(self, downloaded: int, total: int | None) -> None:
        if total:
            percent = int(downloaded * 100 / total)
            if percent % 10 == 0 or downloaded == total:
                self.log.info("Downloading Windows speech recognition bundle: %d%%", percent)
        else:
            self.log.info("Downloaded %d MB of the Windows speech recognition bundle", downloaded // (1024 * 1024))

    def _run(self) -> None:
        current_target: ForegroundWindow | None = None
        next_attempt = 0.0
        try:
            while not self._stop_event.is_set():
                window = self._safe_target_window()
                target_changed = (
                    window is None
                    or current_target is None
                    or window.hwnd != current_target.hwnd
                    or window.pid != current_target.pid
                )
                if self._pair is not None and target_changed:
                    self._pair.stop()
                    self._pair = None
                    current_target = None

                now = time.monotonic()
                if window is not None and self._pair is None and now >= next_attempt:
                    try:
                        self._generation += 1
                        self._pair = self._start_pair(window, self._generation)
                        current_target = window
                        next_attempt = 0.0
                        self.log.info(
                            "Windows speech recognition attached to target %s (PID %s).",
                            window.process_name or window.title or f"HWND {window.hwnd}",
                            window.pid,
                        )
                    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as exc:
                        self.log.error("Could not start Windows speech recognition: %s", exc)
                        self._pair = None
                        next_attempt = now + self.retry_delay

                pair = self._pair
                if pair is not None:
                    self._drain_events(pair, current_target or window or ForegroundWindow(0, 0))
                    if pair.audio.poll() is not None or pair.speech.poll() is not None:
                        pair.stop()
                        self._pair = None
                        current_target = None
                        next_attempt = time.monotonic() + self.retry_delay
                self._stop_event.wait(self.poll_interval)
        finally:
            if self._pair is not None:
                self._pair.stop()
                self._pair = None

    def _safe_target_window(self) -> ForegroundWindow | None:
        try:
            window = self.target_window_provider()
            if window is None or window.hwnd <= 0 or window.pid <= 0:
                return None
            return window
        except Exception as exc:  # noqa: BLE001 - the provider is an injectable OS boundary.
            self.log.debug("Target window provider failed: %s", exc)
            return None

    def _safe_foreground_window(self) -> ForegroundWindow | None:
        """Compatibility alias for older tests/integrations."""

        return self._safe_target_window()

    def _start_pair(self, window: ForegroundWindow, generation: int) -> _ProcessPair:
        audio_helper = resolve_native_helper("audio", self.audio_helper_override, self.backend)
        speech_helper = resolve_native_helper("speech", self.speech_helper_override, self.backend)
        if audio_helper is None or speech_helper is None:
            raise FileNotFoundError("Windows speech helper path disappeared during startup.")

        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        audio = self.popen_factory(
            [
                str(audio_helper),
                "--root-pid",
                str(window.pid),
                "--sample-rate",
                "16000",
                "--channels",
                "1",
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
            creationflags=creationflags,
        )
        try:
            speech_args = [str(speech_helper)]
            if self.backend == "sapi":
                speech_args.extend(["--language", self.language])
            else:
                model = self._resolved_model_path or discover_speech_model(self.language, self.configured_model_path)
                runtime = self._resolved_runtime_path or discover_speech_runtime(self.configured_runtime_path)
                if model is None or runtime is None:
                    raise FileNotFoundError("Windows Embedded Speech model/runtime disappeared during startup.")
                speech_args.extend(["--model-path", str(model), "--runtime-path", str(runtime)])
                if self.license_file:
                    speech_args.extend(["--license-file", self.license_file])

            speech = self.popen_factory(
                speech_args,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                bufsize=0,
                creationflags=creationflags,
            )
        except (AttributeError, OSError, RuntimeError, subprocess.SubprocessError, ValueError):
            try:
                audio.terminate()
                audio.wait(timeout=1)
            except (AttributeError, OSError, subprocess.SubprocessError, ValueError) as cleanup_exc:
                self.log.debug("Could not clean up a failed Windows speech helper start: %s", cleanup_exc)
            raise
        return _ProcessPair(audio, speech, generation, self.log)

    def _drain_events(self, pair: _ProcessPair, window: ForegroundWindow) -> None:
        while True:
            try:
                line = pair.events.get_nowait()
            except queue.Empty:
                return
            event = parse_speech_event(line)
            if event is None:
                try:
                    payload = json.loads(line)
                except (TypeError, ValueError, json.JSONDecodeError):
                    payload = None
                if isinstance(payload, dict) and payload.get("type") == "error":
                    self._log.error(
                        "Windows speech recognizer reported an error: %s",
                        payload.get("message") or "unknown error",
                    )
                continue
            source_instance = f"windows-speech:{window.pid}:{pair.generation}:{pair.utterance_id}"
            try:
                self.on_text(event, window, source_instance)
            except Exception:
                self.log.exception("Windows speech recognition callback failed")
            if event.final:
                pair.utterance_id += 1
