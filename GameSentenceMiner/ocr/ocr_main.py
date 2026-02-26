import asyncio
import io
import json
import mss
import mss.tools
import os
import queue
import threading
import time
import uuid
import websockets
from PIL import Image
from copy import copy
from datetime import datetime
from pathlib import Path
import multiprocessing as mp
import sys
from typing import Any

from GameSentenceMiner.ocr.compare import compare_ocr_results
from GameSentenceMiner.ocr.two_pass_ocr import (
    TwoPassOCRController, TwoPassConfig, SecondPassResult,
)
from GameSentenceMiner import obs
from GameSentenceMiner.ocr.gsm_ocr_config import OCRConfig, has_config_changed, set_dpi_awareness, get_window
from GameSentenceMiner.ocr.gsm_ocr_config import get_ocr_config, get_scene_furigana_filter_sensitivity
from GameSentenceMiner.owocr.owocr import run
from GameSentenceMiner.owocr.owocr.run import TextFiltering
from GameSentenceMiner.util.communication import ocr_ipc
from GameSentenceMiner.util.config.configuration import get_app_directory, get_config, get_temporary_directory, is_windows, is_beangate
from GameSentenceMiner.util.config.electron_config import get_ocr_ocr2, get_ocr_send_to_clipboard, get_ocr_scan_rate, \
    has_ocr_config_changed, reload_electron_config, get_ocr_two_pass_ocr, get_ocr_optimize_second_scan, \
    get_ocr_language, get_ocr_manual_ocr_hotkey, get_ocr_ocr1, get_ocr_keep_newline
# Use centralized loguru logger
from GameSentenceMiner.util.logging_config import logger
from GameSentenceMiner.util.text_log import TextSource

CONFIG_FILE = Path("ocr_config.json")
DEFAULT_IMAGE_PATH = r"C:\Users\Beangate\Pictures\msedge_acbl8GL7Ax.jpg"  # CHANGE THIS
# Beangate-only OCR metrics capture switch.
# Requires both this flag and is_beangate to be true.
OCR_METRICS_CAPTURE_ENABLED = True

websocket_server_thread = None
websocket_queue = queue.Queue()
paused = False
shutdown_requested = False
ocr_metrics_capture_lock = threading.Lock()


def _should_capture_ocr_metrics() -> bool:
    return bool(is_beangate and OCR_METRICS_CAPTURE_ENABLED)


def _flatten_text_for_metrics(text: Any) -> str:
    if text is None:
        return ""
    if isinstance(text, list):
        joined = " ".join(str(x) for x in text if x is not None)
    else:
        joined = str(text)
    return " ".join(joined.replace("\r\n", "\n").replace("\r", "\n").split())


def _ocr_metrics_pending_dir() -> Path:
    metrics_dir = Path(get_app_directory()) / "ocr_metrics" / "pending"
    metrics_dir.mkdir(parents=True, exist_ok=True)
    return metrics_dir


def capture_ocr_metrics_sample(img, text, source=TextSource.OCR, response_dict=None):
    if not _should_capture_ocr_metrics():
        return

    flattened_text = _flatten_text_for_metrics(text)
    if not flattened_text:
        return

    pending_dir = _ocr_metrics_pending_dir()
    sample_id = f"{datetime.now().strftime('%Y%m%dT%H%M%S_%fZ')}"
    image_name = f"{sample_id}.png"
    image_path = pending_dir / image_name
    metadata_path = pending_dir / f"{sample_id}.json"

    try:
        if isinstance(img, (bytes, bytearray)):
            Image.open(io.BytesIO(img)).convert("RGB").save(image_path, format="PNG")
        else:
            img.convert("RGB").save(image_path, format="PNG")
    except Exception as image_error:
        logger.debug(f"OCR metrics capture skipped (image save failed): {image_error}")
        return

    source_name = source.value if hasattr(source, "value") else str(source)
    pipeline = response_dict.get("pipeline") if isinstance(response_dict, dict) else None
    metadata = {
        "sample_id": sample_id,
        "created_at": datetime.now().isoformat(),
        "source": source_name,
        "raw_text": str(text),
        "flattened_text": flattened_text,
        "image_file": image_name,
        "pipeline": pipeline if isinstance(pipeline, dict) else None,
    }

    try:
        with ocr_metrics_capture_lock:
            with open(metadata_path, "w", encoding="utf-8") as f:
                json.dump(metadata, f, ensure_ascii=False, indent=2)
    except Exception as metadata_error:
        logger.debug(f"OCR metrics capture metadata write failed: {metadata_error}")

if os.name == "nt":
    # Ensure multiprocessing child workers reuse the current launched executable path.
    try:
        mp.set_executable(sys.executable)
    except Exception:
        pass


# IPC command handlers
# These commands are sent from Electron via stdin using OCRCMD: prefix
# Available commands defined in ocr_ipc.OCRCommand enum

def _normalize_command_data(cmd_data: dict) -> tuple[str, dict, str | None]:
    command = cmd_data.get('command', '').lower()
    cmd_id = cmd_data.get('id')
    data = cmd_data.get('data', {})
    if not isinstance(data, dict):
        data = {}
    # Backward-compat: allow legacy top-level fields like "state"/"enabled".
    for key in ("state", "enabled"):
        if key in cmd_data and key not in data:
            data[key] = cmd_data[key]
    return command, data, cmd_id


def _get_current_engine_name() -> str:
    engine_instances = getattr(run, "engine_instances", None)
    if not engine_instances:
        return "unknown"

    try:
        engine_index = int(getattr(run, "engine_index", 0))
    except (TypeError, ValueError):
        engine_index = 0

    if engine_index < 0:
        return "unknown"

    try:
        current_engine = engine_instances[engine_index]
    except (IndexError, TypeError):
        return "unknown"

    readable_name = getattr(current_engine, "readable_name", None)
    return readable_name if readable_name else "unknown"


def request_clean_shutdown(reason: str = "unknown") -> None:
    global done, shutdown_requested, websocket_server_thread

    if shutdown_requested:
        return

    shutdown_requested = True
    done = True
    logger.info(f"OCR clean shutdown requested ({reason})")

    try:
        second_ocr_queue.put_nowait(None)
    except Exception:
        pass

    try:
        if websocket_server_thread:
            websocket_server_thread.stop_server()
    except Exception as e:
        logger.debug(f"Failed to stop OCR websocket server cleanly: {e}")

    try:
        import GameSentenceMiner.ui.qt_main as qt_main
        qt_main.shutdown_qt_app()
    except Exception as e:
        logger.debug(f"Failed to shutdown Qt app via qt_main helper: {e}")
        try:
            from PyQt6.QtWidgets import QApplication
            app = QApplication.instance()
            if app:
                app.quit()
        except Exception as inner_error:
            logger.debug(f"Fallback Qt shutdown failed: {inner_error}")


