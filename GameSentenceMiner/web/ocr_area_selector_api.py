import json
import math
from io import BytesIO
from pathlib import Path

from flask import jsonify, render_template, request, send_file

from GameSentenceMiner import obs
from GameSentenceMiner.ocr import gsm_ocr_config
from GameSentenceMiner.ocr.gsm_ocr_config import get_ocr_config_path, write_ocr_config
from GameSentenceMiner.util.config.configuration import logger
from GameSentenceMiner.util.gsm_utils import sanitize_filename

COORDINATE_SYSTEM_PERCENTAGE = "percentage"
DEFAULT_IMAGE_WIDTH = 1920
DEFAULT_IMAGE_HEIGHT = 1080


def _validate_config_name(raw_name) -> str:
    if not isinstance(raw_name, str) or not raw_name.strip():
        raise ValueError("An OCR config name is required.")

    name = raw_name.strip()
    if not name.lower().endswith(".json"):
        name = f"{name}.json"
    path = Path(name)
    has_invalid_character = any(character in '<>:"/\\|?*' or ord(character) < 32 for character in name)
    if path.name != name or has_invalid_character or not path.stem:
        raise ValueError("Invalid OCR config name.")
    return name


def _config_path(raw_name) -> Path:
    name = _validate_config_name(raw_name)
    root = Path(get_ocr_config_path()).resolve()
    path = (root / name).resolve()
    if path.parent != root:
        raise ValueError("Invalid OCR config path.")
    return path


