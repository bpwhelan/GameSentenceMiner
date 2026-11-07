"""System-first CUDA discovery, shared GPU preferences and actual model devices.

No GPU packages are installed by this module. Importing it never initializes CUDA.
"""

import ctypes
import importlib.metadata
import json
import os
import re
import sys
import tempfile
import threading
import time
from pathlib import Path

from GameSentenceMiner.util.data_directory import get_app_directory

ENGINES = ("meiki", "firered", "whisper")
SETTINGS_TOPIC = "gpu.settings"
_settings_lock = threading.Lock()
_probe_lock = threading.RLock()
_directory_handles = {}
_loaded_libraries = {}
_diagnostics = None
_diagnostics_at = 0.0
LIBRARIES = {
    "cublasLt": "cublasLt64_12.dll",
    "cublas": "cublas64_12.dll",
    "cudart": "cudart64_12.dll",
    "cufft": "cufft64_11.dll",
    "cudnn": "cudnn64_9.dll",
}


def get_gpu_directory():
    return Path(get_app_directory()) / "gpu"


def _legacy_gpu_enabled():
    from GameSentenceMiner.util.config.configuration import get_config

    return not getattr(get_config().vad, "use_cpu_for_inference_v2", True)


def get_preferences():
    defaults = {"meiki": False, "firered": False, "whisper": False}
    try:
        data = json.loads((get_gpu_directory() / "preferences.json").read_text(encoding="utf-8"))
    except FileNotFoundError:
        enabled = _legacy_gpu_enabled()
        return {**defaults, "meiki": enabled, "whisper": enabled}
    if not isinstance(data, dict) or any(key not in ENGINES or type(value) is not bool for key, value in data.items()):
        raise ValueError("Invalid GPU settings. Choose enabled or disabled for each engine again.")
    return {**defaults, **data}


def _write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=path.parent, suffix=".tmp", delete=False
        ) as file:
            temporary = file.name
            json.dump(data, file, indent=2)
            file.write("\n")
        os.replace(temporary, path)
    finally:
        if temporary is not None and os.path.exists(temporary):
            os.unlink(temporary)


def save_preferences(changes):
    if not isinstance(changes, dict):
        raise TypeError("Expected GPU settings")
    if any(key not in ENGINES or type(value) is not bool for key, value in changes.items()):
        raise ValueError("GPU settings must use enabled/disabled values for supported engines")
    with _settings_lock:
        settings = {**get_preferences(), **changes}
        _write_json(get_gpu_directory() / "preferences.json", settings)
    return settings


def gpu_enabled(engine):
    return get_preferences().get(engine, False)


def _version_key(path):
    return tuple(int(part) for part in re.findall(r"\d+", str(path)))


def library_directories():
    """NVIDIA installer locations first, PATH next, Python wheels last."""
    directories = []
    program_files = Path(os.environ.get("ProgramFiles", r"C:\Program Files"))
    toolkit = program_files / "NVIDIA GPU Computing Toolkit" / "CUDA"
    candidates = sorted(toolkit.glob("v12*/bin"), key=_version_key, reverse=True)
    for name, value in os.environ.items():
        if name.startswith("CUDA_PATH") and value:
            candidates.append(Path(value) / "bin")
    cudnn = program_files / "NVIDIA" / "CUDNN"
    candidates.extend(sorted(cudnn.glob("v9*/bin/12*"), key=_version_key, reverse=True))
    candidates.extend(sorted(cudnn.glob("v9*/bin"), key=_version_key, reverse=True))
    for name in ("CUDNN_PATH", "CUDNN_HOME"):
        if os.environ.get(name):
            root = Path(os.environ[name])
            candidates.extend([root / "bin", root])
            candidates.extend(sorted((root / "bin").glob("12*"), key=_version_key, reverse=True))
    # Current NVIDIA installers put Windows DLLs under bin/<CUDA>/x64;
    # older installers and extracted archives use the bin directory itself.
    directories.extend(
        (variant, "system") for path in candidates for variant in (path / "x64", path) if variant.is_dir()
    )
    python_directories = []
    for entry in sys.path:
        root = Path(entry) / "nvidia"
        if root.is_dir():
            python_directories.extend(path for path in sorted(root.glob("*/bin")))
    python_paths = {str(path).lower() for path in python_directories}
    directories.extend(
        (Path(path), "system")
        for path in os.environ.get("PATH", "").split(os.pathsep)
        if path and path.lower() not in python_paths
    )
    directories.extend((path, "python") for path in python_directories)
    seen = set()
    unique = []
    for path, source in directories:
        key = str(path).lower()
        if key not in seen:
            seen.add(key)
            unique.append((path, source))
    return unique


def find_library(filename):
    for directory, source in library_directories():
        path = directory / filename
        if path.is_file():
            return path, source
    return None, None


def prepare_gpu_paths():
    if sys.platform != "win32":
        return
    with _probe_lock:
        directories = [
            path
            for path, source in library_directories()
            if (source == "python" and any(path.glob("*.dll")))
            or any((path / filename).is_file() for filename in LIBRARIES.values())
        ]
        for path in directories:
            key = str(path)
            if key not in _directory_handles:
                try:
                    _directory_handles[key] = os.add_dll_directory(key)
                except OSError:
                    continue
        current = os.environ.get("PATH", "").split(os.pathsep)
        prefix = [str(path) for path in directories]
        os.environ["PATH"] = os.pathsep.join(prefix + [path for path in current if path not in prefix])