def _handle_command(cmd_data: dict, *, announce_ipc: bool) -> dict:
    """
    Handle IPC/remote commands.
    Commands follow format: {"command": <name>, "data": {...}, "id": optional}
    Returns a response dict with 'success' and optionally 'data' or 'error'.
    """

    response = {"success": False, "command": None}
    try:
        command, data, cmd_id = _normalize_command_data(cmd_data)
        response["command"] = command
        if cmd_id is not None:
            response["id"] = cmd_id

        if not hasattr(run, "paused"):
            run.paused = False

        if command == ocr_ipc.OCRCommand.PAUSE.value:
            # Legacy behavior: if "state" is provided, set it; otherwise toggle.
            if "state" in data:
                new_state = bool(data.get("state"))
                if run.paused != new_state:
                    run.pause_handler(is_combo=False)
            else:
                run.pause_handler(is_combo=False)
            response["success"] = True
            response["paused"] = run.paused
            logger.info(f"Remote control: {'Paused' if run.paused else 'Unpaused'} OCR")
            if announce_ipc:
                if run.paused:
                    ocr_ipc.announce_paused()
                else:
                    ocr_ipc.announce_unpaused()

        elif command == ocr_ipc.OCRCommand.UNPAUSE.value:
            if run.paused:
                run.pause_handler(is_combo=False)
            response["success"] = True
            response["paused"] = run.paused
            logger.info("IPC: Unpaused OCR")
            if announce_ipc:
                ocr_ipc.announce_unpaused()

        elif command == ocr_ipc.OCRCommand.TOGGLE_PAUSE.value:
            run.pause_handler(is_combo=False)
            response["success"] = True
            response["paused"] = run.paused
            logger.info(f"IPC: Toggled to {'paused' if run.paused else 'unpaused'}")
            if announce_ipc:
                if run.paused:
                    ocr_ipc.announce_paused()
                else:
                    ocr_ipc.announce_unpaused()

        elif command == ocr_ipc.OCRCommand.GET_STATUS.value:
            status_data = {
                "paused": run.paused,
                "current_engine": _get_current_engine_name(),
                "scan_rate": get_ocr_scan_rate(),
                "force_stable": get_controller().force_stable,
                "manual": globals().get("manual", False),
            }
            response["success"] = True
            response["data"] = status_data
            if announce_ipc:
                ocr_ipc.announce_status(status_data)

        elif command == ocr_ipc.OCRCommand.MANUAL_OCR.value:
            if hasattr(run, 'screenshot_event') and run.screenshot_event:
                run.screenshot_event.set()
                response["success"] = True
                logger.info("IPC: Triggered manual OCR")
            else:
                response["error"] = "Screenshot event not available"
                logger.error("IPC: Screenshot event not available")
                if announce_ipc:
                    ocr_ipc.announce_error("Screenshot event not available")

        elif command == ocr_ipc.OCRCommand.TOGGLE_FORCE_STABLE.value:
            is_stable = get_controller().toggle_force_stable()
            response["success"] = True
            response["data"] = {"enabled": is_stable}
            logger.info(f"IPC: Force stable mode {'enabled' if is_stable else 'disabled'}")
            if announce_ipc:
                ocr_ipc.announce_force_stable_changed(is_stable)

        elif command == ocr_ipc.OCRCommand.SET_FORCE_STABLE.value:
            enabled = bool(data.get('enabled', False))
            get_controller().set_force_stable(enabled)
            response["success"] = True
            response["data"] = {"enabled": enabled}
            logger.info(f"IPC: Set force stable mode to {enabled}")
            if announce_ipc:
                ocr_ipc.announce_force_stable_changed(enabled)

        elif command == ocr_ipc.OCRCommand.RELOAD_CONFIG.value:
            logger.info("IPC: Config reload requested")
            apply_ipc_config_reload(data)
            response["success"] = True
            if announce_ipc:
                ocr_ipc.announce_config_reloaded()

        elif command == ocr_ipc.OCRCommand.STOP.value:
            logger.info("IPC: Stop command received")
            response["success"] = True
            if announce_ipc:
                ocr_ipc.announce_stopped()
            request_clean_shutdown("ipc-stop-command")

        else:
            response["error"] = f"Unknown command: {command}"

    except Exception as e:
        logger.exception(f"Error handling command: {e}")
        response["error"] = str(e)
        if announce_ipc:
            ocr_ipc.announce_error(str(e))

    return response


def handle_ipc_command(cmd_data: dict) -> dict:
    """Handle IPC commands sent from Electron via stdin."""
    return _handle_command(cmd_data, announce_ipc=True)


def handle_websocket_command(message_str: str) -> dict | None:
    """Handle websocket commands (legacy remote control)."""
    try:
        cmd_data = json.loads(message_str)
    except json.JSONDecodeError:
        return None

    if not isinstance(cmd_data, dict):
        return { "success": False, "error": "Invalid json" }
        
    if 'command' not in cmd_data:
        return { "success": False, "error": "No command specified" }

    return _handle_command(cmd_data, announce_ipc=False)


class WebsocketServerThread(threading.Thread):
    def __init__(self, read):
        super().__init__(daemon=True)
        self._loop = None
        self.read = read
        self.clients = set()
        self._event = threading.Event()

    @property
    def loop(self):
        self._event.wait()
        return self._loop

    async def send_text_coroutine(self, message):
        for client in self.clients:
            await client.send(message)

    async def server_handler(self, websocket):
        self.clients.add(websocket)
        try:
            async for message in websocket:
                # Check if this is a remote control command
                command_response = handle_websocket_command(message)
                if command_response is not None:
                    try:
                        await websocket.send(json.dumps(command_response))
                    except websockets.exceptions.ConnectionClosedOK:
                        pass
                    continue

                # Regular message handling - use run.paused to check current state
                is_paused = run.paused if hasattr(run, 'paused') else paused
                if self.read and not is_paused:
                    websocket_queue.put(message)
                    try:
                        await websocket.send('True')
                    except websockets.exceptions.ConnectionClosedOK:
                        pass
                else:
                    try:
                        await websocket.send('False')
                    except websockets.exceptions.ConnectionClosedOK:
                        pass
        except websockets.exceptions.ConnectionClosedError:
            pass
        finally:
            self.clients.remove(websocket)

    async def send_text(self, text, line_time: datetime, response_dict=None, source=TextSource.OCR):
        if text:
            data = {"sentence": text, "time": line_time.isoformat(
            ), "process_path": obs.get_current_game(), "source": source}
            if response_dict:
                data["dict_from_ocr"] = response_dict
            return asyncio.run_coroutine_threadsafe(
                self.send_text_coroutine(json.dumps(data)), self.loop)

    def stop_server(self):
        self.loop.call_soon_threadsafe(self._stop_event.set)

    def run(self):
        async def main():
            self._loop = asyncio.get_running_loop()
            self._stop_event = stop_event = asyncio.Event()
            self._event.set()
            self.server = start_server = websockets.serve(self.server_handler,
                                                          get_config().advanced.localhost_bind_address,
                                                          get_config().advanced.ocr_websocket_port,
                                                          max_size=1000000000)
            async with start_server:
                await stop_event.wait()

        asyncio.run(main())


# compare_ocr_results imported from GameSentenceMiner.ocr.compare


