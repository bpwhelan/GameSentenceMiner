"""Disposable memory-audit helpers for GSM's Python OCR/startup paths.

This is intentionally a measurement script rather than application code.  Each
invocation is designed to run in a fresh process so native allocations and
Python module imports can be attributed to one stage.  Example:

    .venv\\Scripts\\python.exe scripts\\gsm_memory_audit.py import \
        GameSentenceMiner.ocr.gsm_ocr

The script reports RSS/working-set and USS.  On Windows, ``private`` from
psutil can include large reserved virtual regions for extension modules, so it
is retained only as an informational field and should not be treated as live
RAM.
"""

from __future__ import annotations

import argparse
import gc
import importlib
import inspect
import json
import os
import queue
import sys
import tempfile
import threading
import time
import tracemalloc
from pathlib import Path
from typing import Any

import psutil

ROOT = Path(__file__).resolve().parents[1]
AUDIT_DATA_ROOT = Path(tempfile.gettempdir()) / "gamesentenceminer-memory-audit"
os.environ.setdefault("GAME_SENTENCE_MINER_TESTING", "1")
os.environ.setdefault("GSM_TEST_DATA_ROOT", str(AUDIT_DATA_ROOT))
PROCESS = psutil.Process()
SUMMARY_ONLY = False


def _mib(value: int | None) -> float | None:
    return round(value / (1024 * 1024), 3) if value is not None else None


def _memory(label: str) -> dict[str, Any]:
    gc.collect()
    info = PROCESS.memory_full_info()
    traced_current, traced_peak = tracemalloc.get_traced_memory()
    result = {
        "label": label,
        "rss_mib": _mib(getattr(info, "rss", None)),
        "working_set_mib": _mib(getattr(info, "wset", None)),
        "uss_mib": _mib(getattr(info, "uss", None)),
        "vms_mib": _mib(getattr(info, "vms", None)),
        "private_mib": _mib(getattr(info, "private", None)),
        "peak_working_set_mib": _mib(getattr(info, "peak_wset", None)),
        "tracemalloc_current_mib": _mib(traced_current),
        "tracemalloc_peak_mib": _mib(traced_peak),
        "python_modules": len(sys.modules),
        "threads": threading.active_count(),
    }
    return result


