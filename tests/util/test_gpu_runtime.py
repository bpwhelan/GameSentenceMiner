import json
from types import SimpleNamespace

import pytest

from GameSentenceMiner.util import gpu_runtime as gpu


@pytest.fixture
def preferences(monkeypatch, tmp_path):
    monkeypatch.setattr(gpu, "get_gpu_directory", lambda: tmp_path)
    monkeypatch.setattr(gpu, "_legacy_gpu_enabled", lambda: False)
    return tmp_path


def test_preferences_migrate_cpu_choice_and_keep_firered_off(preferences, monkeypatch):
    assert gpu.get_preferences() == {"meiki": False, "firered": False, "whisper": False}
    monkeypatch.setattr(gpu, "_legacy_gpu_enabled", lambda: True)
    assert gpu.get_preferences() == {"meiki": True, "firered": False, "whisper": True}
    gpu.save_preferences({"meiki": False, "firered": True})
    assert gpu.get_preferences() == {"meiki": False, "firered": True, "whisper": True}
    monkeypatch.setattr(gpu, "_legacy_gpu_enabled", lambda: False)
    assert gpu.get_preferences()["whisper"] is True


@pytest.mark.parametrize("settings", [None, [], {"unknown": True}, {"meiki": "false"}, {"firered": 1}])
def test_invalid_settings_do_not_overwrite_preferences(preferences, settings):
    with pytest.raises((TypeError, ValueError)):
        gpu.save_preferences(settings)
    assert not (preferences / "preferences.json").exists()


def test_system_libraries_win_over_python_fallback(monkeypatch, tmp_path):
    system = tmp_path / "system"
    python = tmp_path / "python"
    for directory in (system, python):
        directory.mkdir()
        (directory / "cublas64_12.dll").touch()
    monkeypatch.setattr(gpu, "library_directories", lambda: [(system, "system"), (python, "python")])
    assert gpu.find_library("cublas64_12.dll") == (system / "cublas64_12.dll", "system")


@pytest.mark.parametrize("suffix", ["", "x64"])
def test_installer_locations_include_cudnn_cuda_subdirectory(monkeypatch, tmp_path, suffix):
    cuda = tmp_path / "NVIDIA GPU Computing Toolkit" / "CUDA" / "v12.9" / "bin"
    cudnn = tmp_path / "NVIDIA" / "CUDNN" / "v9.27" / "bin" / "12.9" / suffix
    cuda.mkdir(parents=True)
    cudnn.mkdir(parents=True)
    monkeypatch.setenv("ProgramFiles", str(tmp_path))
    monkeypatch.delenv("CUDA_PATH", raising=False)
    directories = [path for path, source in gpu.library_directories() if source == "system"]
    assert cuda in directories
    assert cudnn in directories


def test_disabled_engine_never_probes_cuda(preferences, monkeypatch):
    monkeypatch.setattr(gpu, "get_diagnostics", lambda **kwargs: pytest.fail("disabled engine probed CUDA"))
    assert gpu.should_use_gpu("firered") is False


@pytest.mark.skipif(gpu.sys.platform != "win32", reason="Windows DLL loader")
def test_bad_system_library_tries_existing_python_fallback(monkeypatch, tmp_path):
    system, python = tmp_path / "system", tmp_path / "python"
    for path in (system, python):
        path.mkdir()
        (path / "cublas64_12.dll").touch()
    monkeypatch.setattr(gpu, "library_directories", lambda: [(system, "system"), (python, "python")])
    monkeypatch.setattr(gpu, "prepare_gpu_paths", lambda: None)
    monkeypatch.setattr(gpu, "_driver_status", lambda: {"available": True, "name": "GPU"})
    monkeypatch.setattr(gpu, "_loaded_libraries", {})
    monkeypatch.setattr(gpu, "_diagnostics", None)

    def load(path):
        if str(system) in path:
            raise OSError("broken system DLL")
        return object()

    monkeypatch.setattr(gpu.ctypes, "WinDLL", load)
    result = gpu.get_diagnostics(refresh=True)["libraries"]["cublas"]
    assert result["available"]
    assert result["source"] == "python"
    assert "broken system DLL" in result["error"]


@pytest.mark.parametrize("actual", [["CUDAExecutionProvider", "CPUExecutionProvider"], ["CPUExecutionProvider"]])
def test_onnx_records_actual_provider_including_silent_cpu_fallback(preferences, monkeypatch, actual):
    gpu.save_preferences({"firered": True})
    monkeypatch.setattr(gpu, "should_use_gpu", lambda engine: True)
    recorded = []
    monkeypatch.setattr(gpu, "record_runtime", lambda *a, **k: recorded.append((a, k)))
    ort = SimpleNamespace(InferenceSession=lambda *a, **k: SimpleNamespace(get_providers=lambda: actual))
    gpu.create_onnx_session("model.onnx", "firered", ort_module=ort)
    assert recorded[-1][0][:2] == ("firered", "cuda" if "CUDAExecutionProvider" in actual else "cpu")
    if "CUDAExecutionProvider" not in actual:
        assert recorded[-1][1]["error"]


def test_onnx_gpu_error_falls_back_to_cpu(preferences, monkeypatch):
    monkeypatch.setattr(gpu, "should_use_gpu", lambda engine: True)
    calls = []

    def create(path, providers):
        calls.append(providers)
        if any(
            (provider[0] if isinstance(provider, tuple) else provider) == "CUDAExecutionProvider"
            for provider in providers
        ):
            raise RuntimeError("bad CUDA library")
        return SimpleNamespace(get_providers=lambda: providers)

    recorded = []
    monkeypatch.setattr(gpu, "record_runtime", lambda *a, **k: recorded.append((a, k)))
    gpu.create_onnx_session("model.onnx", "firered", ort_module=SimpleNamespace(InferenceSession=create))
    assert calls[-1] == ["CPUExecutionProvider"]
    assert recorded[-1][0] == ("firered", "cpu")
    assert "bad CUDA library" in recorded[-1][1]["error"]


def test_cuda_session_avoids_exhaustive_first_scan_search(preferences, monkeypatch):
    monkeypatch.setattr(gpu, "should_use_gpu", lambda engine: True)
    monkeypatch.setattr(gpu, "record_runtime", lambda *a, **k: None)
    calls = []

    def create(path, providers):
        calls.append(providers)
        return SimpleNamespace(get_providers=lambda: ["CUDAExecutionProvider", "CPUExecutionProvider"])

    gpu.create_onnx_session("model.onnx", "firered", ort_module=SimpleNamespace(InferenceSession=create))
    assert calls == [[("CUDAExecutionProvider", {"cudnn_conv_algo_search": "HEURISTIC"}), "CPUExecutionProvider"]]


def test_runtime_records_ignore_dead_processes_and_keep_actual_device(preferences, monkeypatch):
    gpu.record_runtime("meiki", "cpu", error="GPU failed")
    records = gpu.get_runtime_records()
    assert records["meiki"][0]["device"] == "cpu"
    assert records["meiki"][0]["error"] == "GPU failed"
    path = next((preferences / "runtime").glob("*.json"))
    data = json.loads(path.read_text())
    data["created"] -= 100
    path.write_text(json.dumps(data))
    assert gpu.get_runtime_records()["meiki"] == []