def _safe_int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _normalize_size(size_obj: Any, fallback_width: int = 0, fallback_height: int = 0) -> dict[str, int]:
    if isinstance(size_obj, dict):
        return {
            "width": _safe_int(size_obj.get("width"), fallback_width),
            "height": _safe_int(size_obj.get("height"), fallback_height),
        }
    if isinstance(size_obj, (tuple, list)) and len(size_obj) >= 2:
        return {
            "width": _safe_int(size_obj[0], fallback_width),
            "height": _safe_int(size_obj[1], fallback_height),
        }
    return {"width": _safe_int(fallback_width), "height": _safe_int(fallback_height)}


def _translate_bounding_rect(bounding_rect: dict[str, Any], offset_x: int, offset_y: int) -> dict[str, float]:
    translated = {}
    for key in ("x1", "x2", "x3", "x4"):
        translated[key] = float(bounding_rect.get(key, 0.0)) + float(offset_x)
    for key in ("y1", "y2", "y3", "y4"):
        translated[key] = float(bounding_rect.get(key, 0.0)) + float(offset_y)
    return translated


def _translate_line_to_source_space(line: dict[str, Any], offset_x: int, offset_y: int) -> dict[str, Any]:
    translated_line = {
        "text": str(line.get("text", "") or ""),
        "bounding_rect": _translate_bounding_rect(line.get("bounding_rect", {}) or {}, offset_x, offset_y),
        "words": [],
    }
    for word in line.get("words", []) or []:
        translated_line["words"].append(
            {
                "text": str(word.get("text", "") or ""),
                "bounding_rect": _translate_bounding_rect(word.get("bounding_rect", {}) or {}, offset_x, offset_y),
            }
        )
    return translated_line


def _has_word_level_coords(lines: Any) -> bool:
    if not isinstance(lines, list):
        return False
    for line in lines:
        if not isinstance(line, dict):
            continue
        words = line.get("words")
        if isinstance(words, list) and len(words) > 0:
            return True
    return False


def _is_overlay_supported_engine(engine_name: Any) -> bool:
    normalized = str(engine_name or "").strip().lower()
    if not normalized:
        return False
    return "oneocr" in normalized or "meiki" in normalized


def build_overlay_coordinate_payload(response_dict: Any) -> dict[str, Any] | None:
    """
    Convert OCR callback payload to a compact, overlay-ready coordinate payload.
    The output is still sent through the main process websocket path.
    """
    if not response_dict:
        return None

    if isinstance(response_dict, dict) and response_dict.get("schema") == "gsm_overlay_coords_v1":
        overlay_lines = response_dict.get("lines")
        if not _has_word_level_coords(overlay_lines):
            return None
        return response_dict

    if isinstance(response_dict, list):
        response_dict = {"line_coords": response_dict}

    if not isinstance(response_dict, dict):
        return None

    lines = response_dict.get("line_coords")
    if not isinstance(lines, list) or not lines:
        return None

    pipeline = response_dict.get("pipeline") if isinstance(response_dict.get("pipeline"), dict) else {}
    # if not _is_overlay_supported_engine(pipeline.get("engine")):
    #     return None

    capture = pipeline.get("capture") if isinstance(pipeline.get("capture"), dict) else {}
    processing = pipeline.get("processing") if isinstance(pipeline.get("processing"), dict) else {}
    ocr_meta = pipeline.get("ocr") if isinstance(pipeline.get("ocr"), dict) else {}
    crop_offset = processing.get("crop_offset") if isinstance(processing.get("crop_offset"), dict) else {}
    capture_origin = processing.get("capture_origin") if isinstance(processing.get("capture_origin"), dict) else {}
    coordinate_mode = str(processing.get("coordinate_mode") or "source_content")

    processed_size = _normalize_size(processing.get("processed_size"))
    capture_scaled_size = _normalize_size(capture.get("scaled_size"), processed_size["width"], processed_size["height"])
    capture_original_size = _normalize_size(capture.get("original_size"), capture_scaled_size["width"], capture_scaled_size["height"])

    offset_x = _safe_int(crop_offset.get("x"))
    offset_y = _safe_int(crop_offset.get("y"))
    translated_lines = [_translate_line_to_source_space(line, offset_x, offset_y) for line in lines if isinstance(line, dict)]
    if not translated_lines:
        return None
    if not _has_word_level_coords(translated_lines):
        return None

    if capture_scaled_size["width"] <= 0 or capture_scaled_size["height"] <= 0:
        max_x = 0.0
        max_y = 0.0
        for line in translated_lines:
            bbox = line.get("bounding_rect", {})
            max_x = max(max_x, float(bbox.get("x1", 0.0)), float(bbox.get("x2", 0.0)), float(bbox.get("x3", 0.0)), float(bbox.get("x4", 0.0)))
            max_y = max(max_y, float(bbox.get("y1", 0.0)), float(bbox.get("y2", 0.0)), float(bbox.get("y3", 0.0)), float(bbox.get("y4", 0.0)))
        capture_scaled_size = {
            "width": max(1, _safe_int(max_x)),
            "height": max(1, _safe_int(max_y)),
        }
        if capture_original_size["width"] <= 0 or capture_original_size["height"] <= 0:
            capture_original_size = dict(capture_scaled_size)

    return {
        "schema": "gsm_overlay_coords_v1",
        "coordinate_space": {
            "source_width": capture_scaled_size["width"],
            "source_height": capture_scaled_size["height"],
            "processed_width": processed_size["width"],
            "processed_height": processed_size["height"],
            "mode": coordinate_mode,
            "crop_offset": {"x": offset_x, "y": offset_y},
            "capture_origin": {"x": _safe_int(capture_origin.get("x"), 0), "y": _safe_int(capture_origin.get("y"), 0)},
            "capture_original_size": capture_original_size,
            "capture_scaled_size": capture_scaled_size,
        },
        "crop": {
            "crop_coords": ocr_meta.get("crop_coords"),
            "crop_coords_list": ocr_meta.get("crop_coords_list"),
        },
        "lines": translated_lines,
    }


def get_screen_crop_image_metadata(image: Any) -> dict[str, Any] | None:
    if image is None:
        return None
    raw_meta = getattr(image, "_gsm_screen_crop_metadata", None)
    if not isinstance(raw_meta, dict):
        return None

    virtual_left = _safe_int(raw_meta.get("virtual_left"), 0)
    virtual_top = _safe_int(raw_meta.get("virtual_top"), 0)
    virtual_width = _safe_int(raw_meta.get("virtual_width"), 0)
    virtual_height = _safe_int(raw_meta.get("virtual_height"), 0)
    selection_left = _safe_int(raw_meta.get("selection_left"), virtual_left)
    selection_top = _safe_int(raw_meta.get("selection_top"), virtual_top)
    selection_width = _safe_int(raw_meta.get("selection_width"), 0)
    selection_height = _safe_int(raw_meta.get("selection_height"), 0)

    if virtual_width <= 0 or virtual_height <= 0:
        return None

    return {
        "capture_source": "screen_cropper",
        "capture_original_size": {"width": virtual_width, "height": virtual_height},
        "capture_scaled_size": {"width": virtual_width, "height": virtual_height},
        "capture_origin": {"x": virtual_left, "y": virtual_top},
        "coordinate_mode": "absolute_screen",
        "ocr_area_crop_offset": {
            "x": max(0, selection_left - virtual_left),
            "y": max(0, selection_top - virtual_top),
        },
        "ocr_area_rectangles": [
            [
                max(0, selection_left - virtual_left),
                max(0, selection_top - virtual_top),
                max(1, selection_width),
                max(1, selection_height),
            ]
        ],
    }