def _delta(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    keys = (
        "rss_mib",
        "working_set_mib",
        "uss_mib",
        "vms_mib",
        "private_mib",
        "tracemalloc_current_mib",
    )
    return {key: round((after[key] or 0) - (before[key] or 0), 3) for key in keys}


def _snapshot(label: str) -> dict[str, Any]:
    return _memory(label)


def _print(payload: dict[str, Any]) -> None:
    if SUMMARY_ONLY:
        summary = {
            key: value
            for key, value in payload.items()
            if key == "stages"
            or key.startswith("delta_")
            or key
            in {
                "module",
                "engines",
                "overlay_engine",
                "model",
                "held_images",
                "calls",
                "runtime",
                "stage_deltas",
            }
        }
        print(json.dumps(summary, ensure_ascii=False, indent=2, default=str))
        return
    print(json.dumps(payload, ensure_ascii=False, indent=2, default=str))


def _top_tracemalloc(limit: int = 15) -> list[dict[str, Any]]:
    if not tracemalloc.is_tracing():
        return []
    snapshot = tracemalloc.take_snapshot()
    entries = []
    for stat in snapshot.statistics("lineno")[:limit]:
        frame = stat.traceback[0]
        entries.append(
            {
                "file": str(frame.filename),
                "line": frame.lineno,
                "size_mib": round(stat.size / (1024 * 1024), 3),
                "count": stat.count,
            }
        )
    return entries


def _import_module(name: str) -> tuple[dict[str, Any], Any]:
    before_modules = set(sys.modules)
    before = _snapshot("before_import")
    module = importlib.import_module(name)
    time.sleep(0.25)
    after = _snapshot("after_import")
    new_modules = sorted(set(sys.modules) - before_modules)
    return (
        {
            "module": name,
            "stages": [before, after],
            "delta_after_import": _delta(before, after),
            "new_module_count": len(new_modules),
            "new_modules_sample": new_modules[:50],
            "tracemalloc_top": _top_tracemalloc(),
        },
        module,
    )


def mode_import(args: argparse.Namespace) -> None:
    result, _ = _import_module(args.module)
    _print(result)


def mode_lazy(args: argparse.Namespace) -> None:
    result, gsm = _import_module("GameSentenceMiner.gsm")
    before = _snapshot(f"before_{args.helper}")
    value = getattr(gsm, args.helper)()
    time.sleep(0.25)
    after = _snapshot(f"after_{args.helper}")
    result["stages"].extend([before, after])
    result[f"delta_{args.helper}"] = _delta(before, after)
    result["returned_type"] = type(value).__name__
    result["returned_module"] = getattr(value, "__name__", getattr(type(value), "__module__", None))
    result["modules_after_helper"] = len(sys.modules)
    result["tracemalloc_top_after_helper"] = _top_tracemalloc()
    _print(result)


def mode_app_init(args: argparse.Namespace) -> None:
    result, gsm = _import_module("GameSentenceMiner.gsm")
    before = _snapshot("before_gsm_application_init")
    app = gsm.GSMApplication()
    time.sleep(0.25)
    after = _snapshot("after_gsm_application_init")
    result["stages"].extend([before, after])
    result["delta_gsm_application_init"] = _delta(before, after)
    result["application_attributes"] = sorted(app.__dict__.keys())
    result["managed_threads"] = [thread.name for thread in app._threads]
    result["state_attributes"] = sorted(app.state.__dict__.keys())
    _print(result)
    sys.stdout.flush()
    os._exit(0)


def mode_ocr_init(args: argparse.Namespace) -> None:
    result, gsm_ocr = _import_module("GameSentenceMiner.ocr.gsm_ocr")
    before_processor = _snapshot("before_second_ocr_processor")
    processor = gsm_ocr.get_second_ocr_processor()
    after_processor = _snapshot("after_second_ocr_processor")
    before_controller = _snapshot("before_ocr_controller")
    controller = gsm_ocr.get_controller()
    after_controller = _snapshot("after_ocr_controller")
    result["stages"].extend([before_processor, after_processor, before_controller, after_controller])
    result["delta_second_ocr_processor"] = _delta(before_processor, after_processor)
    result["delta_ocr_controller"] = _delta(before_controller, after_controller)
    result["processor_type"] = type(processor).__name__
    result["controller_type"] = type(controller).__name__
    result["controller_attributes"] = sorted(controller.__dict__.keys())
    _print(result)


def mode_gsm_startup(args: argparse.Namespace) -> None:
    result, gsm = _import_module("GameSentenceMiner.gsm")
    app_before = _snapshot("before_gsm_application_init")
    app = gsm.GSMApplication()
    app_after = _snapshot("after_gsm_application_init")
    result["stages"].extend([app_before, app_after])
    result["delta_gsm_application_init"] = _delta(app_before, app_after)
    result["application_type"] = type(app).__name__
    result["stage_deltas"] = []

    helpers = (
        "_get_anki_module",
        "_get_gametext_module",
        "_get_texthooking_page_module",
        "_get_overlay_coords_module",
        "_get_qt_main_module",
    )
    for helper in helpers:
        before = _snapshot(f"before_{helper}")
        value = getattr(gsm, helper)()
        after = _snapshot(f"after_{helper}")
        result["stages"].extend([before, after])
        result["stage_deltas"].append({"stage": helper, "delta": _delta(before, after)})
        result[f"returned_{helper}"] = type(value).__name__

    before_vad = _snapshot("before_vad_ensure_initialized")
    system = gsm._get_vad_processor()
    system.ensure_initialized()
    after_vad = _snapshot("after_vad_ensure_initialized")
    result["stages"].extend([before_vad, after_vad])
    result["stage_deltas"].append({"stage": "vad.ensure_initialized", "delta": _delta(before_vad, after_vad)})
    result["vad_processors"] = {
        name: type(getattr(system, name, None)).__name__ if getattr(system, name, None) is not None else None
        for name in ("firered", "silero", "whisper")
    }

    if args.vad_model:
        processor = system._get_processor(args.vad_model.upper())
        before_model = _snapshot(f"before_vad_{args.vad_model}_model")
        processor._ensure_model()
        after_model = _snapshot(f"after_vad_{args.vad_model}_model")
        result["stages"].extend([before_model, after_model])
        result["stage_deltas"].append(
            {"stage": f"vad.{args.vad_model}.model", "delta": _delta(before_model, after_model)}
        )

    _print(result)
    sys.stdout.flush()
    os._exit(0)


def mode_overlay(args: argparse.Namespace) -> None:
    result, overlay = _import_module("GameSentenceMiner.util.overlay.get_overlay_coords")
    processor = overlay.overlay_processor
    before_init = _snapshot("before_overlay_init")
    processor.init()
    after_init = _snapshot("after_overlay_init")
    before_engine = _snapshot("before_overlay_engine")
    engine = overlay.OneOCR(lang="ja", get_furigana_sens_from_file=False)
    processor.oneocr = engine
    after_engine = _snapshot("after_overlay_engine")
    result["stages"].extend([before_init, after_init, before_engine, after_engine])
    result["delta_overlay_init"] = _delta(before_init, after_init)
    result["delta_overlay_engine"] = _delta(before_engine, after_engine)
    result["overlay_engine"] = {
        "configured": getattr(overlay.get_overlay_config(), "engine_v2", None),
        "class": type(engine).__name__,
        "available": getattr(engine, "available", None),
    }
    _print(result)


def _find_engine(runtime: Any, requested: str) -> type:
    requested = requested.strip().lower()
    candidates = []
    for value in vars(runtime).values():
        if inspect.isclass(value) and getattr(value, "name", ""):
            candidates.append(value)
            if str(value.name).lower() == requested:
                return value
    names = sorted({str(getattr(item, "name", "")) for item in candidates})
    raise LookupError(f"Engine {requested!r} was not found. Available: {names}")


def _instantiate_engine(runtime: Any, name: str) -> Any:
    engine_class = _find_engine(runtime, name)
    signature = inspect.signature(engine_class)
    if "config" in signature.parameters:
        try:
            config = runtime.config.get_engine(engine_class.name)
        except (AttributeError, KeyError, RuntimeError, TypeError, ValueError):
            config = None
        if config is None:
            return engine_class()
        return engine_class(config, lang="ja")
    if "lang" in signature.parameters:
        return engine_class(lang="ja")
    return engine_class()


def mode_runtime(args: argparse.Namespace) -> None:
    result, runtime = _import_module("GameSentenceMiner.owocr.owocr.ocr_runtime")
    before_config = _snapshot("before_init_config")
    runtime.init_config(False)
    after_config = _snapshot("after_init_config")
    result["stages"].extend([before_config, after_config])
    result["delta_init_config"] = _delta(before_config, after_config)
    result["engines"] = []
    instances = []

    for name in args.engine.split(",") if args.engine else []:
        name = name.strip()
        if not name:
            continue
        before_engine = _snapshot(f"before_engine_{name}")
        try:
            instance = _instantiate_engine(runtime, name)
            error = None
        except SystemExit as exc:  # native OCR loaders can raise SystemExit
            instance = None
            error = f"{type(exc).__name__}: {exc}"
        except Exception as exc:  # noqa: BLE001 - preserve loader failure details
            instance = None
            error = f"{type(exc).__name__}: {exc}"
        time.sleep(0.25)
        after_engine = _snapshot(f"after_engine_{name}")
        result["stages"].extend([before_engine, after_engine])
        result["engines"].append(
            {
                "requested": name,
                "class": type(instance).__name__ if instance is not None else None,
                "available": getattr(instance, "available", None),
                "error": error,
                "delta": _delta(before_engine, after_engine),
            }
        )
        if instance is not None:
            instances.append(instance)

    result["engine_instances_before_runtime"] = [
        type(item).__name__ for item in getattr(runtime, "engine_instances", [])
    ]
    result["tracemalloc_top"] = _top_tracemalloc()
    _print(result)


def mode_runtime_start(args: argparse.Namespace) -> None:
    result, runtime = _import_module("GameSentenceMiner.owocr.owocr.ocr_runtime")
    runtime.init_config(False)
    before_start = _snapshot("before_runtime_start")
    errors: list[str] = []

    def run_runtime() -> None:
        try:
            runtime.run(
                read_from="",
                read_from_secondary="",
                write_to="callback",
                ocr1=args.ocr1,
                ocr2=args.ocr2,
                disable_user_input=True,
                configure_logger=False,
                include_configured_engines=False,
            )
        except Exception as exc:  # noqa: BLE001 - report runtime setup failures
            errors.append(f"{type(exc).__name__}: {exc}")

    thread = threading.Thread(target=run_runtime, name="gsm-memory-audit-runtime")
    thread.start()
    thread.join(timeout=args.seconds)
    after_start = _snapshot("after_runtime_start")
    still_running = thread.is_alive()
    if still_running:
        runtime.terminated = True
        thread.join(timeout=10)
    after_stop = _snapshot("after_runtime_stop")
    result["stages"].extend([before_start, after_start, after_stop])
    result["delta_runtime_start"] = _delta(before_start, after_start)
    result["delta_runtime_stop"] = _delta(after_start, after_stop)
    result["runtime"] = {
        "ocr1": args.ocr1,
        "ocr2": args.ocr2,
        "engine_names": [getattr(item, "name", type(item).__name__) for item in runtime.engine_instances],
        "errors": errors,
        "still_running_after_stop": thread.is_alive(),
    }
    _print(result)


def mode_ocr_workload(args: argparse.Namespace) -> None:
    result, runtime = _import_module("GameSentenceMiner.owocr.owocr.ocr_runtime")
    from PIL import Image

    runtime.init_config(False)
    before_engine = _snapshot("before_workload_engine")
    engine = _instantiate_engine(runtime, args.engine)
    after_engine = _snapshot("after_workload_engine")
    image = Image.open(args.image).convert("RGB")
    image.load()
    result["stages"].extend([before_engine, after_engine])
    result["delta_workload_engine_init"] = _delta(before_engine, after_engine)
    result["image"] = str(args.image)
    result["image_size"] = image.size
    result["calls"] = []

    for index in range(args.count):
        before_call = _snapshot(f"before_ocr_call_{index + 1}")
        try:
            output = engine(image, 0)
            error = None
        except Exception as exc:  # noqa: BLE001 - diagnostic should continue after backend errors
            output = None
            error = f"{type(exc).__name__}: {exc}"
        after_call = _snapshot(f"after_ocr_call_{index + 1}")
        result["stages"].extend([before_call, after_call])
        result["calls"].append(
            {
                "index": index + 1,
                "error": error,
                "result_type": type(output).__name__ if output is not None else None,
                "delta": _delta(before_call, after_call),
            }
        )
        del output
        gc.collect()

    result["after_workload"] = _snapshot("after_workload")
    image.close()
    _print(result)


def mode_vad(args: argparse.Namespace) -> None:
    result, vad = _import_module("GameSentenceMiner.vad")
    before_system = _snapshot("before_vad_system_init")
    system = vad.vad_processor
    system.ensure_initialized()
    after_system = _snapshot("after_vad_system_init")
    result["stages"].extend([before_system, after_system])
    result["delta_vad_system_init"] = _delta(before_system, after_system)
    result["processors"] = {
        name: type(getattr(system, name, None)).__name__ if getattr(system, name, None) is not None else None
        for name in ("firered", "silero", "whisper")
    }
    if args.model:
        model_name = args.model.lower()
        model_constants = {
            "firered": vad.configuration.FIRERED,
            "silero": vad.configuration.SILERO,
            "whisper": vad.configuration.WHISPER,
        }
        processor = system._get_processor(model_constants[model_name])
        before_model = _snapshot(f"before_{model_name}_model")
        try:
            processor._ensure_model()
            error = None
        except Exception as exc:  # noqa: BLE001 - model loaders vary by backend
            error = f"{type(exc).__name__}: {exc}"
        time.sleep(0.5)
        after_model = _snapshot(f"after_{model_name}_model")
        result["stages"].extend([before_model, after_model])
        result["model"] = {
            "name": model_name,
            "error": error,
            "delta": _delta(before_model, after_model),
            "processor_attributes": sorted(getattr(processor, "__dict__", {}).keys()),
        }
    result["tracemalloc_top"] = _top_tracemalloc()
    _print(result)


def _image_info(image: Any) -> dict[str, Any]:
    if image is None:
        return {"present": False}
    result = {
        "present": True,
        "type": type(image).__name__,
        "size": getattr(image, "size", None),
        "mode": getattr(image, "mode", None),
    }
    try:
        result["bytes"] = len(image.tobytes())
    except (AttributeError, OSError, TypeError, ValueError):
        result["bytes"] = None
    return result


def mode_image_cache(args: argparse.Namespace) -> None:
    result, runtime = _import_module("GameSentenceMiner.owocr.owocr.ocr_runtime")
    from PIL import Image

    image = Image.new(args.mode, (args.width, args.height), color=0)
    before = _snapshot("before_set_last_image")
    runtime.set_last_image(image)
    after = _snapshot("after_set_last_image")
    cached = getattr(runtime, "last_image", None)
    cached_np = getattr(runtime, "last_image_np", None)
    result["stages"].extend([before, after])
    result["delta_set_last_image"] = _delta(before, after)
    result["source_image"] = _image_info(image)
    result["cached_image"] = _image_info(cached)
    result["cached_numpy"] = {
        "type": type(cached_np).__name__ if cached_np is not None else None,
        "shape": getattr(cached_np, "shape", None),
        "dtype": str(getattr(cached_np, "dtype", "")) if cached_np is not None else None,
        "nbytes": getattr(cached_np, "nbytes", None),
        "writeable": getattr(cached_np.flags, "writeable", None) if cached_np is not None else None,
    }
    runtime.set_last_image(None)
    image.close()
    after_clear = _snapshot("after_clear_last_image")
    result["stages"].append(after_clear)
    result["delta_clear_last_image"] = _delta(after, after_clear)
    _print(result)


def _controller_callbacks() -> dict[str, Any]:
    return {
        "run_second_ocr": lambda *args, **kwargs: None,
        "send_result": lambda *args, **kwargs: None,
        "save_image": lambda *args, **kwargs: None,
        "get_ocr2_image": lambda crop_coords, image, extra_padding=0: image,
        "queue_second_pass": lambda *args, **kwargs: True,
    }


def mode_controller(args: argparse.Namespace) -> None:
    result, gsm_ocr = _import_module("GameSentenceMiner.ocr.gsm_ocr")
    from PIL import Image

    callbacks = _controller_callbacks()
    config = gsm_ocr.TwoPassConfig(
        two_pass_enabled=True,
        ocr1_engine="oneocr",
        ocr2_engine="glens",
        optimize_second_scan=True,
        text_appears_instantly=False,
    )
    controller_class = gsm_ocr.TwoPassOCRControllerV2 if args.version == "v2" else gsm_ocr.TwoPassOCRController
    controller = controller_class(config=config, **callbacks)
    image = Image.new(args.mode, (args.width, args.height), color=0)
    before = _snapshot("before_controller_frame")
    try:
        detection_boxes = [{"box": (0, 0, args.width, args.height)}] if args.detection else None
        controller.handle_ocr_result(
            text="テスト",
            orig_text=["テスト"],
            img=image,
            crop_coords=(0, 0, args.width, args.height),
            detection_boxes=detection_boxes,
            response_dict={"sample": True},
            source="audit",
        )
        error = None
    except Exception as exc:  # noqa: BLE001 - diagnostic should continue after callback errors
        error = f"{type(exc).__name__}: {exc}"
    after = _snapshot("after_controller_frame")
    result["stages"].extend([before, after])
    result["delta_controller_frame"] = _delta(before, after)
    result["controller_class"] = controller_class.__name__
    result["error"] = error
    result["controller_attributes"] = sorted(controller.__dict__.keys())
    result["held_images"] = {
        "pending": _image_info(getattr(getattr(controller, "_pending", None), "img", None)),
        "v2_pending_text": _image_info(getattr(getattr(controller, "_v2_pending_text", None), "img", None)),
        "v2_pending_detection": _image_info(getattr(getattr(controller, "_v2_pending_detection", None), "img", None)),
        "meiki_previous": _image_info(getattr(getattr(controller, "_meiki", None), "previous_img", None)),
    }
    result["source_image"] = _image_info(image)
    _print(result)


def _drain_queue(q: Any) -> None:
    while True:
        try:
            q.get_nowait()
            q.task_done()
        except queue.Empty:
            return


def mode_queue(args: argparse.Namespace) -> None:
    result, gsm_ocr = _import_module("GameSentenceMiner.ocr.gsm_ocr")
    from PIL import Image

    q = gsm_ocr.second_ocr_queue
    before = _snapshot("before_queue_fill")
    bytes_per_pixel = len(Image.new(args.mode, (1, 1)).tobytes())
    image_bytes = args.width * args.height * bytes_per_pixel * args.count * (2 if args.double else 1)
    for index in range(args.count):
        first = Image.new(args.mode, (args.width, args.height), color=index % 255)
        second = None
        if args.double:
            second = Image.new(args.mode, (args.width, args.height), color=(index + 1) % 255)
        gsm_ocr._put_latest_second_ocr_task(("text", None, first, None, second))
    after = _snapshot("after_queue_fill")
    result["stages"].extend([before, after])
    result["delta_queue_fill"] = _delta(before, after)
    result["queue_size"] = q.qsize()
    result["queue_maxsize"] = q.maxsize
    result["image_payload_bytes"] = image_bytes
    result["image_payload_mib"] = round(image_bytes / (1024 * 1024), 3)
    _drain_queue(q)
    after_clear = _snapshot("after_queue_clear")
    result["stages"].append(after_clear)
    result["delta_clear_queue"] = _delta(after, after_clear)
    _print(result)


def mode_runtime_queue(args: argparse.Namespace) -> None:
    result, runtime = _import_module("GameSentenceMiner.owocr.owocr.ocr_runtime")
    from PIL import Image

    runtime.image_queue = queue.Queue(maxsize=runtime.CAPTURE_QUEUE_MAXSIZE)
    runtime.periodic_screenshot_queue = queue.Queue(maxsize=runtime.CAPTURE_QUEUE_MAXSIZE)
    before = _snapshot("before_runtime_queue_fill")
    bytes_per_pixel = len(Image.new(args.mode, (1, 1)).tobytes())
    image_bytes = 0
    queues = ("image_queue", "periodic_screenshot_queue") if args.both else (args.queue_name,)
    for queue_name in queues:
        target_queue = getattr(runtime, queue_name)
        for index in range(args.count):
            image = Image.new(args.mode, (args.width, args.height), color=index % 255)
            runtime._put_latest_queue_item(target_queue, (image, False, None))
            image_bytes += args.width * args.height * bytes_per_pixel
    after = _snapshot("after_runtime_queue_fill")
    result["stages"].extend([before, after])
    result["delta_runtime_queue_fill"] = _delta(before, after)
    result["queue_names"] = list(queues)
    result["queue_sizes"] = {name: getattr(runtime, name).qsize() for name in queues}
    result["queue_maxsizes"] = {name: getattr(runtime, name).maxsize for name in queues}
    result["image_payload_bytes"] = image_bytes
    result["image_payload_mib"] = round(image_bytes / (1024 * 1024), 3)
    for queue_name in queues:
        _drain_queue(getattr(runtime, queue_name))
    after_clear = _snapshot("after_runtime_queue_clear")
    result["stages"].append(after_clear)
    result["delta_clear_runtime_queue"] = _delta(after, after_clear)
    _print(result)


def main() -> None:
    global SUMMARY_ONLY
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--trace-python",
        action="store_true",
        help="Enable tracemalloc; this perturbs RSS and is for Python-allocation attribution only.",
    )
    parser.add_argument("--summary", action="store_true", help="Print only stage and delta fields.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    import_parser = subparsers.add_parser("import")
    import_parser.add_argument("module")
    import_parser.set_defaults(func=mode_import)

    lazy_parser = subparsers.add_parser("lazy")
    lazy_parser.add_argument("helper")
    lazy_parser.set_defaults(func=mode_lazy)

    app_parser = subparsers.add_parser("app-init")
    app_parser.set_defaults(func=mode_app_init)

    ocr_init_parser = subparsers.add_parser("ocr-init")
    ocr_init_parser.set_defaults(func=mode_ocr_init)

    gsm_startup_parser = subparsers.add_parser("gsm-startup")
    gsm_startup_parser.add_argument("--vad-model", choices=("firered", "silero", "whisper"), default="")
    gsm_startup_parser.set_defaults(func=mode_gsm_startup)

    overlay_parser = subparsers.add_parser("overlay")
    overlay_parser.set_defaults(func=mode_overlay)

    runtime_parser = subparsers.add_parser("runtime")
    runtime_parser.add_argument("--engine", default="")
    runtime_parser.set_defaults(func=mode_runtime)

    runtime_start_parser = subparsers.add_parser("runtime-start")
    runtime_start_parser.add_argument("--ocr1", default="oneocr")
    runtime_start_parser.add_argument("--ocr2", default="glens")
    runtime_start_parser.add_argument("--seconds", type=float, default=1.0)
    runtime_start_parser.set_defaults(func=mode_runtime_start)

    workload_parser = subparsers.add_parser("ocr-workload")
    workload_parser.add_argument("--engine", default="oneocr")
    workload_parser.add_argument(
        "--image", type=Path, default=Path(r"C:\Users\Beangate\Pictures\msedge_acbl8GL7Ax.jpg")
    )
    workload_parser.add_argument("--count", type=int, default=5)
    workload_parser.set_defaults(func=mode_ocr_workload)

    vad_parser = subparsers.add_parser("vad")
    vad_parser.add_argument("--model", default="")
    vad_parser.set_defaults(func=mode_vad)

    for name, func in (
        ("image-cache", mode_image_cache),
        ("controller", mode_controller),
        ("queue", mode_queue),
    ):
        command_parser = subparsers.add_parser(name)
        command_parser.add_argument("--width", type=int, default=1920)
        command_parser.add_argument("--height", type=int, default=1080)
        command_parser.add_argument("--mode", default="RGB")
        if name == "controller":
            command_parser.add_argument("--version", choices=("legacy", "v2"), default="v2")
            command_parser.add_argument("--detection", action="store_true")
        if name == "queue":
            command_parser.add_argument("--count", type=int, default=10)
            command_parser.add_argument("--double", action="store_true")
        command_parser.set_defaults(func=func)

    runtime_queue_parser = subparsers.add_parser("runtime-queue")
    runtime_queue_parser.add_argument("--count", type=int, default=10)
    runtime_queue_parser.add_argument(
        "--queue-name", choices=("image_queue", "periodic_screenshot_queue"), default="image_queue"
    )
    runtime_queue_parser.add_argument("--both", action="store_true")
    runtime_queue_parser.add_argument("--width", type=int, default=1920)
    runtime_queue_parser.add_argument("--height", type=int, default=1080)
    runtime_queue_parser.add_argument("--mode", default="RGB")
    runtime_queue_parser.set_defaults(func=mode_runtime_queue)

    args = parser.parse_args()
    SUMMARY_ONLY = args.summary
    if args.trace_python:
        tracemalloc.start(25)
    args.func(args)


if __name__ == "__main__":
    main()
