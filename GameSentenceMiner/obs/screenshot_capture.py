"""Unified screenshot capture — OBS websocket or Win32 PrintWindow.

The ScreenshotCapture singleton chooses a backend from screenshot.capture_backend:
  - auto: on Windows, use PrintWindow via a cached HWND and fall back to OBS.
  - obs: always use OBS websocket.
  - winapi: prefer PrintWindow and fall back to OBS if capture fails.

Public API (drop-in replacement for get_screenshot_PIL_from_source):
    from GameSentenceMiner.obs.screenshot_capture import screenshot_capture
    img = screenshot_capture.capture(source_name, ...)
"""

from __future__ import annotations

import base64
import ctypes
import io
import time
from typing import Optional

from pathlib import Path

import numpy as np
from PIL import Image

from GameSentenceMiner.util.config.configuration import (
    SCREENSHOT_CAPTURE_BACKEND_AUTO,
    SCREENSHOT_CAPTURE_BACKEND_OBS,
    get_config,
    is_windows,
    logger,
    normalize_screenshot_capture_backend,
)

# HWND cache lifetime in seconds — balance between freshness and avoiding
# repeated EnumWindows calls (which are ~0.5ms each but add up in hot loops).
_HWND_CACHE_TTL = 15.0

SRCCOPY = 0x00CC0020
COLORONCOLOR = 3
PW_RENDERFULLCONTENT = 0x00000002

if is_windows():
    _USER32 = ctypes.windll.user32
    _GDI32 = ctypes.windll.gdi32
else:
    _USER32 = None
    _GDI32 = None


class WinAPICaptureUnavailable(RuntimeError):
    """Raised when the WinAPI capture stack is unavailable on this system."""


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


def _bitmap_to_pil_image(bitmap):
    from PIL import Image

    bmpinfo = bitmap.GetInfo()
    bmpstr = bitmap.GetBitmapBits(True)
    return Image.frombuffer(
        "RGB",
        (bmpinfo["bmWidth"], bmpinfo["bmHeight"]),
        bmpstr,
        "raw",
        "BGRX",
        0,
        1,
    )


class WinGraphicsCaptureUnavailable(RuntimeError):
    pass


# ---------------------------------------------------------------------------
# Persistent Windows Graphics Capture session
# ---------------------------------------------------------------------------

import threading


class _WGCSession:
    """Keeps a WGC capture session alive and buffers the latest frame."""

    def __init__(self, hwnd: int, *, include_cursor: bool = False, draw_border: bool = False):
        from windows_capture import WindowsCapture, Frame, InternalCaptureControl

        self._hwnd = hwnd
        self._lock = threading.Lock()
        self._frame_buffer: np.ndarray | None = None
        self._frame_width: int = 0
        self._frame_height: int = 0
        self._ready = threading.Event()
        self._closed = False
        self._control = None

        capture = WindowsCapture(
            cursor_capture=include_cursor,
            draw_border=draw_border,
            monitor_index=None,
            window_hwnd=hwnd,
            minimum_update_interval=167,
        )

        @capture.event
        def on_frame_arrived(frame: Frame, capture_control: InternalCaptureControl):
            with self._lock:
                self._frame_buffer = frame.frame_buffer
                self._frame_width = frame.width
                self._frame_height = frame.height
                self._ready.set()
                time.sleep(0.167) # 10 FPS cap to reduce CPU usage; WGC captures at full framerate by default

        @capture.event
        def on_closed():
            self._closed = True
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
        """Return (frame_buffer_copy, width, height). Raises on timeout or closed."""
        if not self._ready.wait(timeout=timeout):
            raise RuntimeError("Timed out waiting for Windows Graphics Capture frame.")
        if self._closed:
            raise RuntimeError("WGC capture session closed unexpectedly.")
        with self._lock:
            if self._frame_buffer is None:
                raise RuntimeError("No frame available from WGC session.")
            return self._frame_buffer.copy(), self._frame_width, self._frame_height

    def stop(self):
        if self._control is not None:
            try:
                self._control.stop()
            except Exception:
                pass
        self._closed = True


# Global session cache: hwnd -> _WGCSession
_wgc_sessions: dict[int, _WGCSession] = {}
_wgc_sessions_lock = threading.Lock()