all_cords = None
rectangles = None


class OCRProcessor():
    def __init__(self):
        self.filtering = TextFiltering(lang=get_ocr_language())

    def _get_engine_instance_by_name(self, preferred_name: str):
        if not preferred_name:
            return None
        for instance in getattr(run, "engine_instances", []) or []:
            name = getattr(instance, "name", "")
            if preferred_name.lower() in name.lower() or name.lower() in preferred_name.lower():
                return instance
        return None

    def _build_geometry_payload_with_local_engine(self, img, image_metadata=None, ignore_furigana_filter=False):
        """
        Build a geometry payload using OCR1 when OCR2 didn't provide line coordinates.
        This is used as a fallback for secondary/manual hotkey flows.
        """
        local_engine = self._get_engine_instance_by_name(get_ocr_ocr1())
        if not local_engine:
            return None

        try:
            local_result = local_engine(
                img,
                furigana_filter_sensitivity if not ignore_furigana_filter else 0
            )
            success, _text, coords, crop_coords_list, crop_coords, _response = (list(local_result) + [None] * 6)[:6]
            if not success or not isinstance(coords, list) or not coords:
                return None

            pipeline = run._build_pipeline_metadata(
                image_metadata,
                img,
                local_engine.name,
                True,
            )
            pipeline["ocr"] = {
                "crop_coords": list(crop_coords) if crop_coords else None,
                "crop_coords_list": [list(c[:5]) for c in (crop_coords_list or [])],
                "line_count": len(coords),
            }
            return {
                "schema": "gsm_ocr_geometry_v1",
                "line_coords": coords,
                "pipeline": pipeline,
            }
        except Exception as e:
            logger.debug(f"Failed to build fallback local geometry payload: {e}")
            return None

    @staticmethod
    def _get_effective_crop_box(crop_coords, img_width: int, img_height: int, extra_padding: int = 0):
        if not crop_coords:
            return None
        try:
            x1, y1, x2, y2 = crop_coords
        except Exception:
            return None

        pad = int(extra_padding or 0)
        x1 = x1 - pad
        y1 = y1 - pad
        x2 = x2 + pad
        y2 = y2 + pad

        x1 = min(max(0, int(x1)), int(img_width))
        y1 = min(max(0, int(y1)), int(img_height))
        x2 = min(max(0, int(x2)), int(img_width))
        y2 = min(max(0, int(y2)), int(img_height))

        if x2 <= x1:
            x2 = min(int(img_width), x1 + 1)
            x1 = max(0, x2 - 1)
        if y2 <= y1:
            y2 = min(int(img_height), y1 + 1)
            y1 = max(0, y2 - 1)
        return x1, y1, x2, y2

    @staticmethod
    def _accumulate_crop_offset_metadata(image_metadata, add_x: int, add_y: int):
        if not isinstance(image_metadata, dict):
            return image_metadata
        metadata = dict(image_metadata)
        crop_offset = metadata.get("ocr_area_crop_offset")
        if not isinstance(crop_offset, dict):
            crop_offset = {"x": 0, "y": 0}
        metadata["ocr_area_crop_offset"] = {
            "x": _safe_int(crop_offset.get("x"), 0) + int(add_x),
            "y": _safe_int(crop_offset.get("y"), 0) + int(add_y),
        }
        return metadata

    def _prepare_beangate_secondary_ocr2_image(self, img, ignore_furigana_filter=False):
        """
        Beangate-only local->trim->ocr2 flow for secondary OCR.
        Runs configured OCR1 locally, then trims to detected crop coords for OCR2.
        """
        if not is_beangate:
            return img, (0, 0)

        local_engine_name = get_ocr_ocr1()
        if not local_engine_name:
            return img, (0, 0)

        local_engine = None
        for instance in getattr(run, "engine_instances", []) or []:
            name = getattr(instance, "name", "")
            if local_engine_name.lower() in name.lower() or name.lower() in local_engine_name.lower():
                local_engine = instance
                break

        if not local_engine:
            logger.debug(
                f"Beangate secondary OCR pre-pass skipped: OCR1 engine '{local_engine_name}' not initialized.")
            return img, (0, 0)

        local_img = img
        if isinstance(img, (bytes, bytearray)):
            try:
                local_img = Image.open(io.BytesIO(img)).convert('RGB')
            except Exception:
                return img, (0, 0)

        try:
            local_result = local_engine(
                local_img,
                furigana_filter_sensitivity if not ignore_furigana_filter else 0
            )
            success, _text, _coords, _crop_coords_list, crop_coords, _response_dict = (list(local_result) + [None] * 6)[:6]
            if not success or not crop_coords:
                return local_img, (0, 0)
            effective_crop = self._get_effective_crop_box(
                crop_coords,
                local_img.width,
                local_img.height,
                extra_padding=0,
            )
            if not effective_crop:
                return local_img, (0, 0)
            x1, y1, _, _ = effective_crop
            return get_ocr2_image(
                crop_coords,
                og_image=local_img,
                ocr2_engine=get_ocr_ocr2()
            ), (x1, y1)
        except Exception as e:
            logger.debug(f"Beangate secondary OCR pre-pass failed; using untrimmed image: {e}")
            return local_img, (0, 0)

    def do_second_ocr(self, ocr1_text, time, img, filtering, pre_crop_image=None, ignore_furigana_filter=False, ignore_previous_result=False, image_metadata=None, response_dict=None, source=TextSource.OCR):
        ctrl = get_controller()
        try:
            ocr2_input_img = img
            working_image_metadata = image_metadata
            if source == TextSource.SECONDARY and is_beangate:
                ocr2_input_img, beangate_offset = self._prepare_beangate_secondary_ocr2_image(
                    img,
                    ignore_furigana_filter=ignore_furigana_filter
                )
                if beangate_offset != (0, 0):
                    working_image_metadata = self._accumulate_crop_offset_metadata(
                        working_image_metadata, beangate_offset[0], beangate_offset[1]
                    )

            orig_text, text, generated_payload = run.process_and_write_results(
                ocr2_input_img, None,
                ctrl.last_ocr2_result if not ignore_previous_result else None,
                self.filtering, None,
                engine=get_ocr_ocr2(),
                furigana_filter_sensitivity=furigana_filter_sensitivity if not ignore_furigana_filter else 0,
                image_metadata=working_image_metadata,
                return_payload=True,
            )

            if compare_ocr_results(ctrl.last_sent_result, text, threshold=80):
                if text:
                    logger.background("Duplicate text detected, skipping.")
                return
            save_result_image(ocr2_input_img, pre_crop_image=pre_crop_image)
            ctrl.last_ocr2_result = orig_text
            ctrl.last_sent_result = text
            final_payload = response_dict if response_dict else generated_payload
            if source == TextSource.SECONDARY and build_overlay_coordinate_payload(final_payload) is None:
                fallback_payload = self._build_geometry_payload_with_local_engine(
                    ocr2_input_img,
                    image_metadata=working_image_metadata,
                    ignore_furigana_filter=ignore_furigana_filter,
                )
                if fallback_payload:
                    final_payload = fallback_payload
                    logger.info("Secondary OCR: using OCR1 geometry fallback for overlay metadata.")
            capture_ocr_metrics_sample(
                ocr2_input_img,
                text,
                source=source,
                response_dict=final_payload,
            )
            asyncio.run(send_result(
                text, time, response_dict=final_payload, source=source))
        except json.JSONDecodeError:
            print("Invalid JSON received.")
        except Exception as e:
            logger.exception(e)
            print(f"Error processing message: {e}")