def _read_json_object(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as config_file:
        data = json.load(config_file)
    if not isinstance(data, dict):
        raise TypeError("OCR config must contain a JSON object.")
    return data


def _is_area_config(data: dict) -> bool:
    return isinstance(data.get("rectangles"), list) or isinstance(data.get("rects"), list)


def _positive_dimension(value, default: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed > 0 else default


def _get_image_size(config: dict) -> tuple[int, int]:
    window_geometry = config.get("window_geometry")
    if isinstance(window_geometry, dict):
        return (
            _positive_dimension(window_geometry.get("width"), DEFAULT_IMAGE_WIDTH),
            _positive_dimension(window_geometry.get("height"), DEFAULT_IMAGE_HEIGHT),
        )

    rectangles = config.get("rectangles")
    if isinstance(rectangles, list):
        for rectangle in rectangles:
            monitor = rectangle.get("monitor") if isinstance(rectangle, dict) else None
            if isinstance(monitor, dict) and monitor.get("width") and monitor.get("height"):
                return (
                    _positive_dimension(monitor.get("width"), DEFAULT_IMAGE_WIDTH),
                    _positive_dimension(monitor.get("height"), DEFAULT_IMAGE_HEIGHT),
                )
    return DEFAULT_IMAGE_WIDTH, DEFAULT_IMAGE_HEIGHT


def _finite_number(value) -> float:
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("Rectangle coordinates must be finite numbers.")
    return number


def _coordinates_to_percentage(coordinates, coordinate_system: str, width: int, height: int) -> list[float]:
    if not isinstance(coordinates, (list, tuple)) or len(coordinates) != 4:
        raise ValueError("Each rectangle must have four coordinates.")
    x, y, rect_width, rect_height = [_finite_number(value) for value in coordinates]
    if coordinate_system != COORDINATE_SYSTEM_PERCENTAGE:
        x /= width
        rect_width /= width
        y /= height
        rect_height /= height
    return [x, y, rect_width, rect_height]


def _normalize_monitor(value, default_index=0) -> dict:
    monitor = value if isinstance(value, dict) else {}
    normalized = {"index": int(monitor.get("index", default_index) or 0)}
    for key in ("left", "top", "width", "height"):
        if monitor.get(key) is not None:
            normalized[key] = int(monitor[key])
    return normalized


def _rectangle_payload(rectangle: dict, coordinates: list[float], default_monitor_index=0) -> dict:
    return {
        "monitor": _normalize_monitor(rectangle.get("monitor"), default_monitor_index),
        "coordinates": coordinates,
        "is_excluded": bool(rectangle.get("is_excluded", False)),
        "is_secondary": bool(rectangle.get("is_secondary", False)),
        "is_exclusive": bool(rectangle.get("is_exclusive", False)),
        "is_black_hole": bool(rectangle.get("is_black_hole", False)),
    }


def _config_for_browser(name: str, config: dict) -> dict:
    width, height = _get_image_size(config)
    coordinate_system = config.get("coordinate_system") or COORDINATE_SYSTEM_PERCENTAGE
    rectangles = []
    source_rectangles = config.get("rectangles")
    if isinstance(source_rectangles, list):
        for rectangle in source_rectangles:
            if not isinstance(rectangle, dict):
                continue
            coordinates = _coordinates_to_percentage(
                rectangle.get("coordinates"),
                coordinate_system,
                width,
                height,
            )
            rectangles.append(_rectangle_payload(rectangle, coordinates))
    else:
        default_monitor_index = int(config.get("monitor_index", 0) or 0)
        for rectangle in config.get("rects", []):
            if not isinstance(rectangle, dict):
                continue
            coordinates = _coordinates_to_percentage(
                [rectangle.get("x"), rectangle.get("y"), rectangle.get("w"), rectangle.get("h")],
                coordinate_system,
                width,
                height,
            )
            rectangles.append(_rectangle_payload(rectangle, coordinates, default_monitor_index))

    return {
        "name": name,
        "scene": config.get("scene") or Path(name).stem.removesuffix("_overlay"),
        "is_overlay": Path(name).stem.endswith("_overlay"),
        "image_size": {"width": width, "height": height},
        "rectangles": rectangles,
    }


def _clamp(value: float, lower: float, upper: float) -> float:
    return max(lower, min(upper, value))


def _rectangle_for_save(rectangle: dict, is_overlay: bool) -> dict:
    if not isinstance(rectangle, dict):
        raise TypeError("Each rectangle must be an object.")
    x, y, width, height = _coordinates_to_percentage(
        rectangle.get("coordinates"),
        COORDINATE_SYSTEM_PERCENTAGE,
        1,
        1,
    )
    x = _clamp(x, 0.0, 1.0)
    y = _clamp(y, 0.0, 1.0)
    width = _clamp(width, 0.0, 1.0 - x)
    height = _clamp(height, 0.0, 1.0 - y)
    if width <= 0 or height <= 0:
        raise ValueError("Rectangle width and height must be greater than zero.")

    saved = _rectangle_payload(rectangle, [x, y, width, height])
    if is_overlay:
        saved["is_secondary"] = False
        saved["is_exclusive"] = False
        saved["is_black_hole"] = False
    return saved


def _invalidate_ocr_config_caches() -> None:
    gsm_ocr_config.scene_ocr_config = None
    try:
        from GameSentenceMiner.owocr.owocr import ocr_runtime

        ocr_runtime.clear_scaled_ocr_config_cache()
    except Exception as error:  # noqa: BLE001 - cache invalidation must not make a successful save fail
        logger.debug(f"Could not clear the scaled OCR config cache: {error}")


def _current_scene_config() -> tuple[Path, dict]:
    scene = sanitize_filename(str(obs.get_current_scene() or "Default")).strip() or "Default"
    path = _config_path(scene)
    if path.exists():
        config = _read_json_object(path)
        if not _is_area_config(config):
            raise TypeError("The current scene file is not an OCR area config.")
        return path, config

    config = {
        "scene": scene,
        "coordinate_system": COORDINATE_SYSTEM_PERCENTAGE,
        "rectangles": [],
    }
    write_ocr_config(path, config)
    return path, config


def register_ocr_area_selector_routes(app):
    @app.route("/select_areas")
    def select_areas_page():
        return render_template("select_areas.html")

    @app.route("/api/ocr-area-selector/configs", methods=["GET"])
    def list_ocr_area_configs():
        config_root = Path(get_ocr_config_path())
        configs = []
        for path in sorted(config_root.glob("*.json"), key=lambda item: item.name.casefold()):
            try:
                data = _read_json_object(path)
            except (OSError, TypeError, ValueError, json.JSONDecodeError):
                continue
            if not _is_area_config(data):
                continue
            configs.append(
                {
                    "name": path.name,
                    "scene": data.get("scene") or path.stem.removesuffix("_overlay"),
                    "is_overlay": path.stem.endswith("_overlay"),
                }
            )
        return jsonify({"configs": configs})

    @app.route("/api/ocr-area-selector/config", methods=["GET"])
    def load_ocr_area_config():
        try:
            path = _config_path(request.args.get("name"))
            if not path.exists():
                return jsonify({"error": "OCR config not found."}), 404
            config = _read_json_object(path)
            if not _is_area_config(config):
                return jsonify({"error": "The selected file is not an OCR area config."}), 400
            return jsonify(_config_for_browser(path.name, config))
        except (ValueError, TypeError) as error:
            return jsonify({"error": str(error)}), 400
        except (OSError, json.JSONDecodeError) as error:
            return jsonify({"error": f"Could not read OCR config: {error}"}), 500

    @app.route("/api/ocr-area-selector/current-config", methods=["GET"])
    def load_current_ocr_area_config():
        try:
            path, config = _current_scene_config()
            return jsonify(_config_for_browser(path.name, config))
        except (ValueError, TypeError) as error:
            return jsonify({"error": str(error)}), 400
        except (OSError, json.JSONDecodeError) as error:
            return jsonify({"error": f"Could not load the current scene OCR config: {error}"}), 500

    @app.route("/api/ocr-area-selector/config", methods=["POST"])
    def save_ocr_area_config():
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return jsonify({"error": "A JSON request body is required."}), 400
        try:
            path = _config_path(payload.get("name"))
            existing = _read_json_object(path) if path.exists() else {}
            is_overlay = path.stem.endswith("_overlay")
            rectangles = payload.get("rectangles")
            if not isinstance(rectangles, list):
                raise TypeError("rectangles must be a list.")
            saved_rectangles = [_rectangle_for_save(rectangle, is_overlay) for rectangle in rectangles]

            image_size = payload.get("image_size") if isinstance(payload.get("image_size"), dict) else {}
            image_width = _positive_dimension(image_size.get("width"), DEFAULT_IMAGE_WIDTH)
            image_height = _positive_dimension(image_size.get("height"), DEFAULT_IMAGE_HEIGHT)

            saved = dict(existing)
            saved.pop("rects", None)
            saved.pop("monitor_index", None)
            saved["scene"] = existing.get("scene") or path.stem.removesuffix("_overlay")
            saved["coordinate_system"] = COORDINATE_SYSTEM_PERCENTAGE
            saved["rectangles"] = saved_rectangles
            if not isinstance(saved.get("window_geometry"), dict):
                saved["window_geometry"] = {
                    "left": 0,
                    "top": 0,
                    "width": image_width,
                    "height": image_height,
                }

            write_ocr_config(path, saved)
            _invalidate_ocr_config_caches()
            return jsonify(
                {
                    "message": f"Saved {len(saved_rectangles)} OCR areas.",
                    "config": _config_for_browser(path.name, saved),
                }
            )
        except (ValueError, TypeError, OverflowError) as error:
            return jsonify({"error": str(error)}), 400
        except (OSError, json.JSONDecodeError) as error:
            logger.error(f"Could not save OCR areas: {error}")
            return jsonify({"error": f"Could not save OCR areas: {error}"}), 500

    @app.route("/api/ocr-area-selector/screenshot", methods=["GET"])
    def capture_ocr_area_screenshot():
        try:
            image = obs.get_screenshot_PIL(
                compression=90,
                img_format="jpg",
                retry=1,
                suppress_errors=True,
            )
            if image is None:
                return jsonify({"error": "No active OBS video source is available."}), 503
            if image.mode not in ("RGB", "L"):
                image = image.convert("RGB")
            output = BytesIO()
            image.save(output, format="JPEG", quality=90)
            output.seek(0)
            response = send_file(output, mimetype="image/jpeg", download_name="ocr-area-source.jpg")
            response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
            return response
        except Exception as error:  # noqa: BLE001 - OBS backends expose platform-specific exceptions
            logger.warning(f"Could not capture an OCR area selector screenshot: {error}")
            return jsonify({"error": "Could not capture the current OBS frame."}), 503
