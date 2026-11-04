"""Native trials must never load unsupported instructions or unverified DLLs."""

import hashlib
import json
import subprocess

import pytest

from GameSentenceMiner.ocr import vita_ocr, vocr_line_finder, vocr_native, vocr_onnx, vocr_runtime


@pytest.fixture
def package(tmp_path, monkeypatch):
    monkeypatch.setattr(vita_ocr, "get_install_directory", lambda: tmp_path)
    monkeypatch.setattr(vocr_native, "cpu_features", lambda: {"AVX2"})
    monkeypatch.delenv("GSM_VOCR_BACKEND", raising=False)
    runtime = tmp_path / "runtime" / "local-trial"
    runtime.mkdir(parents=True)
    libraries = {}
    for name in (vita_ocr.library_name(), vocr_line_finder.spotter_library_name()):
        data = name.encode()
        (runtime / name).write_bytes(data)
        libraries[name] = hashlib.sha256(data).hexdigest()
    metadata = {
        "schema": 1,
        "abi_revision": vita_ocr.UPSTREAM_REVISION,
        "revision": "b02e81205fa4bba87726a34f9c7a8cd1469a06ce",
        "build": "test-avx2",
        "platform": vocr_runtime.platform_key(),
        "required_cpu_features": ["AVX2"],
        "libraries": libraries,
    }
    (runtime / "runtime.json").write_text(json.dumps(metadata), encoding="utf-8")
    return tmp_path, runtime


def test_opt_in_selects_verified_native_and_explicit_onnx_wins(package, monkeypatch):
    directory, runtime = package
    assert vocr_onnx.selected_directory() == vocr_onnx.bundled_directory()
    vocr_native.activate(directory, runtime)
    assert vocr_onnx.selected_directory() is None
    assert vocr_runtime.get_runtime_directory(directory) == runtime
    assert vocr_runtime.runtime_installed(directory)
    monkeypatch.setenv("GSM_VOCR_BACKEND", "onnx")
    assert vocr_onnx.selected_directory() == vocr_onnx.bundled_directory()


def test_no_avx2_refuses_before_loading_library(package, monkeypatch):
    directory, runtime = package
    vocr_native.activate(directory, runtime)
    monkeypatch.setattr(vocr_native, "cpu_features", lambda: set())
    assert vocr_onnx.selected_directory(backend="c", directory=directory) is None
    with pytest.raises(ValueError, match="AVX2"):
        vocr_runtime.get_runtime_directory(directory)


def test_auto_falls_back_to_bundled_onnx_when_native_cpu_features_are_unavailable(package, monkeypatch):
    directory, runtime = package
    vocr_native.activate(directory, runtime)
    vita_ocr.write_installation(directory, "large")
    marker = (directory / "native-runtime.json").read_bytes()
    monkeypatch.setattr(vocr_native, "cpu_features", lambda: set())
    monkeypatch.setattr(vita_ocr, "VitaOCRRuntime", lambda *a, **k: pytest.fail("Loaded unsupported native code"))
    monkeypatch.setattr(
        vocr_line_finder, "VOCRLineFinder", lambda *a, **k: pytest.fail("Loaded unsupported native code")
    )
    monkeypatch.setattr(vocr_runtime, "_install_runtime", lambda *a, **k: pytest.fail("Downloaded native code"))
    assert vocr_onnx.selected_directory(directory=directory) == vocr_onnx.bundled_directory()
    recognizer = vita_ocr.create_runtime(directory)
    assert isinstance(recognizer, vocr_onnx.ONNXRuntime)
    assert recognizer.model == "large"
    assert isinstance(vocr_line_finder.create_line_finder(directory), vocr_onnx.ONNXLineFinder)
    vocr_runtime.ensure_installation(directory)
    assert vita_ocr.read_model_selection(directory) == "large"
    assert (directory / "native-runtime.json").read_bytes() == marker


def test_auto_does_not_hide_a_corrupt_native_package(package):
    directory, runtime = package
    vocr_native.activate(directory, runtime)
    (runtime / vita_ocr.library_name()).write_bytes(b"corrupt")
    with pytest.raises(ValueError, match="checksum"):
        vocr_onnx.selected_directory(directory=directory)


