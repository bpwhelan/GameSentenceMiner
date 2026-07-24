"""Unified screenshot capture via OBS websocket or Windows Graphics Capture.

The ScreenshotCapture singleton chooses a backend from the advanced config:
  - auto: on Windows, use WGC via a cached HWND and fall back to OBS.
  - obs: always use OBS websocket.
  - wgc: prefer Windows Graphics Capture and fall back to OBS if capture fails.

Public API (drop-in replacement for get_screenshot_PIL_from_source):
    from GameSentenceMiner.obs.screenshot_capture import screenshot_capture
    img = screenshot_capture.capture(source_name, ...)
"""

from __future__ import annotations

import base64
import ctypes
import io
import threading
import time
from typing import Optional

import numpy as np
from PIL import Image

from GameSentenceMiner.util.config.configuration import (
    DEFAULT_MAIN_WGC_CAPTURE_FPS,
    SCREENSHOT_CAPTURE_BACKEND_AUTO,
    SCREENSHOT_CAPTURE_BACKEND_OBS,
    get_config,
    is_windows,
    logger,
    normalize_screenshot_capture_backend,
    normalize_wgc_capture_fps,
)

# HWND cache lifetime in seconds — balance between freshness and avoiding
# repeated EnumWindows calls (which are ~0.5ms each but add up in hot loops).
_HWND_CACHE_TTL = 15.0

if is_windows():
    _USER32 = ctypes.windll.user32
else:
    _USER32 = None


def _coerce_positive_dimension(value: Optional[int]) -> Optional[int]:
    if value is None:
        return None
    try:
        dimension = int(value)
    except (TypeError, ValueError):
        return None
    return dimension if dimension > 0 else None


def _resolve_output_size(
    source_width: int,
    source_height: int,
    width: Optional[int] = None,
    height: Optional[int] = None,
) -> tuple[int, int]:
    """Resolve output dimensions, preserving aspect ratio when one axis is omitted."""
    target_width = _coerce_positive_dimension(width)
    target_height = _coerce_positive_dimension(height)

    if target_width is None and target_height is None:
        return source_width, source_height
    if target_width is None:
        target_width = max(1, int(source_width * (target_height / source_height)))
    if target_height is None:
        target_height = max(1, int(source_height * (target_width / source_width)))

    return target_width, target_height


class WinGraphicsCaptureUnavailable(RuntimeError):
    pass


# ---------------------------------------------------------------------------
# Persistent Windows Graphics Capture session
# ---------------------------------------------------------------------------


class _WGCCallbackPacer:
    """Apply backpressure to WGC's synchronous Python frame callback."""

    _DELIVERY_LAG_ALPHA = 0.25

    def __init__(self, fps: int):
        self._frame_interval = 1.0 / fps
        self._stop_event = threading.Event()
        self._next_callback_deadline: float | None = None
        self._last_callback_returned_at: float | None = None
        self._delivery_lag = 0.0

    def wait_after_frame(self, callback_started_at: float) -> None:
        """Wait outside the frame lock while keeping callback starts near the FPS cap.

        WGC delivers the next callback shortly after the current callback
        returns. Account for that delivery lag instead of sleeping for the full
        frame interval, which would make the real rate unnecessarily low.
        """
        now = time.perf_counter()
        if self._last_callback_returned_at is not None:
            observed_lag = max(0.0, callback_started_at - self._last_callback_returned_at)
            if self._delivery_lag == 0.0:
                self._delivery_lag = observed_lag
            else:
                alpha = self._DELIVERY_LAG_ALPHA
                self._delivery_lag = (1.0 - alpha) * self._delivery_lag + alpha * observed_lag

        if self._next_callback_deadline is None:
            deadline = callback_started_at + self._frame_interval
        else:
            deadline = self._next_callback_deadline + self._frame_interval
            if deadline <= callback_started_at:
                deadline = callback_started_at + self._frame_interval
        self._next_callback_deadline = deadline

        remaining = deadline - self._delivery_lag - now
        if remaining > 0:
            self._stop_event.wait(remaining)
        self._last_callback_returned_at = time.perf_counter()

    def stop(self) -> None:
        self._stop_event.set()


