import hashlib
import io
import json
import zipfile
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from urllib.parse import urlsplit

import pytest

from GameSentenceMiner.ocr import vita_ocr
from GameSentenceMiner.ocr import vocr_line_finder as finder
from GameSentenceMiner.ocr import vocr_runtime as installer


@pytest.fixture
def downloads(monkeypatch, tmp_path):
    monkeypatch.setattr(installer, "platform_key", lambda: "win32-x64")
    monkeypatch.setattr(vita_ocr, "get_install_directory", lambda: tmp_path)
    models = {size: (f"{size}.vocr", hashlib.sha256(size.encode()).hexdigest()) for size in vita_ocr.MODELS}
    monkeypatch.setattr(vita_ocr, "MODELS", models)
    files = {vita_ocr.library_name(): b"recognizer", finder.spotter_library_name(): b"spotter"}
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as package:
        for name, data in files.items():
            package.writestr(name, data)
        package.writestr("COPYING", "GPL-3.0")
        package.writestr(
            "runtime.json",
            json.dumps(
                {
                    "revision": vita_ocr.UPSTREAM_REVISION,
                    "build": installer.RUNTIME_BUILD,
                    "platform": "win32-x64",
                    "libraries": {name: hashlib.sha256(data).hexdigest() for name, data in files.items()},
                }
            ),
        )
    assets = {
        "vocr-runtime-win32-x64.zip": archive.getvalue(),
        finder.SPOTTER_FILE: b"detector",
        finder.SPOTTER_ATTRIBUTION: b"detector attribution",
        "VOCR6-ATTRIBUTION.md": b"recognizer attribution",
        **{f"{size}.vocr": size.encode() for size in models},
    }
    monkeypatch.setattr(installer, "RUNTIME_ASSETS", {"win32-x64": hashlib.sha256(archive.getvalue()).hexdigest()})
    monkeypatch.setattr(
        installer,
        "SUPPORT_ASSETS",
        {
            name: hashlib.sha256(assets[name]).hexdigest()
            for name in (finder.SPOTTER_FILE, finder.SPOTTER_ATTRIBUTION, "VOCR6-ATTRIBUTION.md")
        },
    )
    monkeypatch.setattr(installer, "validate_installation", lambda *a, **kw: None)
    calls = []

    def download(request, **kwargs):
        name = urlsplit(request.full_url).path.rsplit("/", 1)[-1]
        calls.append(name)
        return io.BytesIO(assets[name])

    monkeypatch.setattr(installer.urllib.request, "urlopen", download)
    return SimpleNamespace(directory=tmp_path, calls=calls, assets=assets)


def test_first_use_installs_prebuilt_runtime_and_model_without_build_tools(downloads, monkeypatch):
    import subprocess

    monkeypatch.setattr(subprocess, "run", lambda *a, **kw: pytest.fail("Installation must never compile"))
    installer.ensure_installation(downloads.directory, model="large")
    assert vita_ocr.read_installation(downloads.directory)["model"] == "large"
    runtime = installer.get_runtime_directory(downloads.directory)
    assert runtime != downloads.directory
    assert (runtime / vita_ocr.library_name()).read_bytes() == b"recognizer"
    assert (runtime / finder.spotter_library_name()).read_bytes() == b"spotter"
    assert (runtime / "COPYING").is_file()
    assert "large.vocr" in downloads.calls
    assert "normal.vocr" not in downloads.calls
    assert (downloads.directory / finder.SPOTTER_ATTRIBUTION).is_file()
    downloads.calls.clear()
    installer.ensure_installation(downloads.directory)
    assert downloads.calls == []
    assert vita_ocr.read_installation(downloads.directory)["model"] == "large"


def test_detector_only_setup_never_downloads_or_changes_recognizer(downloads):
    vita_ocr.write_installation(downloads.directory, "large")
    before = (downloads.directory / "installation.json").read_bytes()
    installer.ensure_installation(downloads.directory, detector_only=True)
    assert not any(name.endswith(".vocr") for name in downloads.calls)
    assert (downloads.directory / "installation.json").read_bytes() == before
    assert installer.runtime_installed(downloads.directory)


@pytest.mark.parametrize("failure", ["checksum", "network", "native"])
def test_failed_install_preserves_previous_choice_and_can_retry(downloads, monkeypatch, failure):
    vita_ocr.write_installation(downloads.directory, "small")
    before = (downloads.directory / "installation.json").read_bytes()
    validate = installer.validate_installation
    if failure == "checksum":
        valid = downloads.assets["vocr-runtime-win32-x64.zip"]
        downloads.assets["vocr-runtime-win32-x64.zip"] = b"damaged archive"
    elif failure == "network":
        download = installer.urllib.request.urlopen
        monkeypatch.setattr(
            installer.urllib.request, "urlopen", lambda *a, **kw: (_ for _ in ()).throw(OSError("offline"))
        )
    else:
        monkeypatch.setattr(
            installer, "validate_installation", lambda *a, **kw: (_ for _ in ()).throw(OSError("bad DLL"))
        )
    with pytest.raises((OSError, ValueError)):
        installer.ensure_installation(downloads.directory, model="large")
    assert (downloads.directory / "installation.json").read_bytes() == before
    assert not list(downloads.directory.rglob("*.download"))
    if failure == "checksum":
        downloads.assets["vocr-runtime-win32-x64.zip"] = valid
    elif failure == "network":
        monkeypatch.setattr(installer.urllib.request, "urlopen", download)
    monkeypatch.setattr(installer, "validate_installation", validate)
    installer.ensure_installation(downloads.directory, model="large")
    assert vita_ocr.read_installation(downloads.directory)["model"] == "large"


def test_parallel_first_use_downloads_each_asset_once(downloads):
    with ThreadPoolExecutor(max_workers=2) as workers:
        list(workers.map(lambda _: installer.ensure_installation(downloads.directory), range(2)))
    assert len(downloads.calls) == len(set(downloads.calls))
    assert vita_ocr.read_installation(downloads.directory)["model"] == "normal"


def test_verified_archive_cannot_write_outside_runtime_directory(downloads, monkeypatch):
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as package:
        package.writestr("../../escaped.dll", "untrusted")
    data = archive.getvalue()
    downloads.assets["vocr-runtime-win32-x64.zip"] = data
    monkeypatch.setattr(installer, "RUNTIME_ASSETS", {"win32-x64": hashlib.sha256(data).hexdigest()})
    with pytest.raises(ValueError, match="archive"):
        installer.ensure_installation(downloads.directory)
    assert not (downloads.directory / "installation.json").exists()
    assert not list(downloads.directory.parent.glob("escaped.dll"))


def test_unsupported_platform_is_actionable_and_never_downloads(downloads, monkeypatch):
    monkeypatch.setattr(installer, "platform_key", lambda: "unsupported")
    with pytest.raises(RuntimeError, match="not available"):
        installer.ensure_installation(downloads.directory)
    assert downloads.calls == []


def test_status_check_never_starts_a_download(downloads, monkeypatch):
    from GameSentenceMiner.ocr import vita_model_manager as manager

    monkeypatch.setattr(manager, "get_install_directory", lambda: downloads.directory)
    assert manager.get_model_status()["available"] is False
    assert downloads.calls == []