def save_result_image(img, pre_crop_image=None):
    try:
        if isinstance(img, bytes):
            with open(os.path.join(get_temporary_directory(), "last_successful_ocr.png"), "wb") as f:
                f.write(img)
        else:
            img.save(os.path.join(get_temporary_directory(),
                     "last_successful_ocr.png"))
            if pre_crop_image:
                pre_crop_image.save(os.path.join(
                    get_temporary_directory(), "last_successful_ocr_precrop.png"))
    except Exception as e:
        logger.debug(f"Error saving debug result image: {e}")


async def send_result(text, time, response_dict=None, source=TextSource.OCR):
    if text:
        if is_windows():
            overlay_payload = build_overlay_coordinate_payload(response_dict)
        else:
            overlay_payload = None
        if get_ocr_send_to_clipboard():
            import pyperclipfix
            # TODO Test this out and see if i can make it work properly across platforms
            # from GameSentenceMiner.ui.qt_main import send_to_clipboard
            # send_to_clipboard(text)
            pyperclipfix.copy(text)
        try:
            await websocket_server_thread.send_text(text, time, response_dict=overlay_payload, source=source)
        except Exception as e:
            logger.debug(f"Error sending text to websocket: {e}")


TEXT_APPEARENCE_DELAY = get_ocr_scan_rate() * 1000 + 500  # Adjust as needed


class OCRStateManager:
    """DEPRECATED: Legacy wrapper around TwoPassOCRController.

    Preserved only for backward compatibility with code that references
    ``ocr_state`` directly. All new code should use ``get_controller()``.
    """

    def __init__(self):
        self._controller: TwoPassOCRController | None = None

    @property
    def force_stable(self):
        return get_controller().force_stable

    @force_stable.setter
    def force_stable(self, value):
        get_controller().force_stable = value

    @property
    def last_sent_result(self):
        return get_controller().last_sent_result

    @last_sent_result.setter
    def last_sent_result(self, value):
        get_controller().last_sent_result = value

    @property
    def last_ocr2_result(self):
        return get_controller().last_ocr2_result

    @last_ocr2_result.setter
    def last_ocr2_result(self, value):
        get_controller().last_ocr2_result = value

    def reset(self):
        reset_callback_vars()

    def set_force_stable(self, value: bool):
        get_controller().set_force_stable(value)

    def toggle_force_stable(self):
        return get_controller().toggle_force_stable()


# ---------------------------------------------------------------------------
# Two-pass OCR controller infrastructure (replaces old OCRStateManager logic)
# ---------------------------------------------------------------------------

_controller: TwoPassOCRController | None = None
_last_metrics_img = None  # Tracks the last saved image for metrics capture


def _build_two_pass_config() -> TwoPassConfig:
    """Build a TwoPassConfig snapshot from current electron config."""
    ocr1_name = get_ocr_ocr1() or ""
    ocr2_name = get_ocr_ocr2() or ""

    return TwoPassConfig(
        two_pass_enabled=get_ocr_two_pass_ocr(),
        ocr1_engine=ocr1_name,
        ocr2_engine=ocr2_name,
        ocr1_engine_readable=_resolve_engine_readable_name(ocr1_name),
        ocr2_engine_readable=_resolve_engine_readable_name(ocr2_name),
        optimize_second_scan=get_ocr_optimize_second_scan(),
        keep_newline=get_ocr_keep_newline(),
        language=get_ocr_language(),
    )


def _resolve_engine_readable_name(preferred_name: str) -> str:
    if not preferred_name:
        return ""
    for instance in getattr(run, "engine_instances", []) or []:
        name = getattr(instance, "name", "")
        if preferred_name.lower() in name.lower() or name.lower() in preferred_name.lower():
            readable = getattr(instance, "readable_name", "")
            return readable or preferred_name
    return preferred_name


def _send_result_callback(text, time, *, response_dict=None, source=None):
    """Controller callback: send OCR result via websocket + capture metrics."""
    global _last_metrics_img
    line_source = source or TextSource.OCR
    if _last_metrics_img is not None:
        capture_ocr_metrics_sample(
            _last_metrics_img, text,
            source=line_source, response_dict=response_dict,
        )
        _last_metrics_img = None
    asyncio.run(send_result(text, time, response_dict=response_dict, source=line_source))


def _run_second_ocr_callback(img, last_result, filtering, engine, **kw):
    """Controller callback: run the second OCR engine and return result."""
    orig_text, text, payload = run.process_and_write_results(
        img, None, last_result, filtering, None,
        engine=engine,
        furigana_filter_sensitivity=furigana_filter_sensitivity,
        return_payload=True,
    )
    return SecondPassResult(
        text=text or "",
        orig_text=orig_text or [],
        response_dict=payload,
    )


def _save_image_callback(img, pre_crop_image=None):
    """Controller callback: save debug image and track for metrics."""
    global _last_metrics_img
    _last_metrics_img = img
    save_result_image(img, pre_crop_image=pre_crop_image)
    try:
        run.set_last_image(img)
    except Exception:
        pass


def _get_ocr2_image_callback(crop_coords, og_image, extra_padding=0):
    """Controller callback: crop image for OCR2."""
    return get_ocr2_image(
        crop_coords,
        og_image,
        ocr2_engine=get_ocr_ocr2(),
        extra_padding=extra_padding,
    )


def _queue_second_pass_callback(
    ocr1_text,
    stable_time,
    previous_img_local,
    filtering,
    pre_crop_image=None,
    ignore_furigana_filter=False,
    ignore_previous_result=False,
    image_metadata=None,
    response_dict=None,
    source=TextSource.OCR,
):
    second_ocr_queue.put((
        ocr1_text,
        stable_time,
        previous_img_local,
        filtering,
        pre_crop_image,
        ignore_furigana_filter,
        ignore_previous_result,
        image_metadata,
        response_dict,
        source,
    ))
    if pre_crop_image is not None:
        try:
            run.set_last_image(pre_crop_image)
        except Exception:
            pass
    return True