class _WGCSession:
    """Keeps a WGC capture session alive and buffers the latest frame."""

    def __init__(
        self,
        hwnd: int,
        *,
        include_cursor: bool = False,
        draw_border: bool = False,
        fps: int = DEFAULT_MAIN_WGC_CAPTURE_FPS,
    ):
        from windows_capture import WindowsCapture, Frame, InternalCaptureControl

        self._hwnd = hwnd
        self.fps = normalize_wgc_capture_fps(fps, DEFAULT_MAIN_WGC_CAPTURE_FPS)
        self.include_cursor = include_cursor
        self.draw_border = draw_border
        self._lock = threading.Lock()
        self._frame_buffer: np.ndarray | None = None
        self._frame_width: int = 0
        self._frame_height: int = 0
        self._ready = threading.Event()
        self._closed = False
        self._control = None
        self._pacer = _WGCCallbackPacer(self.fps)

        capture = WindowsCapture(
            cursor_capture=include_cursor,
            draw_border=draw_border,
            monitor_index=None,
            window_hwnd=hwnd,
        )

        @capture.event
        def on_frame_arrived(frame: Frame, capture_control: InternalCaptureControl):
            callback_started_at = time.perf_counter()
            with self._lock:
                # The extension's ndarray is backed by callback-owned native
                # memory, so retain an owned copy after this callback returns.
                self._frame_buffer = frame.frame_buffer.copy()
                self._frame_width = frame.width
                self._frame_height = frame.height
                self._ready.set()
            # windows-capture invokes this handler synchronously. Waiting after
            # publishing the frame applies backpressure to native capture
            # without making grab() wait on the frame lock. Its native
            # minimum_update_interval option is intentionally not used: live
            # testing with windows-capture 2.0.0 showed that it still delivered
            # frames at the compositor rate for intervals from 16 to 500 ms.
            self._pacer.wait_after_frame(callback_started_at)

        @capture.event
        def on_closed():
            self._closed = True
            self._pacer.stop()
            self._ready.set()

        self._control = capture.start_free_threaded()

    @property
    def alive(self) -> bool:
        if self._closed:
            return False
        if self._control is not None and self._control.is_finished():
            self._closed = True
            return False
        return True

    def grab(self, timeout: float = 2.0) -> tuple[np.ndarray, int, int]:
        """Return the latest owned frame buffer and dimensions."""
        if not self._ready.wait(timeout=timeout):
            raise RuntimeError("Timed out waiting for Windows Graphics Capture frame.")
        if self._closed:
            raise RuntimeError("WGC capture session closed unexpectedly.")
        with self._lock:
            if self._frame_buffer is None:
                raise RuntimeError("No frame available from WGC session.")
            return self._frame_buffer, self._frame_width, self._frame_height

    def stop(self):
        self._pacer.stop()
        if self._control is not None:
            try:
                self._control.stop()
            except Exception:
                pass
        self._closed = True


# Global session cache: hwnd -> _WGCSession
_wgc_sessions: dict[int, _WGCSession] = {}
_wgc_sessions_lock = threading.Lock()


def _get_wgc_session(
    hwnd: int,
    *,
    include_cursor: bool = False,
    draw_border: bool = False,
    fps: int = DEFAULT_MAIN_WGC_CAPTURE_FPS,
) -> _WGCSession:
    """Get or create a persistent WGC session for the given hwnd."""
    normalized_fps = normalize_wgc_capture_fps(fps, DEFAULT_MAIN_WGC_CAPTURE_FPS)
    with _wgc_sessions_lock:
        session = _wgc_sessions.get(hwnd)
        if (
            session is not None
            and session.alive
            and session.fps == normalized_fps
            and session.include_cursor == include_cursor
            and session.draw_border == draw_border
        ):
            return session
        # Recreate dead sessions and live sessions whose capture settings changed.
        if session is not None:
            session.stop()
            del _wgc_sessions[hwnd]
        new_session = _WGCSession(
            hwnd,
            include_cursor=include_cursor,
            draw_border=draw_border,
            fps=normalized_fps,
        )
        _wgc_sessions[hwnd] = new_session
        return new_session


def stop_wgc_session(hwnd: int) -> None:
    """Stop and discard the persistent WGC session for a single hwnd, if any.

    Call this when the window is known to be gone or stale.  Otherwise the
    session's capture thread keeps running and ``grab()`` keeps returning the
    last buffered frame — which can be stale, non-black content from before the
    window closed.
    """
    with _wgc_sessions_lock:
        session = _wgc_sessions.pop(hwnd, None)
    if session is not None:
        session.stop()


def stop_wgc_sessions():
    """Stop all persistent WGC sessions (call on app shutdown)."""
    with _wgc_sessions_lock:
        for session in _wgc_sessions.values():
            session.stop()
        _wgc_sessions.clear()


