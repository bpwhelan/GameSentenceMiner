"""Install pinned prebuilt VOCR libraries and models on first use. Never compiles."""

import ctypes
import hashlib
import json
import os
import platform
import sys
import sysconfig
import tempfile
import threading
import time
import urllib.request
import uuid
import zipfile
from contextlib import contextmanager
from pathlib import Path, PurePosixPath

from GameSentenceMiner.ocr import vita_ocr
from GameSentenceMiner.ocr.vocr_line_finder import SPOTTER_ATTRIBUTION, SPOTTER_FILE, spotter_library_name

RUNTIME_BUILD = "205f47ec4e56-1"
RUNTIME_URL = f"https://github.com/bpwhelan/GameSentenceMiner/releases/download/vocr-runtime-{RUNTIME_BUILD}"
# Verified artifacts from Build VOCR Runtime run 41151423043. Never resolve 'latest'.
RUNTIME_ASSETS = {
    "win32-x64": "6fdc44e1964dd58a6e2bc36d34e01094a49249808d833b37e40d5a642cc6f26b",
    "darwin-arm64": "129931b15616f5d7b2189b32aa0664f7b1a849e0665aa0e51068f382dbc7e2b2",
    "darwin-x64": "3aef8d486e7386b2ecdb39a96a53d4a5e44f90c827a212e75b3bfb12298cf324",
    "linux-arm64": "8ee8c3aaa376a3f86e3588f0b213a2ad71211cb68be9863566d19e1796360030",
    "linux-x64": "fc616ad845df508f3e4596353cde8c2ad41df54914dd579420dab073a09658e7",
}
SUPPORT_ASSETS = {
    SPOTTER_FILE: "e129d41adfa02c658a7d13d6f98064e6ab6ce9a2bc8c7a56da700a21357b5e1c",
    SPOTTER_ATTRIBUTION: "fd44f500114ca2c8373e02bda1134753619e76de869ddf8ec86c14e008be5b84",
    "VOCR6-ATTRIBUTION.md": "9a5ff2aee4cb8194f41e54f3a2dac88ce3de6ff4aa7b8ddd123dd5b792c9843b",
}
_install_lock = threading.Lock()


def is_installing():
    return _install_lock.locked()


def _replace(source, destination):
    # Windows scanners can briefly hold a newly downloaded DLL open.
    deadline = time.monotonic() + 3
    while True:
        try:
            os.replace(source, destination)
            return
        except PermissionError:
            if os.name != "nt" or time.monotonic() >= deadline:
                raise
            time.sleep(0.1)