def _build_controller() -> TwoPassOCRController:
    """Build a new TwoPassOCRController with current config and callbacks."""
    cfg = _build_two_pass_config()
    processor = get_second_ocr_processor()
    return TwoPassOCRController(
        config=cfg,
        filtering=processor.filtering,
        send_result=_send_result_callback,
        run_second_ocr=_run_second_ocr_callback,
        queue_second_pass=_queue_second_pass_callback,
        save_image=_save_image_callback,
        get_ocr2_image=_get_ocr2_image_callback,
    )


def get_controller() -> TwoPassOCRController:
    """Get or create the global TwoPassOCRController."""
    global _controller
    if _controller is None:
        _controller = _build_controller()
    return _controller
_second_ocr_processor = None  # Lazy-loaded


def get_second_ocr_processor():
    """Get or create the second OCR processor (lazy-loaded to avoid GPU init at import)."""
    global _second_ocr_processor
    if _second_ocr_processor is None:
        _second_ocr_processor = OCRProcessor()
    return _second_ocr_processor


def apply_ipc_config_reload(data: dict | None = None) -> None:
    """
    Reload OCR configs based on an IPC request from Electron.
    data can include:
      - reload_electron: bool (default True)
      - reload_area: bool (default True)
      - changes: dict (optional precomputed config diffs)
    """
    global ocr_config

    payload = data or {}
    reload_electron = payload.get('reload_electron', True)
    reload_area = payload.get('reload_area', True)
    changes = payload.get('changes')

    if reload_electron:
        if changes is None:
            section_changed, changes = has_ocr_config_changed()
        else:
            section_changed = True

        if section_changed:
            reload_electron_config()
            logger.info(f"IPC: OCR config changes applied: {changes}")

            # Always sync furigana from per-scene settings file
            global furigana_filter_sensitivity
            try:
                furigana_filter_sensitivity = get_scene_furigana_filter_sensitivity(
                    use_window_as_config=True, window=obs.get_current_game()
                )
                logger.info(f"IPC: furigana_filter_sensitivity synced to {furigana_filter_sensitivity}")
            except Exception as e:
                logger.debug(f"IPC: Failed to read scene furigana setting: {e}")

            mode_switched = '_mode_switched' in changes or 'advancedMode' in changes
            config_needs_reset = any(c in changes for c in (
                'ocr1', 'ocr2', 'language', 'furigana_filter_sensitivity', 'basic', 'advanced'))
            if config_needs_reset:
                try:
                    run.engine_change_handler_name(get_ocr_ocr1(), switch=True)
                    run.engine_change_handler_name(
                        get_ocr_ocr2(), switch=False)
                    run.set_ocr_engines(get_ocr_ocr1(), get_ocr_ocr2())
                except Exception as e:
                    logger.debug(
                        f"IPC: Failed to update OCR engines after config change: {e}")
            if mode_switched or config_needs_reset:
                reset_callback_vars()
                if mode_switched:
                    logger.info("Advanced mode toggled, resetting OCR state")
            if 'base_scale' in changes:
                try:
                    if hasattr(run, 'obs_screenshot_thread') and run.obs_screenshot_thread:
                        run.obs_screenshot_thread.init_config()
                        logger.info(
                            f"IPC: base_scale changed to {changes['base_scale'][1] if isinstance(changes.get('base_scale'), tuple) else changes['base_scale']}, re-initialised OBS screenshot dimensions."
                        )
                except Exception as e:
                    logger.debug(f"IPC: Failed to re-init OBS screenshot thread after base_scale change: {e}")

    if reload_area:
        try:
            ocr_config_changed = ocr_config is None or has_config_changed(
                ocr_config)
            if ocr_config_changed:
                logger.info("IPC: OCR area config changed, reloading...")
                ocr_config = get_ocr_config(
                    use_window_for_config=True, window=obs.get_current_game())
                if hasattr(run, 'screenshot_thread') and run.screenshot_thread:
                    run.screenshot_thread.ocr_config = ocr_config
                if hasattr(run, 'obs_screenshot_thread') and run.obs_screenshot_thread:
                    run.obs_screenshot_thread.init_config()
                reset_callback_vars()
        except Exception as e:
            logger.debug(f"IPC: Error reloading OCR area config: {e}")


def reset_callback_vars():
    """Reset all OCR state and rebuild the controller with fresh config."""
    global _controller
    if _controller is not None:
        _controller.reset()
    _controller = None  # Will be rebuilt on next get_controller() call


def ocr_result_callback(text, orig_text, time, img=None, came_from_ss=False, filtering=None, crop_coords=None, meiki_boxes=None, response_dict=None, raw_text=None):
    """
    Main callback for OCR results. Delegates to TwoPassOCRController.

    All two-pass OCR logic (trigger detection, state management, dedup,
    second-pass execution) is handled by the controller from
    ``GameSentenceMiner.ocr.two_pass_ocr``.
    """
    ctrl = get_controller()
    ctrl.config.ocr1_engine_readable = _resolve_engine_readable_name(ctrl.config.ocr1_engine)
    ctrl.config.ocr2_engine_readable = _resolve_engine_readable_name(ctrl.config.ocr2_engine)
    line_source = TextSource.OCR_MANUAL if manual else TextSource.OCR

    ctrl.handle_ocr_result(
        text, orig_text, time, img,
        came_from_ss=came_from_ss,
        crop_coords=crop_coords,
        meiki_boxes=meiki_boxes,
        response_dict=response_dict,
        source=line_source,
        manual=manual,
        raw_text=raw_text,
    )


done = False

# Create a queue for tasks
second_ocr_queue = queue.Queue()


def get_ocr2_image(crop_coords, og_image: Image.Image, ocr2_engine=None, extra_padding=0):
    """
    Returns the image to use for the second OCR pass, cropping with optional padding.
    Simplified to only handle trimming/cropping the original image.
    """
    # Convert bytes to PIL.Image if necessary
    img = og_image
    if isinstance(og_image, (bytes, bytearray)):
        try:
            img = Image.open(io.BytesIO(og_image)).convert('RGB')
        except Exception:
            # If conversion fails, just return og_image as-is
            return og_image

    # If no crop coords or optimization disabled, return full image
    if not crop_coords or not get_ocr_optimize_second_scan():
        return img

    # Apply cropping with padding
    x1, y1, x2, y2 = crop_coords
    pad = int(extra_padding or 0)
    
    x1 = x1 - pad
    y1 = y1 - pad
    x2 = x2 + pad
    y2 = y2 + pad

    # Clamp coordinates to image bounds
    x1 = min(max(0, int(x1)), img.width)
    y1 = min(max(0, int(y1)), img.height)
    x2 = min(max(0, int(x2)), img.width)
    y2 = min(max(0, int(y2)), img.height)

    # Ensure at least a 1-pixel width/height
    if x2 <= x1:
        x2 = min(img.width, x1 + 1)
        x1 = max(0, x2 - 1)
    if y2 <= y1:
        y2 = min(img.height, y1 + 1)
        y1 = max(0, y2 - 1)

    return img.crop((x1, y1, x2, y2))