def _get_wgc_frame_bounds(hwnd: int) -> tuple[int, int, int, int]:
    """Return the (left, top, right, bottom) bounds WGC actually captures.

    Windows Graphics Capture frames a window at its DWM *extended frame bounds*
    (the visible window), which is inset from ``GetWindowRect`` by the invisible
    resize-border padding the DWM adds (~7px left/right/bottom on Win10/11).
    Using these bounds as the crop origin keeps the client-area crop aligned.

    Falls back to ``GetWindowRect`` if the DWM query is unavailable.
    """
    import ctypes.wintypes

    import win32gui

    DWMWA_EXTENDED_FRAME_BOUNDS = 9
    try:
        rect = ctypes.wintypes.RECT()
        hr = ctypes.windll.dwmapi.DwmGetWindowAttribute(
            ctypes.wintypes.HWND(hwnd),
            ctypes.wintypes.DWORD(DWMWA_EXTENDED_FRAME_BOUNDS),
            ctypes.byref(rect),
            ctypes.sizeof(rect),
        )
        if hr == 0:
            return int(rect.left), int(rect.top), int(rect.right), int(rect.bottom)
    except Exception as e:
        logger.debug(f"ScreenshotCapture: DwmGetWindowAttribute failed, using GetWindowRect: {e}")

    return win32gui.GetWindowRect(hwnd)


def _capture_hwnd_windows_graphics_capture(
    hwnd: int,
    width: Optional[int] = None,
    height: Optional[int] = None,
    *,
    include_cursor: bool = False,
    draw_border: bool = False,
    fps: int = DEFAULT_MAIN_WGC_CAPTURE_FPS,
    timeout_seconds: float = 2.0,
) -> Image.Image:
    """
    Capture a window using Windows Graphics Capture via the `windows-capture`
    Python package.

    Uses a persistent capture session to avoid per-frame setup overhead.
    The session is kept alive and continuously buffers the latest frame,
    so repeated calls only cost a numpy copy + optional resize.

    The captured frame includes the full window (title bar + borders). We crop
    to the client area so only game content is returned.
    """
    try:
        import win32gui
        from windows_capture import WindowsCapture  # noqa: F401 — validate import
    except ImportError as exc:
        raise WinGraphicsCaptureUnavailable(f"Windows Graphics Capture dependencies not available: {exc}") from exc

    if not win32gui.IsWindow(hwnd):
        raise RuntimeError(f"Invalid hwnd: {hwnd}")

    if win32gui.IsIconic(hwnd):
        raise RuntimeError("Cannot capture a minimized window with Windows Graphics Capture.")

    session = _get_wgc_session(
        hwnd,
        include_cursor=include_cursor,
        draw_border=draw_border,
        fps=fps,
    )
    buf, fw, fh = session.grab(timeout=timeout_seconds)

    # buf is BGRA numpy array from windows-capture frame_buffer
    if buf.ndim == 2:
        # Flat buffer — reshape to (height, width, 4)
        buf = buf.reshape((fh, fw, 4))

    # Crop to client area to exclude the title bar and window borders.
    # WGC captures the full window frame; we calculate the client area offset
    # relative to the window rect and crop accordingly.
    try:
        # WGC frames the window at its DWM *extended frame bounds* (the visible
        # window), NOT GetWindowRect. GetWindowRect includes the invisible
        # resize-border padding the DWM adds (~7px left/right/bottom on Win10/11),
        # so using it as the crop origin shifts the client crop by that padding
        # and misaligns every OCR box. Prefer the extended frame bounds; fall
        # back to GetWindowRect if the DWM query fails.
        win_left, win_top, win_right, win_bottom = _get_wgc_frame_bounds(hwnd)
        client_left, client_top = win32gui.ClientToScreen(hwnd, (0, 0))
        client_rect = win32gui.GetClientRect(hwnd)  # (0, 0, client_w, client_h)
        client_w = client_rect[2]
        client_h = client_rect[3]

        # Offset of client area within the captured frame
        crop_x = client_left - win_left
        crop_y = client_top - win_top

        # Clamp to frame bounds
        crop_x = max(0, min(crop_x, fw - 1))
        crop_y = max(0, min(crop_y, fh - 1))
        crop_right = min(crop_x + client_w, fw)
        crop_bottom = min(crop_y + client_h, fh)

        if crop_right > crop_x and crop_bottom > crop_y:
            buf = buf[crop_y:crop_bottom, crop_x:crop_right]
            fh, fw = buf.shape[0], buf.shape[1]
    except Exception as e:
        logger.debug(f"ScreenshotCapture: failed to crop to client area, using full frame: {e}")

    import cv2

    target_width, target_height = _resolve_output_size(fw, fh, width, height)

    # Resize BEFORE color conversion so we operate on less data when downscaling
    if (target_width, target_height) != (fw, fh):
        buf = cv2.resize(buf, (target_width, target_height), interpolation=cv2.INTER_LINEAR)

    # BGRA -> RGB via cv2 (SIMD-optimized, avoids expensive numpy fancy indexing)
    rgb = cv2.cvtColor(buf, cv2.COLOR_BGRA2RGB)
    return Image.fromarray(rgb)


