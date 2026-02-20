import asyncio
import base64
import copy
import ctypes
import difflib
import io
import json
import math
import os
import regex
import threading
import time
from PIL import Image
from ctypes import wintypes
from datetime import datetime
from rapidfuzz import fuzz
from typing import Dict, Any, List, Tuple, Optional

# Updated imports to include window info helpers
from GameSentenceMiner.obs import get_screenshot_PIL
from GameSentenceMiner.ocr.gsm_ocr_config import get_ocr_config
# Local application imports
from GameSentenceMiner.ocr.gsm_ocr_config import set_dpi_awareness
from GameSentenceMiner.ocr.image_scaling import (
    scale_dimensions_by_aspect_buckets,
    scale_pil_image,
    ScaledSize,
)
from GameSentenceMiner.owocr.owocr.run import apply_ocr_config_to_image
from GameSentenceMiner.util.config.configuration import OverlayEngine, get_config, get_overlay_config, \
    get_temporary_directory, is_wayland, is_windows, is_beangate, logger
from GameSentenceMiner.util.config.electron_config import get_ocr_language
from GameSentenceMiner.util.platform.window_state_monitor import WindowStateMonitor, get_window_client_screen_offset, \
    user32, set_window_state_monitor, _load_suspended_pids
from GameSentenceMiner.util.text_log import GameLine, TextSource, game_log
from GameSentenceMiner.web.gsm_websocket import websocket_manager, ID_OVERLAY
from GameSentenceMiner.web.texthooking_page import send_word_coordinates_to_overlay

# --- Configuration ---
# Set to True only when debugging image issues to save CPU/Disk usage
SAVE_DEBUG_IMAGES = False
# Convert images to grayscale for overlay processing
CONVERT_TO_GRAYSCALE = False
MAX_SCALED_OCR_CACHE_SIZE = 24

# Conditionally import OCR engines
try:
    from GameSentenceMiner.owocr.owocr.ocr import OneOCR
except ImportError:
    OneOCR = None
    
try:
    from GameSentenceMiner.owocr.owocr.ocr import GoogleLens, get_regex, MeikiOCR
except ImportError:
    GoogleLens, get_regex, MeikiOCR = None, None, None
except Exception as e:
    GoogleLens, get_regex, MeikiOCR = None, None, None
    logger.exception(f"Error importing OCR engines: {e}")

# Conditionally import screenshot library
try:
    import mss
except ImportError:
    mss = None

class OverlayThread(threading.Thread):
    """
    A thread to run the overlay processing loop.
    """
    def __init__(self):
        super().__init__()
        self.loop = asyncio.new_event_loop()
        self.daemon = True
        self.first_time_run = True
        
        # Load and resume any orphaned suspended processes from previous session
        _load_suspended_pids()
        
        self.window_monitor = WindowStateMonitor(overlay_processor)
        set_window_state_monitor(self.window_monitor)
        overlay_processor.window_monitor = self.window_monitor
        overlay_processor.processing_loop = self.loop

    def run(self):
        """Runs the overlay processing loop."""
        asyncio.set_event_loop(self.loop)
        if is_windows():
            self.loop.create_task(self.window_monitor_loop())
        self.loop.create_task(self.overlay_loop())
        self.loop.run_forever()

    async def window_monitor_loop(self):
        """Secondary loop to monitor window state (High Frequency)."""
        while True:
            try:
                if websocket_manager.has_clients(ID_OVERLAY):
                    await self.window_monitor.check_and_send()
                await asyncio.sleep(self.window_monitor.poll_interval)
            except Exception as e:
                logger.debug(f"Window monitor error: {e}")
                await asyncio.sleep(1)

    async def overlay_loop(self):
        """Main loop to periodically process and send overlay data."""
        while True:
            if websocket_manager.has_clients(ID_OVERLAY):
                if get_config().overlay.periodic:
                    await overlay_processor.find_box_and_send_to_overlay(check_against_last=True, local_ocr_retry=0)
                    await asyncio.sleep(get_config().overlay.periodic_interval)
                elif self.first_time_run:
                    await overlay_processor.find_box_and_send_to_overlay(check_against_last=False, local_ocr_retry=0)
                    self.first_time_run = False
                else:
                    await asyncio.sleep(3)
            else:
                self.first_time_run = True
                await asyncio.sleep(3)