def process_task_queue():
    while True:
        try:
            task = second_ocr_queue.get()
            if task is None:  # Exit signal
                break
            ignore_furigana_filter = False
            ignore_previous_result = False
            image_metadata = None
            response_dict = None
            task = (list(task) + [None]*10)[:10]
            ocr1_text, stable_time, previous_img_local, filtering, pre_crop_image, ignore_furigana_filter, ignore_previous_result, image_metadata, response_dict, source = task
            get_second_ocr_processor().do_second_ocr(
                ocr1_text,
                stable_time,
                previous_img_local,
                filtering,
                pre_crop_image,
                ignore_furigana_filter,
                ignore_previous_result,
                image_metadata,
                response_dict,
                source=source or TextSource.OCR
            )
        except Exception as e:
            logger.exception(f"Error processing task: {e}")
        finally:
            second_ocr_queue.task_done()


def run_oneocr(ocr_config: OCRConfig, rectangles):
    global done
    screen_area = None
    screen_areas = [",".join(str(c) for c in rect_config.coordinates)
                    for rect_config in rectangles if not rect_config.is_excluded]
    exclusions = list(rect.coordinates for rect in list(
        filter(lambda x: x.is_excluded, rectangles)))

    run.init_config(False)
    try:
        read_from = ""
        if obs_ocr:
            read_from = "obs"
        elif window:
            read_from = "screencapture"
        read_from_secondary = "clipboard" if ss_clipboard else None
        run.run(read_from=read_from,
                read_from_secondary=read_from_secondary,
                write_to="callback",
                screen_capture_area=screen_area,
                # screen_capture_monitor=monitor_config['index'],
                screen_capture_window=ocr_config.window if ocr_config and ocr_config.window else None,
                screen_capture_delay_secs=get_ocr_scan_rate(), engine=ocr1,
                text_callback=ocr_result_callback,
                screen_capture_exclusions=exclusions,
                monitor_index=None,
                ocr1=ocr1,
                ocr2=ocr2,
                gsm_ocr_config=ocr_config,
                screen_capture_areas=screen_areas,
                furigana_filter_sensitivity=furigana_filter_sensitivity,
                screen_capture_combo=manual_ocr_hotkey.upper(
                ) if manual_ocr_hotkey and manual else None,
                config_check_thread=None,
                combo_pause=global_pause_hotkey,
                disable_user_input=True,  # Disable stdin user input to avoid conflicts with IPC
                logger_level='INFO')  # Set logger level to INFO to suppress DEBUG messages
    except Exception as e:
        logger.exception(f"Error running OneOCR: {e}")
    done = True
    # Quit Qt app if running
    try:
        from PyQt6.QtWidgets import QApplication
        app = QApplication.instance()
        if app:
            app.quit()
    except Exception:
        pass


def add_ss_hotkey(ss_hotkey="ctrl+shift+g"):
    import keyboard

    # We'll create the signal helper when the Qt app is available
    global _screen_cropper_signals

    def ocr_secondary_rectangles():
        logger.info("Running secondary OCR rectangles...")
        time = datetime.now()
        ocr_config = get_ocr_config()
        img = obs.get_screenshot_PIL(compression=90, img_format="jpg")
        image_metadata = {
            "capture_source": "secondary_rectangles",
            "capture_original_size": {"width": int(img.width), "height": int(img.height)},
            "capture_scaled_size": {"width": int(img.width), "height": int(img.height)},
            "coordinate_mode": "source_content",
            "capture_origin": {"x": 0, "y": 0},
            "ocr_area_crop_offset": {"x": 0, "y": 0},
            "ocr_area_rectangles": [],
        }
        ocr_config.scale_to_custom_size(img.width, img.height)
        # for rectangle in [rectangle for rectangle in ocr_config.rectangles if rectangle.is_secondary]:
        has_secondary_rectangles = any(
            rectangle.is_secondary for rectangle in ocr_config.rectangles)
        if has_secondary_rectangles:
            secondary_rectangles = [
                list(rectangle.coordinates)
                for rectangle in ocr_config.rectangles
                if rectangle.is_secondary and not rectangle.is_excluded
            ]
            img, crop_offset = run.apply_ocr_config_to_image(
                img, ocr_config, is_secondary=True)
            image_metadata["ocr_area_rectangles"] = secondary_rectangles
            image_metadata["ocr_area_crop_offset"] = {
                "x": int(crop_offset[0]),
                "y": int(crop_offset[1]),
            }
        get_second_ocr_processor().do_second_ocr("", time, img, TextFiltering(lang=get_ocr_language()),
                                                 ignore_furigana_filter=True, ignore_previous_result=True, image_metadata=image_metadata, source=TextSource.SECONDARY)

    filtering = TextFiltering(lang=get_ocr_language())

    def capture():
        from GameSentenceMiner.ui.qt_main import launch_screen_cropper
        print("Taking screenshot via screen cropper...")
        time = datetime.now()
        # Use the dialog manager's synchronous method
        cropped_img = launch_screen_cropper(transparent_mode=False)

        global second_ocr_queue
        if cropped_img:
            image_metadata = get_screen_crop_image_metadata(cropped_img)
            second_ocr_queue.put(("", time, cropped_img, filtering,
                                 None, True, True, image_metadata, None, TextSource.SCREEN_CROPPER))
        else:
            logger.info("Screen cropper cancelled")

    def capture_main_monitor():
        print("Taking screenshot of main monitor...")
        with mss.mss() as sct:
            time = datetime.now()
            main_monitor = sct.monitors[1] if len(
                sct.monitors) > 1 else sct.monitors[0]
            img = sct.grab(main_monitor)
            img_bytes = mss.tools.to_png(img.rgb, img.size)
            get_second_ocr_processor().do_second_ocr("", time, img_bytes, filtering,
                                                     ignore_furigana_filter=True, ignore_previous_result=True, source=TextSource.MANUAL)
    hotkey_reg = None
    secondary_hotkey_reg = None
    try:
        hotkey_reg = keyboard.add_hotkey(ss_hotkey, capture)
        if not manual:
            secondary_hotkey_reg = keyboard.add_hotkey(
                get_ocr_manual_ocr_hotkey().lower(), ocr_secondary_rectangles)
            print(f"Press {get_ocr_manual_ocr_hotkey()} to run OCR for Menu Rectangles.")
        else:
            print(f"Press {ss_hotkey} to run Manual OCR.")
    except Exception as e:
        if hotkey_reg:
            keyboard.remove_hotkey(hotkey_reg)
        if secondary_hotkey_reg:
            keyboard.remove_hotkey(secondary_hotkey_reg)
        logger.error(
            f"Error setting up screenshot hotkey with keyboard, Attempting Backup: {e}")
        logger.debug(e)
        pynput_hotkey = ss_hotkey.replace("ctrl", "<ctrl>").replace(
            "shift", "<shift>").replace("alt", "<alt>")
        secondary_ss_hotkey = get_ocr_manual_ocr_hotkey().lower().replace(
            "ctrl", "<ctrl>").replace("shift", "<shift>").replace("alt", "<alt>")
        try:
            from pynput import keyboard as pynput_keyboard
            listener = pynput_keyboard.GlobalHotKeys({
                pynput_hotkey: capture,
                secondary_ss_hotkey: ocr_secondary_rectangles,
            })
            listener.start()
        except Exception as e:
            logger.error(
                f"Error setting up screenshot hotkey with pynput, Screenshot Hotkey Will not work: {e}")