def platform_key():
    machine = platform.machine().lower()
    if sys.platform == "win32":
        machine = sysconfig.get_platform().removeprefix("win-")
    arch = {"amd64": "x64", "x86_64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(machine)
    return f"{sys.platform}-{arch}" if arch and ctypes.sizeof(ctypes.c_void_p) == 8 else "unsupported"


def _prebuilt_directory(directory):
    return Path(directory) / "runtime" / RUNTIME_BUILD / platform_key()


def get_runtime_directory(directory):
    candidate = _prebuilt_directory(directory)
    return candidate if (candidate / "runtime.json").is_file() else Path(directory)


def runtime_installed(directory):
    runtime = get_runtime_directory(directory)
    names = (vita_ocr.library_name(), spotter_library_name())
    try:
        if runtime == Path(directory):
            vita_ocr.read_installation(directory)  # Only reuse a source build with the expected ABI pin.
            return all((runtime / name).is_file() for name in names)
        metadata = json.loads((runtime / "runtime.json").read_text(encoding="utf-8"))
        return (metadata["revision"], metadata["build"], metadata["platform"]) == (
            vita_ocr.UPSTREAM_REVISION,
            RUNTIME_BUILD,
            platform_key(),
        ) and all(verified(runtime / name, metadata["libraries"][name]) for name in names)
    except (OSError, ValueError, KeyError, TypeError):
        return False


def verified(path, digest):
    return path.is_file() and hashlib.sha256(path.read_bytes()).hexdigest() == digest


def download_verified(url, destination, digest, *, limit=8_000_000):
    if verified(destination, digest):
        return
    request = urllib.request.Request(url, headers={"User-Agent": "GameSentenceMiner-VOCR"})
    with urllib.request.urlopen(request, timeout=30) as response:
        data = response.read(limit + 1)
    if len(data) > limit or hashlib.sha256(data).hexdigest() != digest:
        raise ValueError(f"VOCR checksum failed for {destination.name}. Try again.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=destination.parent, suffix=".download", delete=False) as file:
            temporary = Path(file.name)
            file.write(data)
        _replace(temporary, destination)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


@contextmanager
def _process_lock(directory):
    # Main OCR and overlay OCR run in separate processes. OS locks also release
    # after a crash, leaving installation retryable without deleting lock files.
    with (directory / ".install.lock").open("a+b") as handle:
        if handle.seek(0, os.SEEK_END) == 0:
            handle.write(b"\0")
            handle.flush()
        deadline = time.monotonic() + 180
        while True:
            handle.seek(0)
            try:
                if os.name == "nt":
                    import msvcrt

                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise RuntimeError("VOCR installation is busy. Try again shortly.") from None
                time.sleep(0.1)
            except OSError as error:
                # Windows reports lock contention as EACCES instead of EAGAIN.
                if os.name != "nt" or error.errno != 13:
                    raise
                if time.monotonic() >= deadline:
                    raise RuntimeError("VOCR installation is busy. Try again shortly.") from error
                time.sleep(0.1)
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == "nt":
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _install_runtime(directory):
    if runtime_installed(directory):
        return
    key = platform_key()
    if key not in RUNTIME_ASSETS:
        raise RuntimeError(f"A prebuilt VOCR runtime is not available for {key}.")
    target = _prebuilt_directory(directory)
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".vocr-", dir=target.parent) as temporary:
        work = Path(temporary)
        archive = work / "runtime.zip"
        download_verified(f"{RUNTIME_URL}/vocr-runtime-{key}.zip?download=1", archive, RUNTIME_ASSETS[key])
        unpacked = work / "unpacked"
        with zipfile.ZipFile(archive) as package:
            entries = package.infolist()
            if sum(entry.file_size for entry in entries) > 32_000_000:
                raise ValueError("Invalid VOCR runtime archive size")
            for entry in entries:
                path = PurePosixPath(entry.filename)
                if path.is_absolute() or ".." in path.parts or "\\" in entry.filename or ":" in entry.filename:
                    raise ValueError("Invalid VOCR runtime archive path")
                if (entry.external_attr >> 16) & 0o170000 == 0o120000:
                    raise ValueError("Invalid VOCR runtime archive link")
            package.extractall(unpacked)
        metadata = json.loads((unpacked / "runtime.json").read_text(encoding="utf-8"))
        if (metadata.get("revision"), metadata.get("build"), metadata.get("platform")) != (
            vita_ocr.UPSTREAM_REVISION,
            RUNTIME_BUILD,
            key,
        ):
            raise ValueError("Incompatible VOCR runtime archive")
        for name in (vita_ocr.library_name(), spotter_library_name()):
            if not verified(unpacked / name, metadata.get("libraries", {}).get(name)):
                raise ValueError(f"VOCR runtime archive checksum failed for {name}")
        if not (unpacked / "COPYING").is_file():
            raise ValueError("VOCR runtime archive is missing its licence")
        backup = None
        if target.exists():
            # Keep the previous directory outside temporary cleanup: a scan
            # may still have its Windows libraries loaded during a repair.
            backup = target.with_name(f"{key}.previous-{uuid.uuid4().hex}")
            _replace(target, backup)
        try:
            _replace(unpacked, target)
        except OSError:
            if backup is not None:
                _replace(backup, target)
            raise


def validate_installation(directory, model, *, detector_only=False):
    if detector_only:
        from GameSentenceMiner.ocr.vocr_line_finder import VOCRLineFinder

        finder = VOCRLineFinder(directory)
        if finder.kind != "spotter":
            raise RuntimeError(f"VOCR detector could not load: {finder.fallback_reason}")
    else:
        runtime = vita_ocr.VitaOCRRuntime(directory, model=model)
        if runtime.finder.kind != "spotter":
            raise RuntimeError(f"VOCR detector could not load: {runtime.finder.fallback_reason}")


def ensure_installation(directory=None, *, model=None, detector_only=False):
    directory = Path(directory) if directory is not None else vita_ocr.get_install_directory()
    if model is not None and (not isinstance(model, str) or model not in vita_ocr.MODELS):
        raise ValueError("Choose a VOCR model: small, normal or large")
    directory.mkdir(parents=True, exist_ok=True)
    with _install_lock, _process_lock(directory):
        try:
            previous = vita_ocr.read_installation(directory)
        except (OSError, ValueError, TypeError):
            previous = None
        selected = model or (previous["model"] if previous else "normal")
        _install_runtime(directory)
        base_url = f"https://github.com/bee-san/vita-vn-ocr/releases/download/{vita_ocr.RELEASE}"
        for name, digest in SUPPORT_ASSETS.items():
            if not detector_only or name != "VOCR6-ATTRIBUTION.md":
                download_verified(f"{base_url}/{name}", directory / name, digest)
        if not detector_only:
            name, digest = vita_ocr.MODELS[selected]
            download_verified(f"{base_url}/{name}", directory / name, digest)
        validate_installation(directory, selected, detector_only=detector_only)
        if not detector_only and (previous is None or previous["model"] != selected):
            vita_ocr.write_installation(directory, selected)
    return directory