class ScreenshotCapture:
    """Singleton that captures screenshots via the configured backend."""

    def __init__(self) -> None:
        self._hwnd: Optional[int] = None
        self._hwnd_timestamp: float = 0.0
        self._hwnd_source_name: Optional[str] = None
        self._wgc_available: Optional[bool] = None  # None = not yet checked
        self._wgc_failed_count: int = 0
        # After N consecutive WGC failures, stop trying until next HWND refresh.
        self._wgc_max_consecutive_failures: int = 3

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def capture(
        self,
        source_name: str,
        compression: int = 75,
        img_format: str = "png",
        width: Optional[int] = None,
        height: Optional[int] = None,
        retry: int = 3,
        force_obs: bool = False,
        capture_fps: Optional[int] = None,
    ):
        """Capture a screenshot from the given OBS source, using WGC when possible.

        Returns a PIL Image or None on failure.
        """
        if not source_name:
            logger.error("ScreenshotCapture: No source name provided.")
            return None

        capture_backend = SCREENSHOT_CAPTURE_BACKEND_OBS if force_obs else self._get_configured_capture_backend()

        # Try WGC first on Windows unless the profile is configured for OBS.
        if capture_backend != SCREENSHOT_CAPTURE_BACKEND_OBS and self._should_use_wgc(source_name):
            fps = self._get_configured_wgc_fps() if capture_fps is None else capture_fps
            img = self._capture_windows(width=width, height=height, fps=fps)
            if img is not None:
                self._wgc_failed_count = 0
                return img
            else:
                self._wgc_failed_count += 1

        # Fallback: OBS websocket
        return self._capture_obs(source_name, compression, img_format, width, height, retry)

    def invalidate_hwnd(self) -> None:
        """Force HWND to be re-resolved on next capture (e.g. on scene change)."""
        if self._hwnd is not None:
            stop_wgc_session(self._hwnd)
        self._hwnd = None
        self._hwnd_timestamp = 0.0
        self._hwnd_source_name = None
        self._wgc_failed_count = 0

    # ------------------------------------------------------------------
    # Windows Graphics Capture
    # ------------------------------------------------------------------

    def _get_configured_capture_backend(self) -> str:
        """Return the configured capture backend, defaulting to auto on config errors."""
        try:
            advanced_config = getattr(get_config(), "advanced", None)
            return normalize_screenshot_capture_backend(
                getattr(advanced_config, "screenshot_capture_backend_v2", SCREENSHOT_CAPTURE_BACKEND_AUTO)
            )
        except Exception as e:
            logger.debug(f"ScreenshotCapture: failed to read capture backend config: {e}")
            return SCREENSHOT_CAPTURE_BACKEND_AUTO

    def _get_configured_wgc_fps(self) -> int:
        """Return the main-process WGC frame cap."""
        try:
            advanced_config = getattr(get_config(), "advanced", None)
            return normalize_wgc_capture_fps(
                getattr(advanced_config, "wgc_capture_fps", DEFAULT_MAIN_WGC_CAPTURE_FPS),
                DEFAULT_MAIN_WGC_CAPTURE_FPS,
            )
        except Exception as e:
            logger.debug(f"ScreenshotCapture: failed to read WGC FPS config: {e}")
            return DEFAULT_MAIN_WGC_CAPTURE_FPS

    def _should_use_wgc(self, source_name: str) -> bool:
        """Determine if WGC capture should be attempted."""
        if not is_windows():
            return False

        if self._wgc_available is False:
            return False

        # Too many consecutive failures — wait for next HWND refresh
        if self._wgc_failed_count >= self._wgc_max_consecutive_failures:
            return False

        # Ensure we have a valid, fresh HWND
        hwnd = self._get_hwnd(source_name)
        return hwnd is not None

    def _get_hwnd(self, source_name: str) -> Optional[int]:
        """Return cached HWND or refresh if stale/missing."""
        now = time.monotonic()

        # Check if cache is still valid
        if (
            self._hwnd is not None
            and self._hwnd_source_name == source_name
            and (now - self._hwnd_timestamp) < _HWND_CACHE_TTL
        ):
            # Quick validity check — is the window still alive?
            if self._is_hwnd_valid(self._hwnd):
                return self._hwnd
            # Window went away — tear down its capture session so we don't keep
            # serving the last buffered frame from a now-dead window.
            stop_wgc_session(self._hwnd)
            self._hwnd = None

        # Try to resolve HWND
        self._hwnd = self._resolve_hwnd(source_name)
        self._hwnd_timestamp = now
        self._hwnd_source_name = source_name
        self._wgc_failed_count = 0
        return self._hwnd

    def _resolve_hwnd(self, source_name: str) -> Optional[int]:
        """Resolve the HWND for the active game window.

        Strategy:
        1. Use WindowStateMonitor's cached target_hwnd if available and fresh.
        2. Otherwise, get window info from OBS source settings and find the window.
        """
        # Strategy 1: Use WindowStateMonitor if available (already running its own thread)
        try:
            from GameSentenceMiner.util.platform.window_state_monitor import get_window_state_monitor

            monitor = get_window_state_monitor()
            if monitor and monitor.target_hwnd:
                if self._is_hwnd_valid(monitor.target_hwnd):
                    return monitor.target_hwnd
        except Exception:
            pass

        # Strategy 2: Resolve from OBS source settings
        try:
            from GameSentenceMiner.obs.actions import get_current_scene, get_window_info_from_source

            scene_name = get_current_scene(_suppress_obs_errors=True)
            if not scene_name:
                return None

            window_info = get_window_info_from_source(scene_name=scene_name, _suppress_obs_errors=True)
            if not window_info:
                return None

            title = window_info.get("title", "")
            window_class = window_info.get("window_class", "")
            exe = window_info.get("exe", "")

            if not title and not window_class:
                return None

            return self._find_hwnd(title, window_class, exe)
        except Exception as e:
            logger.debug(f"ScreenshotCapture: failed to resolve HWND: {e}")
            return None

    def _find_hwnd(self, title: str, window_class: str, exe: str) -> Optional[int]:
        """Find window handle by title, class, and exe name."""
        if not is_windows():
            return None

        try:
            import win32gui
            import win32process

            import psutil
        except ImportError:
            self._wgc_available = False
            return None

        self._wgc_available = True

        # Try exact match first
        if title:
            handle = win32gui.FindWindow(window_class or None, title)
            if handle and win32gui.IsWindow(handle):
                return handle

        # Enumerate windows for partial title match
        candidates: list[tuple[int, str]] = []
        skip_exes = {"cmd.exe", "powershell.exe", "windowsterminal.exe", "code.exe"}

        def _enum_cb(hwnd, _):
            if not win32gui.IsWindowVisible(hwnd):
                return True
            wnd_title = win32gui.GetWindowText(hwnd)
            if not wnd_title:
                return True

            match = False
            if title and title in wnd_title:
                match = True
            elif window_class and _USER32 is not None:
                cls_buf = ctypes.create_unicode_buffer(256)
                _USER32.GetClassNameW(hwnd, cls_buf, 256)
                if cls_buf.value == window_class:
                    match = True

            if match:
                candidates.append((hwnd, wnd_title))
            return True

        win32gui.EnumWindows(_enum_cb, None)

        # Filter candidates by exe if provided
        for hwnd, _wnd_title in candidates:
            try:
                _, pid = win32process.GetWindowThreadProcessId(hwnd)
                proc_name = psutil.Process(pid).name().lower()
                if proc_name in skip_exes:
                    continue
                if exe and proc_name != exe.lower():
                    continue
                return hwnd
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue

        # If exe filter was too strict, return first non-terminal candidate
        if exe:
            for hwnd, _wnd_title in candidates:
                try:
                    _, pid = win32process.GetWindowThreadProcessId(hwnd)
                    proc_name = psutil.Process(pid).name().lower()
                    if proc_name not in skip_exes:
                        return hwnd
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    continue

        return None

    def _is_hwnd_valid(self, hwnd: int) -> bool:
        """Check if an HWND is still a valid window."""
        if not is_windows():
            return False
        try:
            return bool(_USER32 is not None and _USER32.IsWindow(hwnd))
        except Exception:
            return False

    def _capture_windows(
        self,
        width: Optional[int] = None,
        height: Optional[int] = None,
        fps: int = DEFAULT_MAIN_WGC_CAPTURE_FPS,
    ):
        """Capture via Windows Graphics Capture. Returns a PIL Image or None."""
        hwnd = self._hwnd
        if not hwnd:
            return None

        try:
            return _capture_hwnd_windows_graphics_capture(
                hwnd,
                width=width,
                height=height,
                include_cursor=False,
                draw_border=False,
                fps=fps,
            )
        except WinGraphicsCaptureUnavailable as e:
            self._wgc_available = False
            logger.debug(f"ScreenshotCapture: Windows Graphics Capture unavailable: {e}")
            return None
        except Exception as e:
            logger.debug(f"ScreenshotCapture: Windows Graphics Capture failed: {e}")
            return None

    # ------------------------------------------------------------------
    # OBS websocket capture (fallback)
    # ------------------------------------------------------------------

    def _capture_obs(self, source_name, compression, img_format, width, height, retry):
        """Capture via OBS websocket — the original method."""
        from GameSentenceMiner.obs.service import _call_with_obs_client

        from PIL import Image

        def _capture(client):
            response = client.get_source_screenshot(
                name=source_name,
                img_format=img_format,
                quality=compression,
                width=width,
                height=height,
            )
            if not response or not hasattr(response, "image_data") or not response.image_data:
                raise AttributeError("Invalid screenshot response")
            image_data = response.image_data.split(",", 1)[-1]
            image_data = base64.b64decode(image_data)
            img = Image.open(io.BytesIO(image_data))
            return img

        return _call_with_obs_client(
            _capture,
            default=None,
            error_msg=f"Error getting screenshot from source '{source_name}'",
            retryable=True,
            retries=max(0, retry - 1),
        )

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _resize(img, width: Optional[int], height: Optional[int]):
        """Resize image to target dimensions if specified."""
        if not width and not height:
            return img
        from PIL import Image

        orig_w, orig_h = img.size
        target_w = width or int(orig_w * (height / orig_h))
        target_h = height or int(orig_h * (width / orig_w))
        if target_w == orig_w and target_h == orig_h:
            return img
        return img.resize((target_w, target_h), Image.LANCZOS)


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------
screenshot_capture = ScreenshotCapture()


