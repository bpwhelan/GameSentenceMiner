"""Maintainer-only build of portable VOCR libraries, including corresponding source."""

import argparse
import ctypes
import hashlib
import json
import os
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
sys.path.insert(0, str(ROOT))


def platform_key():
    machine = platform.machine().lower()
    if sys.platform == "win32":
        machine = sysconfig.get_platform().removeprefix("win-")
    arch = {"amd64": "x64", "x86_64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(machine)
    if arch is None or ctypes.sizeof(ctypes.c_void_p) != 8:
        raise RuntimeError(f"Unsupported build platform: {sys.platform}/{machine}")
    return f"{sys.platform}-{arch}"


def smoke_check(package):
    metadata_file = package / "runtime.json"
    metadata = json.loads(metadata_file.read_text(encoding="utf-8")) if metadata_file.is_file() else None
    if metadata and metadata.get("required_cpu_features"):
        from GameSentenceMiner.ocr.vocr_native import cpu_features

        if set(metadata["required_cpu_features"]) - cpu_features():
            raise RuntimeError("This host cannot safely load the built native CPU variant")
    suffix = ".dll" if sys.platform == "win32" else ".dylib" if sys.platform == "darwin" else ".so"
    libraries = sorted(package.glob(f"*{suffix}"))
    if len(libraries) != 2:
        raise RuntimeError("The package must contain both native libraries")
    for path in libraries:
        library = ctypes.CDLL(str(path))
        if metadata and bool(library.gsm_vocr_avx2_enabled()) != ("AVX2" in metadata["required_cpu_features"]):
            raise RuntimeError("Native CPU feature metadata does not match the compiled kernels")
        if "spotter" in path.name:
            if library.gsm_vocr_spotter_box_bytes() != 14 or library.gsm_vocr_spotter_model_bytes() <= 0:
                raise RuntimeError("Unexpected spotter ABI")
        else:
            model_size, context_size = ctypes.c_size_t(), ctypes.c_size_t()
            library.vocr_sizes(ctypes.byref(model_size), ctypes.byref(context_size))
            if not model_size.value or not context_size.value:
                raise RuntimeError("Unexpected recognizer ABI")


def install_local(package, directory):
    from GameSentenceMiner.ocr.vita_ocr import MODELS, RELEASE, read_model_selection, write_installation
    from GameSentenceMiner.ocr.vocr_native import activate, validate_package
    from GameSentenceMiner.ocr.vocr_runtime import SUPPORT_ASSETS, _install_lock, _process_lock, download_verified

    metadata = validate_package(package)
    directory.mkdir(parents=True, exist_ok=True)
    with _install_lock, _process_lock(directory):
        selected = read_model_selection(directory)
        base = f"https://github.com/bee-san/vita-vn-ocr/releases/download/{RELEASE}"
        for name, checksum in {**SUPPORT_ASSETS, **{name: checksum for name, checksum in MODELS.values()}}.items():
            download_verified(f"{base}/{name}", directory / name, checksum)
        # The subprocess owns the DLL handles; its exit releases them before any
        # cleanup or activation. Failed smoke tests leave the old marker untouched.
        with tempfile.TemporaryDirectory(prefix="gsm-vocr-modelcheck-") as temporary:
            trial = Path(temporary)
            for path in package.iterdir():
                if path.is_file():
                    shutil.copy2(path, trial / path.name)
            for path in directory.iterdir():
                if path.suffix in (".vocr", ".vtsp"):
                    shutil.copy2(path, trial / path.name)
            subprocess.run([sys.executable, str(Path(__file__).resolve()), "--smoke-models", str(trial)], check=True)
        identity = hashlib.sha256((package / "runtime.json").read_bytes()).hexdigest()[:12]
        target = directory / "runtime" / f"local-{metadata['build']}" / f"{metadata['platform']}-{identity}"
        if not target.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(prefix=".vocr-stage-", dir=target.parent) as temporary:
                staging = Path(temporary) / "package"
                shutil.copytree(package, staging)
                os.replace(staging, target)
        validate_package(target)
        write_installation(directory, selected)
        activate(directory, target)
        print(f"Local VOCR native runtime activated: {target}; model size preserved: {selected}", flush=True)


def build(output, *, avx2=False, source_directory=None, install_directory=None):
    lock = json.loads((ROOT / "native/vita-ocr/desktop-source-lock.json").read_text(encoding="utf-8"))
    runtime_build = lock["build"] + ("-avx2" if avx2 else "-portable")
    if not lock["revision"].startswith(runtime_build.split("-")[0]):
        raise ValueError("Update the runtime build version with its source pin")
    key = platform_key()
    if avx2 and not key.endswith("-x64"):
        raise ValueError("AVX2 packages are only available for x64")
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="gsm-vocr-build-") as temporary:
        work = Path(temporary)
        package = work / "package"
        source = package / "source" / "upstream"
        for name, digest in lock["files"].items():
            if source_directory is not None:
                data = (source_directory / name).read_bytes()
            else:
                repository = lock["repository"].removeprefix("https://github.com/")
                request = urllib.request.Request(
                    f"https://raw.githubusercontent.com/{repository}/{lock['revision']}/{name}",
                    headers={"User-Agent": "GameSentenceMiner-VocrRuntime-Build"},
                )
                with urllib.request.urlopen(request, timeout=90) as response:
                    data = response.read()
            if hashlib.sha256(data).hexdigest() != digest:
                raise ValueError(f"Checksum mismatch: {name}")
            destination = source / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
        for name in ("CMakeLists.txt", "spotter_bridge.c", "features.c"):
            shutil.copy2(ROOT / "native/vita-ocr" / name, package / "source" / name)
        (package / "source/source-lock.json").write_text(json.dumps(lock, indent=2) + "\n", encoding="utf-8")
        shutil.copy2(source / "LICENSE", package / "COPYING")
        package.joinpath("REBUILD.txt").write_text(
            "VOCR runtime for GameSentenceMiner\n"
            f"Upstream: {lock['repository']} @ {lock['revision']}\n"
            f"GSM runtime build: {runtime_build} ({key})\n"
            "The complete C source used for both libraries is in source/.\n"
            "No model weights are included. The runtime is licensed under GPL-3.0.\n\n"
            "To rebuild with CMake 3.20+ and a C compiler, from this directory:\n"
            'cmake -S source -B build -DVOCR_SOURCE_DIR="$PWD/source/upstream/runtime" -DCMAKE_BUILD_TYPE=Release '
            f"-DVOCR_AVX2={'ON' if avx2 else 'OFF'}\n"
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
            f"-DVOCR_SOURCE_DIR={(source / 'runtime').as_posix()}",
            "-DCMAKE_BUILD_TYPE=Release",
            f"-DVOCR_AVX2={'ON' if avx2 else 'OFF'}",
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
        metadata = {
            "schema": 1,
            "abi_revision": lock["abi_revision"],
            "repository": lock["repository"],
            "revision": lock["revision"],
            "build": runtime_build,
            "platform": key,
            "required_cpu_features": ["AVX2"] if avx2 else [],
            "threads": 1,
            "floating_point": "strict; no fused multiply-add",
            "libraries": {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in libraries},
        }
        (package / "runtime.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
        # A separate process releases Windows DLL handles before temporary cleanup.
        subprocess.run([sys.executable, str(Path(__file__).resolve()), "--smoke", str(package)], check=True)
        asset_key = key + ("-avx2" if avx2 else "-portable")
        target = output / f"vocr-runtime-{asset_key}.zip"
        with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for path in sorted(package.rglob("*")):
                if path.is_file():
                    archive.write(path, path.relative_to(package).as_posix())
        result = {**metadata, "asset": target.name, "sha256": hashlib.sha256(target.read_bytes()).hexdigest()}
        (output / f"{asset_key}.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(result, indent=2), flush=True)
        if install_directory is not None:
            install_local(package, install_directory)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "temp/vocr-runtime-release")
    parser.add_argument("--smoke", type=Path)
    parser.add_argument("--smoke-models", type=Path)
    parser.add_argument("--avx2", action="store_true")
    parser.add_argument("--source", type=Path, help="Local checkout; every file is still SHA-256 checked")
    parser.add_argument("--install-local", action="store_true", help="Load-check all sizes and activate locally")
    parser.add_argument(
        "--restore-onnx", action="store_true", help="Remove the local native selection without building"
    )
    parser.add_argument("--directory", type=Path, help="Override the local model installation directory")
    args = parser.parse_args()
    if args.smoke:
        smoke_check(args.smoke.resolve())
    elif args.smoke_models:
        from PIL import Image

        from GameSentenceMiner.ocr.vita_ocr import MODELS, VitaOCRRuntime
        from GameSentenceMiner.ocr.vocr_native import validate_package

        validate_package(args.smoke_models)
        smoke_check(args.smoke_models)
        for tier in MODELS:
            runtime = VitaOCRRuntime(args.smoke_models, model=tier)
            if runtime.finder.kind != "spotter" or runtime.recognize(Image.new("RGB", (320, 100), "black")):
                raise RuntimeError(f"Native model smoke check failed: {tier}")
    else:
        directory = args.directory
        if args.install_local or args.restore_onnx:
            from GameSentenceMiner.ocr.vita_ocr import get_install_directory

            directory = directory.resolve() if directory else get_install_directory()
        if args.restore_onnx:
            from GameSentenceMiner.ocr.vocr_native import deactivate

            deactivate(directory)
            print("Local native selection removed; auto mode uses bundled ONNX.")
        else:
            build(
                args.output.resolve(),
                avx2=args.avx2,
                source_directory=args.source,
                install_directory=directory if args.install_local else None,
            )