def set_force_stable_hotkey():
    import keyboard

    def toggle_force_stable():
        is_stable = get_controller().toggle_force_stable()
        if is_stable:
            print("Force stable mode enabled.")
        else:
            print("Force stable mode disabled.")

    keyboard.add_hotkey('p', toggle_force_stable)
    print("Press Ctrl+Shift+F to toggle force stable mode.")


if __name__ == "__main__":
    try:
        global ocr1, ocr2, twopassocr, language, ss_clipboard, ss, ocr_config, furigana_filter_sensitivity, area_select_ocr_hotkey, window, optimize_second_scan, use_window_for_config, keep_newline, obs_ocr, manual, settings_window, global_pause_hotkey
        import sys

        import argparse

        parser = argparse.ArgumentParser(description="OCR Configuration")
        parser.add_argument("--language", type=str, default="ja",
                            help="Language for OCR (default: ja)")
        parser.add_argument("--ocr1", type=str, default="oneocr",
                            help="Primary OCR engine (default: oneocr)")
        parser.add_argument("--ocr2", type=str, default="glens",
                            help="Secondary OCR engine (default: glens)")
        parser.add_argument("--twopassocr", type=int, choices=[0, 1], default=1,
                            help="Enable two-pass OCR (default: 1)")
        parser.add_argument("--manual", action="store_true",
                            help="Use screenshot-only mode")
        parser.add_argument("--clipboard", action="store_true",
                            help="Use clipboard for input")
        parser.add_argument("--clipboard-output", action="store_true",
                            default=False, help="Use clipboard for output")
        parser.add_argument("--window", type=str,
                            help="Specify the window name for OCR")
        parser.add_argument("--furigana_filter_sensitivity", type=float, default=0,
                            help="Furigana Filter Sensitivity for OCR (default: 0)")
        parser.add_argument("--manual_ocr_hotkey", type=str,
                            default=None, help="Hotkey for manual OCR (default: None)")
        parser.add_argument("--area_select_ocr_hotkey", type=str, default="ctrl+shift+o",
                            help="Hotkey for area selection OCR (default: ctrl+shift+o)")
        parser.add_argument("--optimize_second_scan", action="store_true",
                            help="Optimize second scan by cropping based on first scan results")
        parser.add_argument("--use_window_for_config", action="store_true",
                            help="Use the specified window for loading OCR configuration")
        parser.add_argument("--keep_newline", action="store_true",
                            help="Keep new lines in OCR output")
        parser.add_argument('--obs_ocr', action='store_true',
                            help='Use OBS for Picture Source (not implemented)')
        parser.add_argument("--global_pause_hotkey", type=str, default="ctrl+shift+p",
                            help="Hotkey to pause/resume OCR scanning (default: ctrl+shift+p)")

        args = parser.parse_args()

        language = args.language
        ocr1 = args.ocr1
        ocr2 = args.ocr2 if args.ocr2 else None
        twopassocr = bool(args.twopassocr)
        manual = args.manual
        ss_clipboard = args.clipboard
        window_name = args.window
        furigana_filter_sensitivity = args.furigana_filter_sensitivity
        ss_hotkey = args.area_select_ocr_hotkey.lower()
        manual_ocr_hotkey = args.manual_ocr_hotkey.lower().replace("ctrl", "<ctrl>").replace("shift",
                                                                                             "<shift>").replace(
            "alt", "<alt>") if args.manual_ocr_hotkey else None
        clipboard_output = args.clipboard_output
        optimize_second_scan = args.optimize_second_scan
        use_window_for_config = args.use_window_for_config
        keep_newline = args.keep_newline
        obs_ocr = args.obs_ocr
        global_pause_hotkey = args.global_pause_hotkey.lower(
        ) if args.global_pause_hotkey else "ctrl+shift+p"

        obs.connect_to_obs_sync(check_output=False)

        # Override furigana from per-scene settings (takes priority over CLI arg)
        try:
            scene_furigana = get_scene_furigana_filter_sensitivity(
                use_window_as_config=use_window_for_config, window=window_name
            )
            if scene_furigana > 0 or furigana_filter_sensitivity == 0:
                furigana_filter_sensitivity = scene_furigana
                logger.info(f"Using per-scene furigana_filter_sensitivity: {furigana_filter_sensitivity}")
        except Exception:
            pass  # Fall back to CLI arg

        window = None
        logger.info(f"Received arguments: {vars(args)}")
        # set_force_stable_hotkey()
        ocr_config: OCRConfig = get_ocr_config(
            window=window_name, use_window_for_config=use_window_for_config)
        if ocr_config and not obs_ocr:
            if ocr_config.window:
                start_time = time.time()
                while time.time() - start_time < 30:
                    window = get_window(ocr_config.window)
                    if window or manual:
                        if window:
                            ocr_config.scale_coords()
                        break
                    logger.background(
                        f"Window: {ocr_config.window} Could not be found, retrying in 1 second...")
                    time.sleep(1)
                else:
                    logger.error(
                        f"Window '{ocr_config.window}' not found within 30 seconds.")
                    sys.exit(1)
            logger.info(
                f"Starting OCR with configuration: Window: {ocr_config.window}, Rectangles: {ocr_config.rectangles}, Engine 1: {ocr1}, Engine 2: {ocr2}, Two-pass OCR: {twopassocr}")
        set_dpi_awareness()
        if manual or ocr_config:
            # Create the Qt app on the main thread before any worker/hotkey threads
            # to avoid Qt initialization from background threads.
            import GameSentenceMiner.ui.qt_main as qt_main
            settings_window = qt_main.get_config_window()

            rectangles = ocr_config.rectangles if ocr_config and ocr_config.rectangles else []
            oneocr_threads = []
            ocr_thread = threading.Thread(target=run_oneocr, args=(
                ocr_config, rectangles), daemon=True)
            ocr_thread.start()
            # Always start worker thread to process manual screenshots from screen cropper
            worker_thread = threading.Thread(
                target=process_task_queue, daemon=True)
            worker_thread.start()

            # Start IPC listener for Electron communication
            ocr_ipc.register_command_handler(handle_ipc_command)
            ocr_ipc.start_ipc_listener()
            ocr_ipc.announce_started()
            logger.info("OCR IPC communication initialized")

            # Keep websocket for backward compatibility with texthooker page
            websocket_server_thread = WebsocketServerThread(read=True)
            websocket_server_thread.start()

            if is_windows():
                add_ss_hotkey(ss_hotkey)
            try:
                # Run Qt event loop instead of sleep loop - this allows Qt dialogs to work
                qt_main.start_qt_app(show_config_immediately=False)
            except KeyboardInterrupt:
                pass
        else:
            print("Failed to load OCR configuration. Please check the logs.")
    except Exception as e:
        logger.info(e, exc_info=True)
        logger.debug(e, exc_info=True)
        logger.info("Closing in 5 seconds...")
        time.sleep(5)