def is_image_empty(
    img: Image.Image | np.ndarray,
    *,
    tolerance: int = 5,
    black_threshold: int = 30,
    sample_step: int = 64,
) -> bool:
    """
    Cheap detector for inactive/blank capture frames.

    Returns True under two conditions:
    1. Uniform solid colour: sampled pixel range ≤ tolerance (catches any solid frame).
    2. Near-black with noise: all sampled channel maxima ≤ black_threshold AND range
       ≤ black_threshold // 2.  Covers OBS sources that show a slightly-noisy dark
       frame when the game is not running (e.g. values 13–30 that JPEG or the
       compositing pipeline adds to an otherwise-black source).

    sample_step is clamped so that at least 4×4 positions are checked even on small
    images, preventing single-pixel samples from masking real variation.
    """

    if img is None:
        return True

    if isinstance(img, Image.Image):
        try:
            arr = np.asarray(img)
        except Exception:
            return False
    else:
        arr = img

    if getattr(arr, "size", 0) == 0 or getattr(arr, "ndim", 0) < 2:
        return False

    if arr.ndim == 3 and arr.shape[2] >= 3:
        arr = arr[:, :, :3]

    # Clamp step so small images still get meaningful coverage (≥4 positions per axis).
    h, w = arr.shape[:2]
    effective_step = max(1, min(sample_step, max(h // 4, 1), max(w // 4, 1)))
    sampled = arr[::effective_step, ::effective_step]

    if sampled.size == 0:
        return False

    try:
        if sampled.ndim == 3:
            maxs = sampled.max(axis=(0, 1))
            mins = sampled.min(axis=(0, 1))
            range_vals = maxs - mins

            # Primary: uniform solid colour at any brightness
            if np.all(range_vals <= tolerance):
                return True

            # Secondary: near-black with mild noise (JPEG artefacts, OBS dark source)
            if np.all(maxs <= black_threshold) and np.all(range_vals <= black_threshold // 2):
                return True

            return False

        max_val = sampled.max()
        min_val = sampled.min()
        range_val = max_val - min_val

        if range_val <= tolerance:
            return True
        if max_val <= black_threshold and range_val <= black_threshold // 2:
            return True
        return False

    except Exception:
        return False