def _get_wgc_session(hwnd: int, *, include_cursor: bool = False, draw_border: bool = False) -> _WGCSession:
    """Get or create a persistent WGC session for the given hwnd."""
    with _wgc_sessions_lock:
        session = _wgc_sessions.get(hwnd)
        if session is not None and session.alive:
            return session
        # Clean up dead session
        if session is not None:
            session.stop()
            del _wgc_sessions[hwnd]
        # Create new session
        new_session = _WGCSession(hwnd, include_cursor=include_cursor, draw_border=draw_border)
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


def _capture_hwnd_windows_graphics_capture(
    hwnd: int,
    width: Optional[int] = None,
    height: Optional[int] = None,
    *,
    include_cursor: bool = False,
    draw_border: bool = False,
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

    session = _get_wgc_session(hwnd, include_cursor=include_cursor, draw_border=draw_border)
    buf, fw, fh = session.grab(timeout=timeout_seconds)

    # buf is BGRA numpy array from windows-capture frame_buffer
    if buf.ndim == 2:
        # Flat buffer — reshape to (height, width, 4)
        buf = buf.reshape((fh, fw, 4))

    # Crop to client area to exclude the title bar and window borders.
    # WGC captures the full window frame; we calculate the client area offset
    # relative to the window rect and crop accordingly.
    try:
        win_left, win_top, win_right, win_bottom = win32gui.GetWindowRect(hwnd)
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


def _capture_hwnd_winapi(hwnd: int, width: Optional[int] = None, height: Optional[int] = None):
    """Capture a window with PrintWindow, scaling in GDI before pixels enter Python."""
    if _USER32 is None or _GDI32 is None:
        raise WinAPICaptureUnavailable("WinAPI capture is only available on Windows.")

    try:
        import pywintypes
        import win32gui
        import win32ui
    except ImportError as exc:
        raise WinAPICaptureUnavailable(f"win32 dependencies not available: {exc}") from exc

    src_bmp = None
    dst_bmp = None
    src_dc = None
    dst_dc = None
    mfc_dc = None
    hwnd_dc = None
    old_src_obj = None
    old_dst_obj = None

    try:
        left, top, right, bottom = win32gui.GetWindowRect(hwnd)
        source_width = right - left
        source_height = bottom - top
        if source_width <= 0 or source_height <= 0:
            raise RuntimeError(f"Invalid window size: {source_width}x{source_height}")

        target_width, target_height = _resolve_output_size(source_width, source_height, width, height)

        hwnd_dc = win32gui.GetWindowDC(hwnd)
        if not hwnd_dc:
            raise RuntimeError("GetWindowDC failed / returned 0")

        mfc_dc = win32ui.CreateDCFromHandle(hwnd_dc)

        src_dc = mfc_dc.CreateCompatibleDC()
        src_bmp = win32ui.CreateBitmap()
        src_bmp.CreateCompatibleBitmap(mfc_dc, source_width, source_height)
        old_src_obj = src_dc.SelectObject(src_bmp)

        ok = _USER32.PrintWindow(hwnd, src_dc.GetSafeHdc(), PW_RENDERFULLCONTENT)
        if not ok:
            raise RuntimeError("PrintWindow failed / returned 0")

        if target_width == source_width and target_height == source_height:
            return _bitmap_to_pil_image(src_bmp)

        dst_dc = mfc_dc.CreateCompatibleDC()
        dst_bmp = win32ui.CreateBitmap()
        dst_bmp.CreateCompatibleBitmap(mfc_dc, target_width, target_height)
        old_dst_obj = dst_dc.SelectObject(dst_bmp)

        _GDI32.SetStretchBltMode(dst_dc.GetSafeHdc(), COLORONCOLOR)
        ok = _GDI32.StretchBlt(
            dst_dc.GetSafeHdc(),
            0,
            0,
            target_width,
            target_height,
            src_dc.GetSafeHdc(),
            0,
            0,
            source_width,
            source_height,
            SRCCOPY,
        )
        if not ok:
            raise RuntimeError("StretchBlt failed / returned 0")

        return _bitmap_to_pil_image(dst_bmp)

    except pywintypes.error as exc:
        raise RuntimeError(f"Win32 capture failed: {exc}") from exc

    finally:
        try:
            if src_dc is not None and old_src_obj is not None:
                src_dc.SelectObject(old_src_obj)
        except Exception:
            pass

        try:
            if dst_dc is not None and old_dst_obj is not None:
                dst_dc.SelectObject(old_dst_obj)
        except Exception:
            pass

        for cleanup, obj in [
            (lambda o: win32gui.DeleteObject(o.GetHandle()), dst_bmp),
            (lambda o: win32gui.DeleteObject(o.GetHandle()), src_bmp),
            (lambda o: o.DeleteDC(), dst_dc),
            (lambda o: o.DeleteDC(), src_dc),
            (lambda o: o.DeleteDC(), mfc_dc),
            (lambda o: win32gui.ReleaseDC(hwnd, o), hwnd_dc),
        ]:
            if obj is not None:
                try:
                    cleanup(obj)
                except Exception:
                    pass


class ScreenshotCapture:
    """Singleton that captures screenshots via the configured backend."""

    def __init__(self) -> None:
        self._hwnd: Optional[int] = None
        self._hwnd_timestamp: float = 0.0
        self._hwnd_source_name: Optional[str] = None
        self._winapi_available: Optional[bool] = None  # None = not yet checked
        self._winapi_failed_count: int = 0
        # After N consecutive WinAPI failures, stop trying until next HWND refresh
        self._winapi_max_consecutive_failures: int = 3

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
    ):
        """Capture a screenshot from the given OBS source, using WinAPI when possible.

        Returns a PIL Image or None on failure.
        """
        if not source_name:
            logger.error("ScreenshotCapture: No source name provided.")
            return None

        capture_backend = SCREENSHOT_CAPTURE_BACKEND_OBS if force_obs else self._get_configured_capture_backend()

        # Try WinAPI first on Windows (much faster) unless the profile is configured for OBS.
        if capture_backend != SCREENSHOT_CAPTURE_BACKEND_OBS and self._should_use_winapi(source_name):
            img = self._capture_windows(width=width, height=height)
            if img is not None:
                self._winapi_failed_count = 0
                return img
            else:
                self._winapi_failed_count += 1

        # Fallback: OBS websocket
        return self._capture_obs(source_name, compression, img_format, width, height, retry)

    def invalidate_hwnd(self) -> None:
        """Force HWND to be re-resolved on next capture (e.g. on scene change)."""
        if self._hwnd is not None:
            stop_wgc_session(self._hwnd)
        self._hwnd = None
        self._hwnd_timestamp = 0.0
        self._hwnd_source_name = None
        self._winapi_failed_count = 0

    # ------------------------------------------------------------------
    # WinAPI capture
    # ------------------------------------------------------------------

    def _get_configured_capture_backend(self) -> str:
        """Return the configured capture backend, defaulting to auto on config errors."""
        try:
            advanced_config = getattr(get_config(), "advanced", None)
            return normalize_screenshot_capture_backend(
                getattr(advanced_config, "screenshot_capture_backend", SCREENSHOT_CAPTURE_BACKEND_AUTO)
            )
        except Exception as e:
            logger.debug(f"ScreenshotCapture: failed to read capture backend config: {e}")
            return SCREENSHOT_CAPTURE_BACKEND_AUTO

    def _should_use_winapi(self, source_name: str) -> bool:
        """Determine if WinAPI capture should be attempted."""
        if not is_windows():
            return False

        if self._winapi_available is False:
            return False

        # Too many consecutive failures — wait for next HWND refresh
        if self._winapi_failed_count >= self._winapi_max_consecutive_failures:
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
        self._winapi_failed_count = 0
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
            self._winapi_available = False
            return None

        self._winapi_available = True

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

    def _capture_windows(self, width: Optional[int] = None, height: Optional[int] = None):
        """Capture via Windows Graphics Capture. Returns a PIL Image or None."""
        hwnd = self._hwnd
        if not hwnd:
            return None

        try:
            return _capture_hwnd_windows_graphics_capture(
                hwnd, width=width, height=height, include_cursor=False, draw_border=False
            )
        except WinAPICaptureUnavailable as e:
            self._winapi_available = False
            logger.debug(f"ScreenshotCapture: WinAPI capture unavailable: {e}")
            return None
        except WinGraphicsCaptureUnavailable as e:
            logger.debug(f"ScreenshotCapture: Windows Graphics Capture unavailable: {e}")
            return None
        except Exception as e:
            logger.debug(f"ScreenshotCapture: WinAPI capture failed: {e}")
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