def _driver_status():
    try:
        driver = ctypes.WinDLL("nvcuda.dll")
        count = ctypes.c_int()
        if driver.cuInit(0) != 0 or driver.cuDeviceGetCount(ctypes.byref(count)) != 0 or count.value < 1:
            return {"available": False, "name": ""}
        name = ctypes.create_string_buffer(256)
        driver.cuDeviceGetName(name, len(name), 0)
        return {"available": True, "name": name.value.decode("utf-8", errors="replace")}
    except (OSError, AttributeError):
        return {"available": False, "name": ""}


def _package_version(name):
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None


def get_diagnostics(*, refresh=False):
    global _diagnostics, _diagnostics_at
    with _probe_lock:
        if not refresh and _diagnostics is not None and time.monotonic() - _diagnostics_at < 5:
            return _diagnostics
        prepare_gpu_paths()
        libraries = {}
        for key, filename in LIBRARIES.items():
            detail = {"available": False, "path": "", "source": None, "error": ""}
            candidates = library_directories() if sys.platform == "win32" else []
            for directory, source in candidates:
                path = directory / filename
                if not path.is_file():
                    continue
                detail.update(path=str(path), source=source)
                try:
                    if str(path) not in _loaded_libraries:
                        _loaded_libraries[str(path)] = ctypes.WinDLL(str(path))
                    detail["available"] = True
                    break
                except OSError as error:
                    detail["error"] = f"{path}: {error}"
            libraries[key] = detail
        try:
            import onnxruntime as ort

            onnx = {"available": "CUDAExecutionProvider" in ort.get_available_providers(), "version": ort.__version__}
        except ImportError:
            onnx = {"available": False, "version": ""}
        _diagnostics = {
            "platform": sys.platform,
            "driver": _driver_status() if sys.platform == "win32" else {"available": False, "name": ""},
            "libraries": libraries,
            "onnx": onnx,
            "whisper": {
                "available": _package_version("ctranslate2") is not None,
                "version": _package_version("ctranslate2") or "",
            },
        }
        _diagnostics_at = time.monotonic()
        return _diagnostics


def availability_reason(engine, diagnostics=None):
    diagnostics = diagnostics or get_diagnostics()
    if diagnostics["platform"] != "win32":
        return "platform"
    if not diagnostics["driver"]["available"]:
        return "driver"
    required = ("cublasLt", "cublas") if engine == "whisper" else ("cublasLt", "cublas", "cudart", "cufft")
    if not all(diagnostics["libraries"][name]["available"] for name in required):
        return "cuda"
    if not diagnostics["libraries"]["cudnn"]["available"]:
        return "cudnn"
    if not diagnostics["whisper" if engine == "whisper" else "onnx"]["available"]:
        return "whisper" if engine == "whisper" else "onnx"
    return "ready"


def should_use_gpu(engine):
    return gpu_enabled(engine) and availability_reason(engine) == "ready"


def record_runtime(engine, device, *, error=""):
    import psutil

    try:
        record = {
            "device": device,
            "error": error,
            "enabled": gpu_enabled(engine),
            "pid": os.getpid(),
            "created": psutil.Process().create_time(),
            "updated": time.time(),
        }
        _write_json(get_gpu_directory() / "runtime" / f"{os.getpid()}-{engine}.json", record)
    except (OSError, ValueError, psutil.Error):
        # Reporting must never interrupt a scan or audio operation.
        return


def get_runtime_records():
    import psutil

    result = {engine: [] for engine in ENGINES}
    for engine in ENGINES:
        for path in (get_gpu_directory() / "runtime").glob(f"*-{engine}.json"):
            try:
                record = json.loads(path.read_text(encoding="utf-8"))
                if abs(psutil.Process(record["pid"]).create_time() - record["created"]) < 0.01:
                    result[engine].append(record)
            except (OSError, ValueError, TypeError, KeyError, psutil.Error):
                continue
    return result


def onnx_providers(use_gpu):
    # Exhaustive cuDNN autotuning can stall the first scan for minutes and
    # repeat for new line batch sizes. Prefer bounded startup for game capture.
    return (
        [("CUDAExecutionProvider", {"cudnn_conv_algo_search": "HEURISTIC"}), "CPUExecutionProvider"]
        if use_gpu
        else ["CPUExecutionProvider"]
    )


def create_onnx_session(path, engine, *, ort_module=None):
    if ort_module is None:
        import onnxruntime as ort_module
    use_gpu = should_use_gpu(engine)
    error = ""
    try:
        session = ort_module.InferenceSession(path, providers=onnx_providers(use_gpu))
        if use_gpu and "CUDAExecutionProvider" not in session.get_providers():
            error = "CUDA initialization failed; ONNX Runtime loaded the model on CPU."
    except Exception as cause:
        if not use_gpu:
            raise
        error = str(cause)
        session = ort_module.InferenceSession(path, providers=["CPUExecutionProvider"])
    record_runtime(engine, "cuda" if "CUDAExecutionProvider" in session.get_providers() else "cpu", error=error)
    return session


def get_settings_status(*, refresh=False):
    diagnostics = get_diagnostics(refresh=refresh)
    return {
        "settings": get_preferences(),
        "diagnostics": diagnostics,
        "runtime": get_runtime_records(),
        "availability": {engine: availability_reason(engine, diagnostics) for engine in ENGINES},
    }


def handle_settings_request(message):
    try:
        payload = message.get("data")
        if not isinstance(payload, dict):
            raise TypeError("Expected GPU settings request")
        if "settings" in payload:
            save_preferences(payload["settings"])
        return get_settings_status(refresh=bool(payload.get("refresh")))
    except (OSError, ValueError, TypeError) as error:
        return {"error": str(error)}