class OverlayProcessor:
    """
    Handles the entire overlay process from screen capture to text extraction.
    """
    
    ENABLE_DETAILED_TIMING = False  # Set to True to enable detailed timing traces in logger.info
    ENABLE_SCALING_DEBUG = False  # Set to True to enable detailed scaling debug logs
    
    def _log_timing(self, start_time: float, operation: str) -> None:
        """Helper method to log timing information for heavy operations.
        
        Args:
            start_time: The time.time() value when the operation started
            operation: Description of the operation being timed
        """
        if self.ENABLE_DETAILED_TIMING:
            elapsed_ms = (time.time() - start_time) * 1000
            logger.info(f"[TIMING] {operation}: {elapsed_ms:.2f}ms")
    
    # Screenshot scaling factor for performance optimization
    # SCALE_TYPE options:
    # - "fixed": Uses SCREENSHOT_SCALE_FACTOR to scale the image
    # - "forced_minimum": Scales down to MINIMUM_WIDTH/MINIMUM_HEIGHT (whichever is larger)
    SCALE_TYPE = "fixed"
    # SCALE_TYPE = "forced_minimum"
    SCREENSHOT_SCALE_FACTOR = 0.1  # 1.0 = no scaling (only used when SCALE_TYPE = "fixed")
    MINIMUM_WIDTH = 1024
    MINIMUM_HEIGHT = 768
    
    def __init__(self):
        self.config = get_config()
        self.oneocr = None
        self.meikiocr = None
        self.lens = None
        self.regex = None
        self.ready = False
        self.last_oneocr_result = None
        self.last_lens_result = None
        self.current_task = None
        self.windows_warning_shown = False
        self.processing_loop: asyncio.AbstractEventLoop = None
        self.last_sentences = []
        self.sentence_backlog_max_size = 8
        self.remove_used_sentences = True
        self.current_engine_config = None
        self.ss_width = 0
        self.ss_height = 0
        self._current_sequence = 0
        self.punctuation_regex = regex.compile(r'[\p{P}\p{S}\p{Z}]')
        self.calculated_width_scale_factor = 1.0
        self.calculated_height_scale_factor = 1.0
        self.obs_width = None
        self.obs_height = None
        
        # State for reprocessing without re-scanning
        self.last_raw_results: Optional[Any] = None
        self.last_raw_source: Optional[str] = None
        self.last_img_dimensions: Tuple[int, int] = (0, 0)
        self.last_scan_window_offset: Tuple[int, int] = (0, 0)

        # Reference to WindowStateMonitor (injected by OverlayThread)
        self.window_monitor: Optional[WindowStateMonitor] = None
        self._scaled_ocr_config_cache: Dict[Tuple[Any, ...], Any] = {}
        self._scaled_ocr_config_cache_lock = threading.Lock()

    def _build_scaled_ocr_cache_key(self, ocr_config, width: int, height: int) -> Optional[Tuple[Any, ...]]:
        if not ocr_config:
            return None
        try:
            rectangles = getattr(ocr_config, "pre_scale_rectangles", None) or getattr(ocr_config, "rectangles", [])
            rect_signature = []
            for rect in rectangles:
                monitor = getattr(rect, "monitor", None)
                monitor_signature = (
                    getattr(monitor, "index", None),
                    getattr(monitor, "left", None),
                    getattr(monitor, "top", None),
                    getattr(monitor, "width", None),
                    getattr(monitor, "height", None),
                )
                rect_signature.append(
                    (
                        tuple(getattr(rect, "coordinates", []) or []),
                        bool(getattr(rect, "is_excluded", False)),
                        bool(getattr(rect, "is_secondary", False)),
                        monitor_signature,
                    )
                )
            return (
                getattr(ocr_config, "scene", "") or "",
                getattr(ocr_config, "window", "") or "",
                getattr(ocr_config, "coordinate_system", "") or "",
                int(width or 0),
                int(height or 0),
                tuple(rect_signature),
            )
        except Exception:
            return None

    def _get_scaled_overlay_ocr_config(self, width: int, height: int):
        ocr_config = get_ocr_config()
        if not ocr_config:
            return None
        if not width or not height:
            return ocr_config

        cache_key = self._build_scaled_ocr_cache_key(ocr_config, width, height)
        if cache_key:
            with self._scaled_ocr_config_cache_lock:
                cached = self._scaled_ocr_config_cache.get(cache_key)
                if cached is not None:
                    return cached

        scaled_config = copy.deepcopy(ocr_config)
        scaled_config.scale_to_custom_size(width, height)

        if cache_key:
            with self._scaled_ocr_config_cache_lock:
                self._scaled_ocr_config_cache[cache_key] = scaled_config
                while len(self._scaled_ocr_config_cache) > MAX_SCALED_OCR_CACHE_SIZE:
                    self._scaled_ocr_config_cache.pop(next(iter(self._scaled_ocr_config_cache)), None)

        return scaled_config

    def init(self):
        """Initializes the OCR engines and configuration."""
        try:
            if all([GoogleLens, get_regex]):
                logger.debug("Initializing OCR engines...")
                self.ocr_language = get_ocr_language()
                self.regex = get_regex(self.ocr_language)
                self.ready = True
            else:
                logger.warning("OCR dependencies not found. OCR functionality will be disabled.")
            
            if is_windows:
                set_dpi_awareness()
                
            if not mss:
                logger.warning("MSS library not found. Screenshot functionality may be limited.")
        except Exception as e:
            logger.exception(f"Error initializing OCR engines for overlay, try installing owocr in OCR tab of GSM: {e}")
            self.oneocr = None
            self.lens = None
            self.regex = None
            
    def _is_sentence_recycled(self, line_text: str) -> bool:
        """Checks if a line was used before based on the backlog."""
        return line_text in game_log.previous_lines
    
    def _get_effective_engine(self) -> str:
        """Determines which engine to use based on platform and configuration."""
        overlay_config = get_overlay_config()
        engine = overlay_config.engine_v2
        if not is_windows() and engine in [OverlayEngine.ONEOCR.value, OverlayEngine.LENS.value]:
            logger.info(f"Forcing MeikiOCR on non-Windows platform (selected: {engine})")
            return OverlayEngine.MEIKIOCR.value
        return engine
    
    def _ensure_correct_engine_loaded(self):
        """Ensures the correct OCR engine is loaded based on current configuration."""
        effective_engine = self._get_effective_engine()
        
        if self.current_engine_config == effective_engine:
            return
        
        if self.current_engine_config:
            logger.info(f"Engine config changed from {self.current_engine_config} to {effective_engine}")
        
        for engine in [self.oneocr, self.meikiocr, self.lens]:
            if engine:
                try:
                    if hasattr(engine, 'close'):
                        engine.close()
                except Exception as e:
                    logger.debug(f"Error closing engine: {e}")
        
        self.oneocr = None
        self.meikiocr = None
        self.lens = None
        self.current_engine_config = effective_engine
            
    async def find_box_and_send_to_overlay(self, line: 'GameLine' = None, check_against_last: bool = False, custom_threshold: float = None, dict_from_ocr = None, sequence: int = None, local_ocr_retry = 5, source: TextSource = None):
        """Sends the detected text boxes to the overlay via WebSocket."""
        if sequence is not None and sequence != self._current_sequence:
            logger.debug(f"Skipping outdated overlay request (sequence {sequence}, current {self._current_sequence})")
            return
        
        if self.current_task and not self.current_task.done():
            self.current_task.cancel()
            try:
                await self.current_task
            except asyncio.CancelledError:
                logger.debug("Previous OCR task was cancelled")

        has_precomputed_payload = (
            isinstance(dict_from_ocr, dict)
            and dict_from_ocr.get("schema") == "gsm_overlay_coords_v1"
        )
        if not has_precomputed_payload:
            self._ensure_correct_engine_loaded()
            effective_engine = self._get_effective_engine()

            if effective_engine == OverlayEngine.LENS.value:
                if GoogleLens and not self.lens:
                    self.lens = GoogleLens(lang=get_ocr_language(), get_furigana_sens_from_file=False)
                # On Windows, also load OneOCR for the Local -> Lens workflow
                if is_windows() and OneOCR and not self.oneocr:
                    self.oneocr = OneOCR(lang=get_ocr_language(), get_furigana_sens_from_file=False)
            elif effective_engine == OverlayEngine.ONEOCR.value:
                if OneOCR and not self.oneocr:
                    self.oneocr = OneOCR(lang=get_ocr_language(), get_furigana_sens_from_file=False)
            elif effective_engine == OverlayEngine.MEIKIOCR.value:
                if MeikiOCR and not self.meikiocr:
                    self.meikiocr = MeikiOCR(lang=get_ocr_language(), get_furigana_sens_from_file=False)
        
        self.current_task = self.processing_loop.create_task(
            self.find_box_for_sentence(line, check_against_last, custom_threshold, dict_from_ocr=dict_from_ocr, sequence=sequence, local_ocr_retry=local_ocr_retry, source=source)
        )
        try:
            await self.current_task
        except asyncio.CancelledError:
            logger.debug("OCR task was cancelled")

    async def find_box_for_sentence(self, line: 'GameLine' = None, check_against_last: bool = False, custom_threshold: float = None, dict_from_ocr = None, sequence: int = None, local_ocr_retry = 5, source: TextSource = None) -> List[Dict[str, Any]]:
        if sequence is not None and sequence != self._current_sequence:
            logger.debug(f"Skipping outdated OCR work (sequence {sequence}, current {self._current_sequence})")
            return []
        
        try:
            return await self._do_work(line, check_against_last=check_against_last, custom_threshold=custom_threshold, dict_from_ocr=dict_from_ocr, local_ocr_retry=local_ocr_retry, source=source)
        except Exception as e:
            logger.exception(f"Error during OCR processing: {e}")
            return []
        
    @staticmethod
    def get_monitor_workarea(monitor_index=0):
        with mss.mss() as sct:
            monitors = sct.monitors[1:]
            monitor = monitors[monitor_index] if 0 <= monitor_index + len(monitors) else monitors[0]
            return {
                "left": monitor["left"],
                "top": monitor["top"],
                "width": monitor["width"],
                "height": monitor["height"] - 1
            }


    def _get_screenshot_and_offset(self) -> Tuple[Image.Image | None, int, int, int, int]:
        monitor = self.get_monitor_workarea(get_overlay_config().monitor_to_capture)
        monitor_w, monitor_h = monitor['width'], monitor['height']

        # If configured to use full-screen MSS instead of OBS, prefer that method.
        try:
            overlay_cfg = get_overlay_config()
            use_mss_override = overlay_cfg.ocr_full_screen_instead_of_obs
        except Exception:
            use_mss_override = False

        if use_mss_override:
            logger.info("Overlay configured to use full-screen MSS for OCR (debug). Taking MSS screenshot.")
            wayland = is_wayland()
            if mss and not wayland:
                try:
                    with mss.mss() as sct:
                        sct_img = sct.grab(monitor)
                        img = Image.frombytes('RGB', sct_img.size, sct_img.bgra, 'raw', 'BGRX')
                        if CONVERT_TO_GRAYSCALE:
                            img = img.convert('L')
                        if SAVE_DEBUG_IMAGES:
                            img.save(os.path.join(get_temporary_directory(), "latest_overlay_screenshot_mss_override.png"))
                        self.ss_width = img.width
                        self.ss_height = img.height
                        return img, 0, 0, monitor_w, monitor_h
                except Exception as e:
                    logger.debug(f"MSS screenshot (override) failed: {e}")

        if is_windows() and self.window_monitor and not use_mss_override:
            hwnd = self.window_monitor.target_hwnd
            if not hwnd:
                hwnd = self.window_monitor.find_target_hwnd()
                
                
            if hwnd and user32.IsWindowVisible(hwnd) and not user32.IsIconic(hwnd):
                try:
                    obs_img = get_screenshot_PIL(compression=90, img_format='jpg', width=self.obs_width, height=self.obs_height)
                    
                    if obs_img:
                        if CONVERT_TO_GRAYSCALE:
                            obs_img = obs_img.convert('L')
                        # Don't set obs_width/obs_height here - let scaling logic in get_image_to_ocr handle it
                        
                        off_x, off_y = get_window_client_screen_offset(hwnd)
                        final_off_x = off_x - monitor['left']
                        final_off_y = off_y - monitor['top']
                        
                        if SAVE_DEBUG_IMAGES:
                            obs_img.save(os.path.join(get_temporary_directory(), "latest_overlay_screenshot_obs.png"))
                        
                        if self.ENABLE_SCALING_DEBUG:
                            logger.debug(f"Captured OBS window {obs_img.width}x{obs_img.height}. Offset: ({final_off_x}, {final_off_y})")
                        self.ss_width = obs_img.width
                        self.ss_height = obs_img.height
                        return obs_img, final_off_x, final_off_y, monitor_w, monitor_h
                except Exception as e:
                    logger.debug(f"OBS Window capture failed, falling back to MSS: {e}")

        wayland = is_wayland()
        
        if mss and not wayland:
            try:
                with mss.mss() as sct:
                    sct_img = sct.grab(monitor)
                    img = Image.frombytes('RGB', sct_img.size, sct_img.bgra, 'raw', 'BGRX')
                    if CONVERT_TO_GRAYSCALE:
                        img = img.convert('L')
                    if SAVE_DEBUG_IMAGES:
                        img.save(os.path.join(get_temporary_directory(), "latest_overlay_screenshot.png"))
                    self.ss_width = img.width
                    self.ss_height = img.height
                    return img, 0, 0, monitor_w, monitor_h
            except Exception as e:
                logger.debug(f"MSS screenshot failed: {e}")

        try:
            logger.debug("Attempting fallback screenshot via OBS sources (Full Scene)")
            obs_img = get_screenshot_PIL(compression=90, img_format='jpg', width=None, height=None)
            if obs_img:
                if CONVERT_TO_GRAYSCALE:
                    obs_img = obs_img.convert('L')
                if SAVE_DEBUG_IMAGES:
                    obs_img.save(os.path.join(get_temporary_directory(), "latest_overlay_screenshot.png"))
                self.ss_width = obs_img.width
                self.ss_height = obs_img.height
                return obs_img, 0, 0, monitor_w, monitor_h
        except Exception as e:
            logger.debug(f"OBS fallback screenshot failed: {e}")

        raise RuntimeError("Failed to capture screen.")

    def _create_composite_image(
        self, 
        full_screenshot: Image.Image,
        crop_coords_list: List[Tuple[int, int, int, int]],
        monitor_width: int,
        monitor_height: int,
        source: str = None
    ) -> Image.Image:
        """Creates a new image by pasting cropped text regions onto a transparent background."""
        if not crop_coords_list:
            return full_screenshot

        composite_img = Image.new("RGBA", (full_screenshot.width, full_screenshot.height), (0, 0, 0, 0))

        for crop_coords in crop_coords_list:
            x1, y1, x2, y2, = crop_coords[:4]
            x1 = max(0, min(x1, full_screenshot.width))
            y1 = max(0, min(y1, full_screenshot.height))
            x2 = max(x1, min(x2, full_screenshot.width))
            y2 = max(y1, min(y2, full_screenshot.height))
            
            if x1 >= x2 or y1 >= y2:
                continue
            try:
                cropped_image = full_screenshot.crop((x1, y1, x2, y2))
            except ValueError:
                continue
                
            paste_x = math.floor(x1)
            paste_y = math.floor(y1)
            composite_img.paste(cropped_image, (paste_x, paste_y))
            
        if SAVE_DEBUG_IMAGES:
            composite_img.save(os.path.join(get_temporary_directory(), "latest_overlay_screenshot_trimmed.png"))
        
        return composite_img

    def _resolve_overlay_geometry(
        self,
        fallback_width: int,
        fallback_height: int,
    ) -> Tuple[int, int, int, int, int, int, Optional[Dict[str, Any]]]:
        monitor = self.get_monitor_workarea(get_overlay_config().monitor_to_capture)
        monitor_w, monitor_h = monitor["width"], monitor["height"]

        off_x, off_y = 0, 0
        content_w = int(fallback_width or monitor_w)
        content_h = int(fallback_height or monitor_h)

        if is_windows() and self.window_monitor and self.window_monitor.target_hwnd:
            hwnd = self.window_monitor.target_hwnd
            if user32.IsWindowVisible(hwnd) and not user32.IsIconic(hwnd):
                raw_off_x, raw_off_y = get_window_client_screen_offset(hwnd)
                off_x = int(raw_off_x - monitor["left"])
                off_y = int(raw_off_y - monitor["top"])

                client_rect = wintypes.RECT()
                if user32.GetClientRect(hwnd, ctypes.byref(client_rect)):
                    content_w = max(1, int(client_rect.right))
                    content_h = max(1, int(client_rect.bottom))
        elif is_windows() and self.window_monitor:
            hwnd = self.window_monitor.find_target_hwnd()
            if hwnd and user32.IsWindowVisible(hwnd) and not user32.IsIconic(hwnd):
                raw_off_x, raw_off_y = get_window_client_screen_offset(hwnd)
                off_x = int(raw_off_x - monitor["left"])
                off_y = int(raw_off_y - monitor["top"])

                client_rect = wintypes.RECT()
                if user32.GetClientRect(hwnd, ctypes.byref(client_rect)):
                    content_w = max(1, int(client_rect.right))
                    content_h = max(1, int(client_rect.bottom))

        magpie_info = None
        if self.window_monitor:
            magpie_info = self.window_monitor.magpie_info
            magpie_info = self._normalize_magpie_coordinate_space(
                magpie_info,
                source_width_hint=float(content_w),
                source_height_hint=float(content_h),
            )

        return off_x, off_y, content_w, content_h, monitor_w, monitor_h, magpie_info

    def _convert_source_space_results_to_percentages(
        self,
        source_results: List[Dict[str, Any]],
        source_width: int,
        source_height: int,
        target_width: int,
        target_height: int,
        monitor_width: int,
        monitor_height: int,
        offset_x: int = 0,
        offset_y: int = 0,
        magpie_info: Optional[Dict[str, Any]] = None,
    ) -> List[Dict[str, Any]]:
        if not source_results:
            return []

        source_w = float(max(1, source_width))
        source_h = float(max(1, source_height))
        target_w = float(max(1, target_width))
        target_h = float(max(1, target_height))
        monitor_w = float(max(1, monitor_width))
        monitor_h = float(max(1, monitor_height))
        scale_x = target_w / source_w
        scale_y = target_h / source_h

        converted_results = []
        for line in source_results:
            bbox = line.get("bounding_rect", {})
            if not bbox:
                continue

            line_copy = {
                "text": line.get("text", ""),
                "bounding_rect": dict(bbox),
                "words": copy.deepcopy(line.get("words", [])),
            }

            def transform_box(box):
                for key, value in list(box.items()):
                    try:
                        raw_value = float(value)
                    except (TypeError, ValueError):
                        raw_value = 0.0
                    if "x" in key:
                        abs_coord = (raw_value * scale_x) + float(offset_x)
                        abs_coord, _ = self._adjust_coords_for_magpie(abs_coord, 0, magpie_info)
                        box[key] = abs_coord / monitor_w
                    else:
                        abs_coord = (raw_value * scale_y) + float(offset_y)
                        _, abs_coord = self._adjust_coords_for_magpie(0, abs_coord, magpie_info)
                        box[key] = abs_coord / monitor_h

            transform_box(line_copy["bounding_rect"])
            for word in line_copy.get("words", []):
                word_bbox = word.get("bounding_rect", {})
                if word_bbox:
                    transform_box(word_bbox)

            converted_results.append(line_copy)

        return converted_results

    def _convert_absolute_screen_results_to_percentages(
        self,
        source_results: List[Dict[str, Any]],
        monitor_left: int,
        monitor_top: int,
        monitor_width: int,
        monitor_height: int,
        capture_origin_x: int = 0,
        capture_origin_y: int = 0,
    ) -> List[Dict[str, Any]]:
        if not source_results:
            return []

        monitor_w = float(max(1, monitor_width))
        monitor_h = float(max(1, monitor_height))
        left = float(monitor_left)
        top = float(monitor_top)
        origin_x = float(capture_origin_x)
        origin_y = float(capture_origin_y)
        converted = []

        for line in source_results:
            bbox = line.get("bounding_rect", {})
            if not bbox:
                continue

            line_copy = {
                "text": line.get("text", ""),
                "bounding_rect": dict(bbox),
                "words": copy.deepcopy(line.get("words", [])),
            }

            def transform_box(box):
                for key, value in list(box.items()):
                    try:
                        raw_value = float(value)
                    except (TypeError, ValueError):
                        raw_value = 0.0
                    if "x" in key:
                        abs_coord = raw_value + origin_x
                        box[key] = (abs_coord - left) / monitor_w
                    else:
                        abs_coord = raw_value + origin_y
                        box[key] = (abs_coord - top) / monitor_h

            transform_box(line_copy["bounding_rect"])
            for word in line_copy.get("words", []):
                word_bbox = word.get("bounding_rect", {})
                if word_bbox:
                    transform_box(word_bbox)

            converted.append(line_copy)

        return converted

    async def _try_send_precomputed_overlay_payload(self, dict_from_ocr, sentence_to_check: Optional[str]) -> bool:
        if not isinstance(dict_from_ocr, dict):
            return False
        if dict_from_ocr.get("schema") != "gsm_overlay_coords_v1":
            return False

        source_lines = dict_from_ocr.get("lines", [])
        if not isinstance(source_lines, list) or not source_lines:
            return False

        coord_space = dict_from_ocr.get("coordinate_space", {})
        if not isinstance(coord_space, dict):
            return False

        try:
            source_w = max(1, int(coord_space.get("source_width", 0)))
            source_h = max(1, int(coord_space.get("source_height", 0)))
        except (TypeError, ValueError):
            return False
        mode = str(coord_space.get("mode") or "source_content")
        capture_origin = coord_space.get("capture_origin") if isinstance(coord_space.get("capture_origin"), dict) else {}
        capture_origin_x = int(capture_origin.get("x", 0))
        capture_origin_y = int(capture_origin.get("y", 0))
        monitor = self.get_monitor_workarea(get_overlay_config().monitor_to_capture)
        monitor_w, monitor_h = monitor["width"], monitor["height"]

        if mode == "absolute_screen":
            off_x, off_y, content_w, content_h, magpie_info = 0, 0, source_w, source_h, None
        else:
            off_x, off_y, content_w, content_h, monitor_w, monitor_h, magpie_info = self._resolve_overlay_geometry(
                source_w,
                source_h,
            )

        corrected_source_lines = copy.deepcopy(source_lines)
        if sentence_to_check:
            corrected_source_lines = self._correct_ocr_with_backlog(corrected_source_lines, sentence_to_check)

        if mode == "absolute_screen":
            final_data = self._convert_absolute_screen_results_to_percentages(
                corrected_source_lines,
                monitor_left=monitor["left"],
                monitor_top=monitor["top"],
                monitor_width=monitor_w,
                monitor_height=monitor_h,
                capture_origin_x=capture_origin_x,
                capture_origin_y=capture_origin_y,
            )
        else:
            final_data = self._convert_source_space_results_to_percentages(
                corrected_source_lines,
                source_w,
                source_h,
                content_w,
                content_h,
                monitor_w,
                monitor_h,
                offset_x=off_x,
                offset_y=off_y,
                magpie_info=magpie_info,
            )
        if not final_data:
            return False

        self.last_raw_results = {
            "lines": copy.deepcopy(corrected_source_lines),
            "coordinate_space": {
                "source_width": source_w,
                "source_height": source_h,
                "mode": mode,
                "capture_origin": {"x": capture_origin_x, "y": capture_origin_y},
            },
        }
        self.last_raw_source = "precomputed"
        self.last_img_dimensions = (source_w, source_h)
        self.last_scan_window_offset = (off_x, off_y)

        payload = {
            "type": "word_coordinates",
            "data": final_data,
            "is_sentence_recycled": self.sentence_is_recycled,
        }
        await send_word_coordinates_to_overlay(payload)
        logger.info(
            "Overlay OCR bypass: used precomputed OCR coordinates ({} text boxes).",
            len(final_data),
        )
        return True
    
    def get_image_to_ocr(self) -> Image.Image | None:
        full_screenshot, off_x, off_y, monitor_width, monitor_height = self._get_screenshot_and_offset()
        
        if not full_screenshot:
            logger.warning("Failed to get a screenshot.")
            return None
            
        if asyncio.current_task().cancelled():
            raise asyncio.CancelledError()
        
        if get_overlay_config().use_ocr_area_config:
            overlay_config = self._get_scaled_overlay_ocr_config(self.ss_width, self.ss_height)
            if overlay_config:
                full_screenshot, crop_offset = apply_ocr_config_to_image(full_screenshot, overlay_config, both_types=True, return_full_size=True)
            
                off_x += crop_offset[0]
                off_y += crop_offset[1]

                if SAVE_DEBUG_IMAGES:
                    full_screenshot.save(os.path.join(get_temporary_directory(), "latest_overlay_screenshot_with_config.png"))
        
        # Apply scaling based on SCALE_TYPE
        original_width, original_height = full_screenshot.size
        
        # Check if image needs scaling (either first time or dimensions changed)
        needs_scaling = (
            self.obs_width is None or 
            self.obs_height is None or 
            original_width != self.obs_width or 
            original_height != self.obs_height
        )
        
        if self.ENABLE_SCALING_DEBUG:
            logger.debug(f"Scaling check: original={original_width}x{original_height}, cached={self.obs_width}x{self.obs_height}, needs_scaling={needs_scaling}")

        scaled: Optional[ScaledSize] = None

        if needs_scaling:
            scaled = scale_dimensions_by_aspect_buckets(
                original_width,
                original_height,
                allow_upscale=True
            )

        if scaled and (scaled.width != original_width or scaled.height != original_height):
            self.calculated_width_scale_factor = scaled.scale_x
            self.calculated_height_scale_factor = scaled.scale_y
            full_screenshot = scale_pil_image(full_screenshot, scaled, resample=Image.Resampling.BILINEAR)
            self.obs_width = scaled.width
            self.obs_height = scaled.height
            if self.window_monitor:
                self.window_monitor.last_obs_dimensions_time = time.time()
            if self.ENABLE_SCALING_DEBUG:
                logger.debug(
                    f"Scaled screenshot ({self.SCALE_TYPE}) from {original_width}x{original_height} "
                    f"to {scaled.width}x{scaled.height} (factors: {self.calculated_width_scale_factor:.3f}, {self.calculated_height_scale_factor:.3f})"
                )
            if SAVE_DEBUG_IMAGES:
                full_screenshot.save(os.path.join(get_temporary_directory(), "latest_overlay_screenshot_scaled.png"))
        elif not needs_scaling:
            # Image is already at cached scaled size, keep existing scale factors
            if self.ENABLE_SCALING_DEBUG:
                logger.debug(f"Using cached dimensions {self.obs_width}x{self.obs_height}, scale factors: {self.calculated_width_scale_factor:.3f}x{self.calculated_height_scale_factor:.3f}")
        else:
            # No scaling was applied (shouldn't happen but fallback)
            self.calculated_width_scale_factor = 1.0
            self.calculated_height_scale_factor = 1.0
            
        return full_screenshot, off_x, off_y, monitor_width, monitor_height

    async def _do_work(self, line: 'GameLine' = None, check_against_last: bool = False, custom_threshold: float = None, dict_from_ocr = None, local_ocr_retry = 5, source: TextSource = None) -> Tuple[List[Dict[str, Any]], int]:
        """The main OCR workflow with cancellation support."""
        # logger.background("Finding text for overlay...")
        start_time = datetime.now()
        timing_start = time.time()
        effective_engine = self._get_effective_engine()
        
        if self.ENABLE_DETAILED_TIMING:
            logger.info("Starting OCR workflow timing")
        
        op_start = time.time()
        self.sentence_is_recycled = self._is_sentence_recycled(line.text) if line else False
        sentence_to_check = line.text.replace(" ", "").replace("\t", "").replace("\n", "").replace("\r", "") if line else None
        self._log_timing(op_start, "Sentence preprocessing and recycling check")

        if dict_from_ocr:
            op_start = time.time()
            used_precomputed = await self._try_send_precomputed_overlay_payload(dict_from_ocr, sentence_to_check)
            self._log_timing(op_start, "Use precomputed OCR metadata")
            if used_precomputed:
                return []
        
        if not self.lens and not self.oneocr and not self.meikiocr:
            logger.error("OCR engines are not initialized. Cannot perform OCR for Overlay.")
            self.init()
            return []
        
        # if get_config().overlay.scan_delay > 0:
        #     await asyncio.sleep(get_config().overlay.scan_delay)

        if asyncio.current_task().cancelled():
            raise asyncio.CancelledError()

        op_start = time.time()
        full_screenshot, off_x, off_y, monitor_width, monitor_height = self.get_image_to_ocr()
        if not full_screenshot:
            return []
        self._log_timing(op_start, f"Screenshot capture (width: {full_screenshot.width}, height: {full_screenshot.height})")
        
        local_ocr_engine = self.oneocr or self.meikiocr
        crop_coords_list = []
        oneocr_final = []
        if local_ocr_engine:
            # Assume Text from Source is already Stable
            source = line.source if line and line.source else source
            tries = max(1, 1 if source in [TextSource.OCR, TextSource.HOTKEY, TextSource.SCREEN_CROPPER, TextSource.SECONDARY, TextSource.MANUAL, TextSource.OCR_MANUAL] else local_ocr_retry)
            # logger.background(f"Using local OCR engine '{local_ocr_engine.readable_name}' with {tries} tries for overlay. TextSource: {line.source if line else source or 'N/A'}")
            last_result_flattened = ""
            last_scan_time = None
            total_ocr_time = 0  # Track actual OCR processing time
            for i in range(tries):
                if i > 0:
                    # max_sleep = 1 if i > 5 else 0.6
                    try:
                        elapsed = time.time() - last_scan_time
                        sleep_duration = max(0, 1 - elapsed)
                        
                        if sleep_duration > 0:
                            await asyncio.sleep(sleep_duration)
                        
                        # Re-capture if retrying, otherwise we are OCRing the same static image
                        full_screenshot, off_x, off_y, monitor_width, monitor_height = self.get_image_to_ocr()
                    except asyncio.CancelledError:
                        raise
                
                ocr_start = time.time()
                result = local_ocr_engine(
                    full_screenshot,
                    return_coords=True,
                    multiple_crop_coords=True,
                    return_one_box=False,
                    furigana_filter_sensitivity=get_overlay_config().minimum_character_size,
                )
                ocr_end = time.time()
                total_ocr_time += (ocr_end - ocr_start)
                last_scan_time = ocr_end
                self._log_timing(ocr_start, f"Local OCR execution (attempt {i+1}/{tries})")
                
                op_start = time.time()
                res, text, oneocr_results, crop_coords_list, crop_coords, response_dict = (list(result) + [None]*6)[:6]
                self._log_timing(op_start, "OCR result unpacking")
                
                if not res or not text:
                    continue
                
                if not crop_coords_list:
                    continue
                
                # # Early abort on blank results during retry
                # if i > 0 and not text:
                #     logger.debug("Retry returned no text, aborting further attempts")
                #     break
                
                if sentence_to_check:
                    op_start = time.time()
                    oneocr_results = self._correct_ocr_with_backlog(oneocr_results, sentence_to_check)
                    self._log_timing(op_start, "OCR correction with backlog")
                
                if asyncio.current_task().cancelled():
                    raise asyncio.CancelledError()
                
                op_start = time.time()
                text_str = "".join([t for t in text if self.regex.match(t)])
                self._log_timing(op_start, "Text filtering with regex")
                stabilized = False
                if text_str and last_result_flattened and text_str == last_result_flattened or (sentence_to_check and self.punctuation_regex.sub('', sentence_to_check) in text_str):
                    # logger.background(f"Text stabilized after {i+1} tries: {text_str}")
                    stabilized = True
                last_result_flattened = text_str
                # logger.display(f"Local OCR found text: {text_str}")
                
                if self.last_oneocr_result and check_against_last:
                    op_start = time.time()
                    # Quick length check optimization before fuzzy matching
                    if abs(len(text_str) - len(self.last_oneocr_result)) > 5:
                        score = 0
                    else:
                        if custom_threshold is not None:
                            score = fuzz.ratio(text_str, self.last_oneocr_result)
                            threshold = custom_threshold * 100
                            if score >= threshold:
                                logger.display(f"Skipping update: ratio {score}% >= {threshold}%")
                                return
                        else:
                            score = fuzz.ratio(text_str, self.last_oneocr_result)
                            if score >= get_config().overlay.periodic_ratio * 100:
                                return
                    self._log_timing(op_start, "Fuzzy matching comparison with last result")
                self.last_oneocr_result = text_str
                
                op_start = time.time()
                self.last_raw_results = copy.deepcopy(oneocr_results)
                self._log_timing(op_start, "Deep copy of OCR results")
                self.last_raw_source = 'local'
                self.last_img_dimensions = full_screenshot.size
                self.last_scan_window_offset = (off_x, off_y)
                
                op_start = time.time()
                oneocr_final = self._convert_oneocr_results_to_percentages(
                    oneocr_results, 
                    monitor_width, 
                    monitor_height,
                    off_x, off_y
                )
                self._log_timing(op_start, "Convert OCR results to percentages")

                data = {
                    "type": "word_coordinates",
                    "data": oneocr_final,
                    "is_sentence_recycled": self.sentence_is_recycled
                }
                
                send_start_time = time.time()
                await send_word_coordinates_to_overlay(data)
                self._log_timing(send_start_time, f"Send {len(oneocr_final)} word coordinates to overlay")
                
                if is_beangate:
                    op_start = time.time()
                    with open("oneocr_results.json", "w", encoding="utf-8") as f:
                        f.write(json.dumps(oneocr_final, ensure_ascii=False, indent=2))
                    self._log_timing(op_start, "Write OCR results to JSON file")

                if asyncio.current_task().cancelled():
                    raise asyncio.CancelledError()
                
                if stabilized:
                    break
                
                
            # Only return early if the effective engine is local-only (not Lens)
            # When Lens is configured, we want to continue to the Lens scan with the composite image
            if effective_engine in [OverlayEngine.ONEOCR.value, OverlayEngine.MEIKIOCR.value]:
                if not oneocr_final:
                    logger.background("Local OCR did not return any text boxes for overlay.")
                    return
                # Log completion with comprehensive details
                elapsed_ms = (datetime.now() - start_time).total_seconds() * 1000
                ocr_ms = total_ocr_time * 1000
                engine_name = local_ocr_engine.readable_name if local_ocr_engine else "Local OCR"
                
                if self.ENABLE_DETAILED_TIMING:
                    total_elapsed = (time.time() - timing_start) * 1000
                    logger.info(f"Local OCR workflow complete: {total_elapsed:.1f}ms (OCR: {ocr_ms:.1f}ms, processing: {total_elapsed - ocr_ms:.1f}ms)")
                
                logger.info(
                    "Overlay OCR complete: {} sent {} text boxes (total: {}ms, OCR: {}ms, tries: {})",
                    engine_name,
                    len(oneocr_final) if oneocr_final else 0,
                    int(elapsed_ms),
                    int(ocr_ms),
                    i + 1,
                )
                
                return
            
            if crop_coords_list:
                op_start = time.time()
                composite_image = self._create_composite_image(
                    full_screenshot, 
                    crop_coords_list, 
                    monitor_width, 
                    monitor_height
                )
                self._log_timing(op_start, f"Create composite image from {len(crop_coords_list)} crop regions")
            else:
                composite_image = None
        
        op_start = time.time()
        composite_image.save(os.path.join(get_temporary_directory(), "latest_overlay_screenshot_before_lens.png"))
        self._log_timing(op_start, "Save composite image to disk")
        
        # If we have a composite image from local OCR and lens is available, use it for lens scan
        # This handles the Local -> Lens workflow on Windows
        if not composite_image:
            composite_image = full_screenshot
        
        if asyncio.current_task().cancelled():
            raise asyncio.CancelledError()
        
        lens_start = time.time()
        result = self.lens(
            composite_image,
            return_coords=True,
            furigana_filter_sensitivity=get_overlay_config().minimum_character_size
        )
        lens_ocr_time = time.time() - lens_start
        self._log_timing(lens_start, "Google Lens OCR execution")
        
        if asyncio.current_task().cancelled():
            raise asyncio.CancelledError()
        
        op_start = time.time()
        success, text_list, coords, crop_coords_list, crop_coords, response_dict = (list(result) + [None]*6)[:6]
        self._log_timing(op_start, "Lens result unpacking")
        
        if not response_dict:
            return
        
        op_start = time.time()
        text_str = "".join([text for text in text_list if self.regex.match(text)])
        self._log_timing(op_start, "Lens text filtering with regex")
        
        if self.last_lens_result and check_against_last:
            op_start = time.time()
            if custom_threshold is not None:
                score = fuzz.partial_ratio(text_str, self.last_lens_result)
                threshold = custom_threshold * 100
                if score >= threshold:
                    logger.debug(f"Skipping Lens update: partial_ratio {score}% >= {threshold}%")
                    return
            else:
                score = fuzz.ratio(text_str, self.last_lens_result)
                if score >= get_config().overlay.periodic_ratio * 100:
                    logger.info("Google Lens results are similar to the last results (score: %d). Skipping overlay update.", score)
                    return
            self._log_timing(op_start, "Fuzzy matching comparison with last Lens result")
        self.last_lens_result = text_str

        if not success or not response_dict:
            return
        
        if asyncio.current_task().cancelled():
            raise asyncio.CancelledError()
        
        op_start = time.time()
        self.last_raw_results = copy.deepcopy(response_dict)
        self._log_timing(op_start, "Deep copy of Lens response dict")
        self.last_raw_source = 'lens'
        self.last_img_dimensions = composite_image.size
        self.last_scan_window_offset = (off_x, off_y)

        # Get current magpie info for coordinate adjustment
        magpie_info = None
        if hasattr(self, 'window_monitor') and self.window_monitor:
            magpie_info = self.window_monitor.magpie_info

        op_start = time.time()
        extracted_data = self._extract_text_with_pixel_boxes(
            api_response=response_dict,
            original_width=monitor_width,
            original_height=monitor_height,
            crop_x=off_x,
            crop_y=off_y,
            crop_width=composite_image.width,
            crop_height=composite_image.height,
            use_percentages=True,
            magpie_info=magpie_info
        )
        self._log_timing(op_start, "Extract text with pixel boxes from Lens response")

        if sentence_to_check:
            op_start = time.time()
            extracted_data = self._correct_ocr_with_backlog(extracted_data, sentence_to_check)
            self._log_timing(op_start, "Lens OCR correction with backlog")
            
        data = {
            "type": "word_coordinates",
            "data": extracted_data,
            "is_sentence_recycled": self.sentence_is_recycled
        }

        op_start = time.time()
        await send_word_coordinates_to_overlay(data)
        self._log_timing(op_start, f"Send {len(extracted_data)} Lens word coordinates to overlay")
        
        # Log completion with comprehensive details
        elapsed_ms = (datetime.now() - start_time).total_seconds() * 1000
        ocr_ms = lens_ocr_time * 1000
        engine_name = "Google Lens"
        
        if self.ENABLE_DETAILED_TIMING:
            total_elapsed = (time.time() - timing_start) * 1000
            logger.info(f"Google Lens workflow complete: {total_elapsed:.1f}ms (OCR: {ocr_ms:.1f}ms, processing: {total_elapsed - ocr_ms:.1f}ms)")
        
        logger.info(
            "Overlay OCR complete: {} sent {} text boxes (total: {}ms, OCR: {}ms)",
            engine_name,
            len(extracted_data),
            int(elapsed_ms),
            int(ocr_ms),
        )
        

    async def reprocess_and_send_last_results(self):
        """Reprocesses the last known raw OCR results with updated window coordinates."""
        if not self.last_raw_results or not self.last_raw_source:
            logger.debug("No previous OCR results to reprocess.")
            return

        monitor = self.get_monitor_workarea(get_overlay_config().monitor_to_capture)
        monitor_w, monitor_h = monitor['width'], monitor['height']

        off_x, off_y = 0, 0
        current_content_w, current_content_h = self.last_img_dimensions

        if is_windows() and self.window_monitor and self.window_monitor.target_hwnd:
            hwnd = self.window_monitor.target_hwnd
            if user32.IsWindowVisible(hwnd) and not user32.IsIconic(hwnd):
                raw_off_x, raw_off_y = get_window_client_screen_offset(hwnd)
                off_x = raw_off_x - monitor['left']
                off_y = raw_off_y - monitor['top']
                
                client_rect = wintypes.RECT()
                if user32.GetClientRect(hwnd, ctypes.byref(client_rect)):
                    current_content_w = client_rect.right
                    current_content_h = client_rect.bottom

        logger.debug(f"Reprocessing overlay with current offset: ({off_x}, {off_y})")

        # Get current magpie info for coordinate adjustment
        magpie_info = None
        if hasattr(self, 'window_monitor') and self.window_monitor:
            magpie_info = self.window_monitor.magpie_info
            logger.debug(f"Reprocessing with magpie_info: {magpie_info}")

        final_data = []

        if self.last_raw_source == 'local':
            final_data = self._convert_oneocr_results_to_percentages(
                copy.deepcopy(self.last_raw_results),
                monitor_w,
                monitor_h,
                off_x, off_y
            )
            
        elif self.last_raw_source == 'lens':
            final_data = self._extract_text_with_pixel_boxes(
                api_response=copy.deepcopy(self.last_raw_results),
                original_width=monitor_w,
                original_height=monitor_h,
                crop_x=off_x,
                crop_y=off_y,
                crop_width=current_content_w,
                crop_height=current_content_h,
                use_percentages=True,
                magpie_info=magpie_info
            )
        elif self.last_raw_source == 'precomputed':
            payload = self.last_raw_results if isinstance(self.last_raw_results, dict) else {}
            source_lines = copy.deepcopy(payload.get("lines", []))
            coord_space = payload.get("coordinate_space", {}) if isinstance(payload.get("coordinate_space"), dict) else {}
            source_w = int(coord_space.get("source_width", self.last_img_dimensions[0] or current_content_w or 1))
            source_h = int(coord_space.get("source_height", self.last_img_dimensions[1] or current_content_h or 1))
            mode = str(coord_space.get("mode") or "source_content")
            if mode == "absolute_screen":
                capture_origin = coord_space.get("capture_origin") if isinstance(coord_space.get("capture_origin"), dict) else {}
                final_data = self._convert_absolute_screen_results_to_percentages(
                    source_lines,
                    monitor_left=monitor["left"],
                    monitor_top=monitor["top"],
                    monitor_width=monitor_w,
                    monitor_height=monitor_h,
                    capture_origin_x=int(capture_origin.get("x", 0)),
                    capture_origin_y=int(capture_origin.get("y", 0)),
                )
            else:
                normalized_magpie_info = self._normalize_magpie_coordinate_space(
                    magpie_info,
                    source_width_hint=float(current_content_w),
                    source_height_hint=float(current_content_h),
                )
                final_data = self._convert_source_space_results_to_percentages(
                    source_lines,
                    source_w,
                    source_h,
                    current_content_w,
                    current_content_h,
                    monitor_w,
                    monitor_h,
                    offset_x=off_x,
                    offset_y=off_y,
                    magpie_info=normalized_magpie_info,
                )

        if final_data:
            data = {
                "type": "word_coordinates",
                "data": final_data,
                "is_sentence_recycled": self.sentence_is_recycled
            }
            await send_word_coordinates_to_overlay(data)
            logger.info("Resent {} text boxes with updated coordinates.", len(final_data))


    def _correct_ocr_with_backlog(self, ocr_results: List[Dict[str, Any]], current_sentence: str) -> List[Dict[str, Any]]:
        if not current_sentence or not ocr_results:
            return ocr_results
        
        ocr_text = "".join([line.get('text', '') for line in ocr_results])
        sentences_to_remove = []
        
        for past_sentence in self.last_sentences:
            current_similarity = fuzz.partial_ratio(past_sentence, current_sentence)
            if current_similarity >= 50:
                continue 
            
            ocr_similarity = fuzz.partial_ratio(past_sentence, ocr_text)
            if ocr_similarity >= 80:
                logger.debug(f"Applying OCR correction with past sentence")
                ocr_results, _ = self._correct_ocr_text(ocr_results, past_sentence)
                
                if self.remove_used_sentences:
                    sentences_to_remove.append(past_sentence)
        
        if self.remove_used_sentences and sentences_to_remove:
            for sentence in sentences_to_remove:
                if sentence in self.last_sentences:
                    self.last_sentences.remove(sentence)
        
        ocr_results, current_changes = self._correct_ocr_text(ocr_results, current_sentence)
        
        self.last_sentences.append(current_sentence)
        if len(self.last_sentences) > self.sentence_backlog_max_size:
            self.last_sentences.pop(0)
        
        # Log summary of corrections
        corrected_text = "".join([line.get('text', '') for line in ocr_results])
        if corrected_text != ocr_text and current_changes:
            changes_str = ", ".join([f"'{c['old']}'->'{c['new']}'" for c in current_changes])
            logger.debug(f"OCR corrections: {changes_str} (using {len(sentences_to_remove)} past sentences + current)")
        
        return ocr_results

    def _correct_ocr_text(self, ocr_results: List[Dict[str, Any]], sentence: str) -> Tuple[List[Dict[str, Any]], List[Dict[str, str]]]:
        if not sentence or not ocr_results:
            return ocr_results, []

        FLIPPABLE_PAIRS = [('冗', '談'), ('痙', '攣')]

        flat_ocr_chars = []
        char_map = {} 
        current_idx = 0
        word_buffers = {}
        changes = []  # Track all changes

        for l_idx, line in enumerate(ocr_results):
            words = line.get('words', [])
            if words:
                for w_idx, word in enumerate(words):
                    text = word.get('text', '')
                    word_buffers[(l_idx, w_idx)] = list(text)
                    for c_idx, char in enumerate(text):
                        flat_ocr_chars.append(char)
                        char_map[current_idx] = (l_idx, w_idx, c_idx)
                        current_idx += 1
            else:
                text = line.get('text', '')
                word_buffers[(l_idx, -1)] = list(text)
                for c_idx, char in enumerate(text):
                    flat_ocr_chars.append(char)
                    char_map[current_idx] = (l_idx, -1, c_idx)
                    current_idx += 1
        
        flat_ocr_str = "".join(flat_ocr_chars)
        
        for char1, char2 in FLIPPABLE_PAIRS:
            flipped = char2 + char1
            correct = char1 + char2
            if flipped in flat_ocr_str and correct in sentence:
                idx = 0
                while idx < len(flat_ocr_str) - 1:
                    if flat_ocr_str[idx] == char2 and flat_ocr_str[idx + 1] == char1:
                        if idx in char_map and (idx + 1) in char_map:
                            l1, w1, c1 = char_map[idx]
                            l2, w2, c2 = char_map[idx + 1]
                            old_pair = char2 + char1
                            new_pair = char1 + char2
                            changes.append({"old": old_pair, "new": new_pair})
                            word_buffers[(l1, w1)][c1], word_buffers[(l2, w2)][c2] = \
                                word_buffers[(l2, w2)][c2], word_buffers[(l1, w1)][c1]
                            flat_ocr_chars[idx], flat_ocr_chars[idx + 1] = \
                                flat_ocr_chars[idx + 1], flat_ocr_chars[idx]
                    idx += 1
        
        flat_ocr_str = "".join(flat_ocr_chars)
        matcher = difflib.SequenceMatcher(None, flat_ocr_str, sentence)
        
        for tag, i1, i2, j1, j2 in matcher.get_opcodes():
            if tag == 'replace':
                if (i2 - i1) == (j2 - j1):
                    correct_segment = sentence[j1:j2]
                    for k, new_char in enumerate(correct_segment):
                        flat_idx = i1 + k
                        if flat_idx in char_map:
                            l, w, c = char_map[flat_idx]
                            old_char = word_buffers[(l, w)][c]
                            if old_char != new_char:
                                changes.append({"old": old_char, "new": new_char})
                            word_buffers[(l, w)][c] = new_char
            elif tag == 'insert':
                missing_segment = sentence[j1:j2]
                if i1 > 0 and flat_ocr_str[i1 - 1] == '「':
                    if j1 > 0 and sentence[j1 - 1] == '「':
                        if i1 in char_map:
                            l, w, c = char_map[i1]
                            for insert_char in reversed(missing_segment):
                                changes.append({"old": "", "new": insert_char})
                                word_buffers[(l, w)].insert(c, insert_char)

        for (l, w), char_list in word_buffers.items():
            new_text = "".join(char_list)
            if w == -1:
                ocr_results[l]['text'] = new_text
            else:
                ocr_results[l]['words'][w]['text'] = new_text
                
        for line in ocr_results:
            if line.get('words'):
                line['text'] = "".join([wd['text'] for wd in line['words']])
                
        return ocr_results, changes

    def _extract_text_with_pixel_boxes(
        self,
        api_response: Dict[str, Any],
        original_width: int,
        original_height: int,
        crop_x: int,
        crop_y: int,
        crop_width: int,
        crop_height: int,
        use_percentages: bool,
        magpie_info: Optional[Dict[str, Any]] = None
    ) -> List[Dict[str, Any]]:
        """Parses Google Lens API response and converts normalized coordinates to absolute pixel coordinates."""
        results = []
        try:
            paragraphs = api_response["objects_response"]["text"]["text_layout"]["paragraphs"]
        except (KeyError, TypeError):
            return []

        target_w_hint, target_h_hint = self._get_target_client_size_hint()

        normalized_magpie_info = self._normalize_magpie_coordinate_space(
            magpie_info,
            source_width_hint=target_w_hint,
            source_height_hint=target_h_hint,
        )

        for para in paragraphs:
            for line in para.get("lines", []):
                line_text_parts = []
                word_list = []

                for word in line.get("words", []):
                    if self.ocr_language not in ['ja', 'zh', 'ko', 'th', 'lo', 'km', 'my', 'bo']:
                        word["plain_text"] += word["text_separator"]
                    word_text = word.get("plain_text", "")
                    line_text_parts.append(word_text)
                    
                    word_box = self._convert_box_to_overlay_coords(
                        word["geometry"]["bounding_box"],
                        crop_x, crop_y, crop_width, crop_height,
                        use_percentage=False
                    )
                    
                    if use_percentages:
                        # Apply Magpie adjustments before converting to percentages
                        if normalized_magpie_info:
                            for key in word_box.keys():
                                if "x" in key:
                                    word_box[key], _ = self._adjust_coords_for_magpie(word_box[key], 0, normalized_magpie_info)
                                else:  # "y" in key
                                    _, word_box[key] = self._adjust_coords_for_magpie(0, word_box[key], normalized_magpie_info)
                        
                        word_box = {
                            key: (value / original_width if "x" in key else value / original_height)
                            for key, value in word_box.items()
                        }
                    
                    word_list.append({
                        "text": word_text,
                        "bounding_rect": word_box
                    })
                
                if not line_text_parts:
                    continue
                
                full_line_text = "".join(line_text_parts)
                line_box = self._convert_box_to_overlay_coords(
                    line["geometry"]["bounding_box"],
                    crop_x, crop_y, crop_width, crop_height, 
                    use_percentage=False
                )

                if use_percentages:
                    # Apply Magpie adjustments before converting to percentages
                    if normalized_magpie_info:
                        for key in line_box.keys():
                            if "x" in key:
                                line_box[key], _ = self._adjust_coords_for_magpie(line_box[key], 0, normalized_magpie_info)
                            else:  # "y" in key
                                _, line_box[key] = self._adjust_coords_for_magpie(0, line_box[key], normalized_magpie_info)
                    
                    line_box = {
                        key: (value / original_width if "x" in key else value / original_height)
                        for key, value in line_box.items()
                    }

                results.append({
                    "text": full_line_text,
                    "bounding_rect": line_box,
                    "words": word_list
                })
        return results

    def _get_target_client_size_hint(self) -> Tuple[Optional[float], Optional[float]]:
        """Returns target client size in pixels when available."""
        if not is_windows() or not self.window_monitor or not self.window_monitor.target_hwnd:
            return None, None

        try:
            hwnd = self.window_monitor.target_hwnd
            if not user32.IsWindowVisible(hwnd) or user32.IsIconic(hwnd):
                return None, None

            client_rect = wintypes.RECT()
            if not user32.GetClientRect(hwnd, ctypes.byref(client_rect)):
                return None, None

            width = float(max(0, client_rect.right - client_rect.left))
            height = float(max(0, client_rect.bottom - client_rect.top))
            if width <= 0 or height <= 0:
                return None, None
            return width, height
        except Exception:
            return None, None

    def _normalize_magpie_coordinate_space(
        self,
        magpie_info: Optional[Dict[str, Any]],
        source_width_hint: Optional[float] = None,
        source_height_hint: Optional[float] = None,
    ) -> Optional[Dict[str, Any]]:
        """
        Normalizes Magpie coordinates to the same pixel space as OCR/screenshot coordinates.

        On Windows with non-100% scaling, Magpie edge props can be returned in a different
        coordinate space than MSS/OBS screenshots. We infer an optional DPI factor only when
        confidence is high and leave values unchanged otherwise.
        """
        if not magpie_info:
            return None

        keys = (
            "magpieWindowTopEdgePosition",
            "magpieWindowBottomEdgePosition",
            "magpieWindowLeftEdgePosition",
            "magpieWindowRightEdgePosition",
            "sourceWindowLeftEdgePosition",
            "sourceWindowTopEdgePosition",
            "sourceWindowRightEdgePosition",
            "sourceWindowBottomEdgePosition",
        )

        normalized = dict(magpie_info)

        def _as_float(value: Any) -> float:
            try:
                return float(value)
            except (TypeError, ValueError):
                return 0.0

        numeric = {key: _as_float(magpie_info.get(key, 0)) for key in keys}
        src_width = numeric["sourceWindowRightEdgePosition"] - numeric["sourceWindowLeftEdgePosition"]
        src_height = numeric["sourceWindowBottomEdgePosition"] - numeric["sourceWindowTopEdgePosition"]
        dst_width = numeric["magpieWindowRightEdgePosition"] - numeric["magpieWindowLeftEdgePosition"]
        dst_height = numeric["magpieWindowBottomEdgePosition"] - numeric["magpieWindowTopEdgePosition"]

        if src_width <= 0 or src_height <= 0 or dst_width <= 0 or dst_height <= 0:
            return normalized

        references: List[Tuple[str, float]] = []
        if source_width_hint and source_width_hint > 0:
            references.append(("src_w", float(source_width_hint)))
        if source_height_hint and source_height_hint > 0:
            references.append(("src_h", float(source_height_hint)))

        if not references:
            return normalized

        candidate_scales = (1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 3.0)

        def _normalized_error(scale: float) -> float:
            scaled_src_w = src_width * scale
            scaled_src_h = src_height * scale
            scaled_dst_w = dst_width * scale
            scaled_dst_h = dst_height * scale

            total = 0.0
            for ref_key, ref_value in references:
                if ref_key == "src_w":
                    value = scaled_src_w
                elif ref_key == "src_h":
                    value = scaled_src_h
                elif ref_key == "dst_w":
                    value = scaled_dst_w
                else:
                    value = scaled_dst_h
                total += abs(value - ref_value) / max(ref_value, 1.0)
            return total / len(references)

        base_error = _normalized_error(1.0)
        best_scale = min(candidate_scales, key=_normalized_error)
        best_error = _normalized_error(best_scale)
        error_improvement = base_error - best_error

        if best_scale > 1.01 and best_error < 0.35 and error_improvement >= 0.08:
            for key in keys:
                normalized[key] = numeric[key] * best_scale
            if self.ENABLE_SCALING_DEBUG:
                logger.debug(
                    f"Normalized Magpie coordinate space by {best_scale:.2f}x "
                    f"(base_err={base_error:.3f}, best_err={best_error:.3f})"
                )

        return normalized
    
    def _adjust_coords_for_magpie(self, x: float, y: float, magpie_info: Optional[Dict[str, Any]]) -> Tuple[float, float]:
        """Adjusts screen coordinates based on Magpie scaling."""
        if not magpie_info:
            return x, y
        
        try:
            src_left = magpie_info.get('sourceWindowLeftEdgePosition', 0)
            src_top = magpie_info.get('sourceWindowTopEdgePosition', 0)
            src_right = magpie_info.get('sourceWindowRightEdgePosition', 0)
            src_bottom = magpie_info.get('sourceWindowBottomEdgePosition', 0)
            
            dst_left = magpie_info.get('magpieWindowLeftEdgePosition', 0)
            dst_top = magpie_info.get('magpieWindowTopEdgePosition', 0)
            dst_right = magpie_info.get('magpieWindowRightEdgePosition', 0)
            dst_bottom = magpie_info.get('magpieWindowBottomEdgePosition', 0)
            
            src_width = src_right - src_left
            src_height = src_bottom - src_top
            dst_width = dst_right - dst_left
            dst_height = dst_bottom - dst_top
            
            if src_width <= 0 or src_height <= 0:
                return x, y
            
            scale_x = dst_width / src_width
            scale_y = dst_height / src_height
            
            rel_x = x - src_left
            rel_y = y - src_top
            
            final_x = (rel_x * scale_x) + dst_left
            final_y = (rel_y * scale_y) + dst_top
            
            return final_x, final_y
        except Exception as e:
            return x, y

    def _convert_box_to_overlay_coords(
        self,
        bbox_data: Dict[str, float],
        crop_x: int,
        crop_y: int,
        crop_width: int,
        crop_height: int,
        use_percentage: bool
    ) -> Dict[str, float]:
        cx, cy = bbox_data['center_x'], bbox_data['center_y']
        w, h = bbox_data['width'], bbox_data['height']
        
        inverse_width_scale = 1.0 / self.calculated_width_scale_factor if self.calculated_width_scale_factor != 0 else 1.0
        inverse_height_scale = 1.0 / self.calculated_height_scale_factor if self.calculated_height_scale_factor != 0 else 1.0

        if use_percentage:
            box_width = w
            box_height = h
            center_x = cx
            center_y = cy
        else:
            effective_crop_width = crop_width * inverse_width_scale
            effective_crop_height = crop_height * inverse_height_scale
            
            box_width = w * effective_crop_width
            box_height = h * effective_crop_height

            center_x = (cx * effective_crop_width) + crop_x
            center_y = (cy * effective_crop_height) + crop_y

        half_w, half_h = box_width / 2, box_height / 2
        return {
            "x1": center_x - half_w, "y1": center_y - half_h,
            "x2": center_x + half_w, "y2": center_y - half_h,
            "x3": center_x + half_w, "y3": center_y + half_h,
            "x4": center_x - half_w, "y4": center_y + half_h,
        }
        
    def _convert_oneocr_results_to_percentages(
        self,
        oneocr_results: List[Dict[str, Any]],
        monitor_width: int,
        monitor_height: int,
        offset_x: int = 0,
        offset_y: int = 0
    ) -> List[Dict[str, Any]]:
        """Converts OneOCR results to percentages."""
        magpie_info = None
        if hasattr(self, 'window_monitor') and self.window_monitor:
            magpie_info = self.window_monitor.magpie_info

        target_w_hint, target_h_hint = self._get_target_client_size_hint()
        normalized_magpie_info = self._normalize_magpie_coordinate_space(
            magpie_info,
            source_width_hint=target_w_hint,
            source_height_hint=target_h_hint,
        )
        
        inverse_width_scale = 1.0 / self.calculated_width_scale_factor if self.calculated_width_scale_factor != 0 else 1.0
        inverse_height_scale = 1.0 / self.calculated_height_scale_factor if self.calculated_height_scale_factor != 0 else 1.0
        
        converted_results = []
        for line in oneocr_results:
            bbox = line.get("bounding_rect", {})
            if not bbox:
                continue
            
            def transform_box(box):
                for key, value in box.items():
                    if "x" in key:
                        scaled_coord = value * inverse_width_scale
                        abs_coord = scaled_coord + offset_x
                        abs_coord, _ = self._adjust_coords_for_magpie(abs_coord, 0, normalized_magpie_info)
                        box[key] = abs_coord / monitor_width
                    else:  # "y" in key
                        scaled_coord = value * inverse_height_scale
                        abs_coord = scaled_coord + offset_y
                        _, abs_coord = self._adjust_coords_for_magpie(0, abs_coord, normalized_magpie_info)
                        box[key] = abs_coord / monitor_height

            transform_box(bbox)
            converted_results.append(line)
            
            for word in line.get("words", []):
                word_bbox = word.get("bounding_rect", {})
                if self.ocr_language not in ['ja', 'zh', 'ko', 'th', 'lo', 'km', 'my', 'bo']:
                    word["text"] += " "
                if word_bbox:
                    transform_box(word_bbox)
                    
        return converted_results
    
async def init_overlay_processor():
    """Initializes the overlay processor and starts the overlay thread."""
    overlay_processor.init()
    overlay_thread = OverlayThread()
    overlay_thread.start()
    logger.background("Overlay processor ready")
    
def get_overlay_processor() -> OverlayProcessor:
    """Returns the initialized overlay processor instance."""
    global overlay_processor
    if overlay_processor is None:
        asyncio.run(init_overlay_processor())
    return overlay_processor

async def main_test_screenshot():
    processor = OverlayProcessor()
    img, off_x, off_y, monitor_width, monitor_height = processor._get_screenshot_and_offset()
    if not img:
        return
    img.show()
    
async def main_run_ocr():
    overlay_processor = OverlayProcessor()
    while True:
        await overlay_processor.find_box_and_send_to_overlay(check_against_last=False, local_ocr_retry=0)
        await asyncio.sleep(10)
        
overlay_processor = OverlayProcessor()

if __name__ == '__main__':
    try:
        asyncio.run(main_run_ocr())
    except KeyboardInterrupt:
        logger.info("Script terminated by user.")
    except Exception as e:
        logger.exception(f"An error occurred in the main execution block: {e}")
