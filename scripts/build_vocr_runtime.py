"""Maintainer-only build of portable VOCR libraries, including corresponding source."""

import argparse
import ctypes
import hashlib
import json
import platform
import shutil
import subprocess
import sys
import sysconfig
import tempfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNTIME_BUILD = "205f47ec4e56-1"


def platform_key():
    machine = platform.machine().lower()
    if sys.platform == "win32":
        machine = sysconfig.get_platform().removeprefix("win-")
    arch = {"amd64": "x64", "x86_64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(machine)
    if arch is None or ctypes.sizeof(ctypes.c_void_p) != 8:
        raise RuntimeError(f"Unsupported build platform: {sys.platform}/{machine}")
    return f"{sys.platform}-{arch}"


def smoke_check(package):
    suffix = ".dll" if sys.platform == "win32" else ".dylib" if sys.platform == "darwin" else ".so"
    libraries = sorted(package.glob(f"*{suffix}"))
    if len(libraries) != 2:
        raise RuntimeError("The package must contain both native libraries")
    for path in libraries:
        library = ctypes.CDLL(str(path))
        if "spotter" in path.name:
            if library.gsm_vocr_spotter_box_bytes() != 14 or library.gsm_vocr_spotter_model_bytes() <= 0:
                raise RuntimeError("Unexpected spotter ABI")
        else:
            model_size, context_size = ctypes.c_size_t(), ctypes.c_size_t()
            library.vocr_sizes(ctypes.byref(model_size), ctypes.byref(context_size))
            if not model_size.value or not context_size.value:
                raise RuntimeError("Unexpected recognizer ABI")


def build(output):
    lock = json.loads((ROOT / "native/vita-ocr/source-lock.json").read_text(encoding="utf-8"))
    if not lock["revision"].startswith(RUNTIME_BUILD.split("-")[0]):
        raise ValueError("Update the runtime build version with its source pin")
    key = platform_key()
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="gsm-vocr-build-") as temporary:
        work = Path(temporary)
        package = work / "package"
        source = package / "source" / "upstream"
        for name, digest in lock["files"].items():
            request = urllib.request.Request(
                f"https://raw.githubusercontent.com/bee-san/vita-vn-ocr/{lock['revision']}/{name}",
                headers={"User-Agent": "GameSentenceMiner-VocrRuntime-Build"},
            )
            with urllib.request.urlopen(request, timeout=90) as response:
                data = response.read()
            if hashlib.sha256(data).hexdigest() != digest:
                raise ValueError(f"Checksum mismatch: {name}")
            destination = source / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
        for name in ("CMakeLists.txt", "spotter_bridge.c", "source-lock.json"):
            shutil.copy2(ROOT / "native/vita-ocr" / name, package / "source" / name)
        shutil.copy2(source / "LICENSE", package / "COPYING")
        package.joinpath("REBUILD.txt").write_text(
            "VOCR runtime for GameSentenceMiner\n"
            f"Upstream: {lock['repository']} @ {lock['revision']}\n"
            f"GSM runtime build: {RUNTIME_BUILD} ({key})\n"
            "The complete C source used for both libraries is in source/.\n"
            "No model weights are included. The runtime is licensed under GPL-3.0.\n\n"
            "To rebuild with CMake 3.20+ and a C compiler, from this directory:\n"
            'cmake -S source -B build -DVOCR_SOURCE_DIR="$PWD/source/upstream/runtime" -DCMAKE_BUILD_TYPE=Release\n'
            "cmake --build build --config Release\n"
            "cmake --install build --config Release --prefix rebuilt\n"
            "On Windows, use an absolute path instead of $PWD. Windows uses static CRT.\n"
            "macOS releases use -DCMAKE_OSX_DEPLOYMENT_TARGET=11.0.\n",
            encoding="utf-8",
        )
        configure = [
            "cmake",
            "-S",
            str(package / "source"),
            "-B",
            str(work / "build"),
            f"-DVOCR_SOURCE_DIR={source / 'runtime'}",
            "-DCMAKE_BUILD_TYPE=Release",
        ]
        if sys.platform == "win32":
            configure += ["-A", "x64" if key.endswith("x64") else "ARM64"]
        elif sys.platform == "darwin":
            configure += ["-DCMAKE_OSX_DEPLOYMENT_TARGET=11.0"]
        subprocess.run(configure, check=True)
        subprocess.run(["cmake", "--build", str(work / "build"), "--config", "Release", "--parallel", "2"], check=True)
        subprocess.run(
            [
                "cmake",
                "--install",
                str(work / "build"),
                "--config",
                "Release",
                "--prefix",
                str(package),
            ],
            check=True,
        )
        suffix = ".dll" if sys.platform == "win32" else ".dylib" if sys.platform == "darwin" else ".so"
        libraries = sorted(package.glob(f"*{suffix}"))
        if len(libraries) != 2:
            raise RuntimeError("The package must contain both native libraries")
        for path in libraries:
            if sys.platform == "darwin":
                subprocess.run(["codesign", "--force", "--sign", "-", str(path)], check=True)
        # A separate process releases Windows DLL handles before temporary cleanup.
        subprocess.run([sys.executable, str(Path(__file__).resolve()), "--smoke", str(package)], check=True)
        metadata = {
            "revision": lock["revision"],
            "build": RUNTIME_BUILD,
            "platform": key,
            "libraries": {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in libraries},
        }
        (package / "runtime.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
        target = output / f"vocr-runtime-{key}.zip"
        with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for path in sorted(package.rglob("*")):
                if path.is_file():
                    archive.write(path, path.relative_to(package).as_posix())
        result = {**metadata, "asset": target.name, "sha256": hashlib.sha256(target.read_bytes()).hexdigest()}
        (output / f"{key}.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(result, indent=2), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "temp/vocr-runtime-release")
    parser.add_argument("--smoke", type=Path)
    args = parser.parse_args()
    if args.smoke:
        smoke_check(args.smoke.resolve())
    else:
        build(args.output.resolve())