@pytest.mark.parametrize("damage", ["library", "metadata", "missing", "abi", "platform"])
def test_invalid_package_cannot_replace_working_selection(package, damage):
    directory, runtime = package
    vocr_native.activate(directory, runtime)
    previous = (directory / "native-runtime.json").read_bytes()
    if damage == "library":
        (runtime / vita_ocr.library_name()).write_bytes(b"corrupt")
    elif damage == "missing":
        (runtime / vocr_line_finder.spotter_library_name()).unlink()
    else:
        metadata = json.loads((runtime / "runtime.json").read_text(encoding="utf-8"))
        metadata[{"metadata": "schema", "abi": "abi_revision", "platform": "platform"}[damage]] = "invalid"
        (runtime / "runtime.json").write_text(json.dumps(metadata), encoding="utf-8")
    with pytest.raises(ValueError):
        vocr_native.activate(directory, runtime)
    assert (directory / "native-runtime.json").read_bytes() == previous
    with pytest.raises(ValueError):
        vocr_native.local_runtime_directory(directory)


def test_model_switch_preserves_native_trial_and_deactivation_preserves_model(package):
    directory, runtime = package
    vocr_native.activate(directory, runtime)
    vita_ocr.write_installation(directory, "large")
    assert vocr_native.local_runtime_directory(directory) == runtime
    vocr_native.deactivate(directory)
    assert vita_ocr.read_model_selection(directory) == "large"
    assert vocr_onnx.selected_directory() == vocr_onnx.bundled_directory()
    assert runtime.is_dir()


def test_marker_cannot_escape_runtime_directory(package):
    directory, _ = package
    (directory / "native-runtime.json").write_text(
        json.dumps({"directory": "../outside", "metadata_sha256": "0" * 64}), encoding="utf-8"
    )
    with pytest.raises(ValueError, match="directory"):
        vocr_native.local_runtime_directory(directory)


def test_explicit_directory_does_not_pick_up_another_installations_trial(package, tmp_path):
    directory, runtime = package
    vocr_native.activate(directory, runtime)
    other = tmp_path / "other"
    other.mkdir()
    assert vocr_onnx.selected_directory(directory=other) == vocr_onnx.bundled_directory()


def test_portable_build_needs_no_avx2(package, monkeypatch):
    directory, runtime = package
    metadata = json.loads((runtime / "runtime.json").read_text(encoding="utf-8"))
    metadata["required_cpu_features"] = []
    (runtime / "runtime.json").write_text(json.dumps(metadata), encoding="utf-8")
    monkeypatch.setattr(vocr_native, "cpu_features", lambda: set())
    vocr_native.activate(directory, runtime)
    assert vocr_native.local_runtime_directory(directory) == runtime


def test_failed_load_check_keeps_previous_backend_and_size(package, monkeypatch):
    from scripts import build_vocr_runtime

    directory, runtime = package
    vocr_native.activate(directory, runtime)
    vita_ocr.write_installation(directory, "small")
    previous = {name: (directory / name).read_bytes() for name in ("native-runtime.json", "installation.json")}
    monkeypatch.setattr(vocr_runtime, "download_verified", lambda *args: None)

    def fail(*args, **kwargs):
        raise subprocess.CalledProcessError(1, args[0])

    monkeypatch.setattr(build_vocr_runtime.subprocess, "run", fail)
    with pytest.raises(subprocess.CalledProcessError):
        build_vocr_runtime.install_local(runtime, directory)
    assert {name: (directory / name).read_bytes() for name in previous} == previous


def test_build_pin_is_separate_from_model_and_onnx_pin():
    from scripts.build_vocr_runtime import ROOT

    lock = json.loads((ROOT / "native/vita-ocr/desktop-source-lock.json").read_text(encoding="utf-8"))
    assert lock["abi_revision"] == vita_ocr.UPSTREAM_REVISION
    assert lock["revision"] != vita_ocr.UPSTREAM_REVISION
    assert vocr_onnx.read_manifest(vocr_onnx.bundled_directory())["revision"] == vita_ocr.UPSTREAM_REVISION
