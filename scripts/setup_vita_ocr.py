"""Install the optional VOCR desktop trial, with pinned and verified assets."""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from GameSentenceMiner.ocr.vita_ocr import (
    MODELS,
    RELEASE,
    UPSTREAM_REVISION,
    VitaOCRRuntime,
    get_install_directory,
    library_name,
)
from GameSentenceMiner.ocr.vocr_line_finder import (
    SPOTTER_ATTRIBUTION,
    SPOTTER_FILE,
    SPOTTER_SHA256,
    VOCRLineFinder,
)


def download_verified(url, destination, expected_hash):
    if destination.is_file() and hashlib.sha256(destination.read_bytes()).hexdigest() == expected_hash:
        return
    request = urllib.request.Request(url, headers={"User-Agent": "GameSentenceMiner-VitaOCR-Setup"})
    with urllib.request.urlopen(request, timeout=90) as response:
        data = response.read()
    if hashlib.sha256(data).hexdigest() != expected_hash:
        raise ValueError(f"Checksum mismatch for {destination.name}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".download")
    temporary.write_bytes(data)
    os.replace(temporary, destination)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=None, help="Override GSM's OCR asset directory")
    parser.add_argument("--model", choices=MODELS, default="normal")
    parser.add_argument(
        "--spotter-only", action="store_true", help="Add the line finder without replacing the recognizer or selection"
    )
    args = parser.parse_args()
    directory = args.directory.resolve() if args.directory else get_install_directory()
    cmake = shutil.which("cmake")
    if not cmake:
        raise RuntimeError("Install CMake and a C compiler (Visual Studio C++ build tools on Windows) first")
    lock = json.loads((ROOT / "native/vita-ocr/source-lock.json").read_text(encoding="utf-8"))
    if lock["revision"] != UPSTREAM_REVISION:
        raise ValueError("Source lock and Python runtime revisions must match")
    source = directory / "source" / UPSTREAM_REVISION
    print("Preparing pinned VOCR runtime sources...", flush=True)
    for name, digest in lock["files"].items():
        download_verified(
            f"https://raw.githubusercontent.com/bee-san/vita-vn-ocr/{UPSTREAM_REVISION}/{name}", source / name, digest
        )
    if not args.spotter_only:
        filename, digest = MODELS[args.model]
        print(f"Downloading {filename} (non-commercial model; attribution is installed alongside it)...", flush=True)
        download_verified(
            f"https://github.com/bee-san/vita-vn-ocr/releases/download/{RELEASE}/{filename}",
            directory / filename,
            digest,
        )
    for filename, digest in [
        (SPOTTER_FILE, SPOTTER_SHA256),
        (SPOTTER_ATTRIBUTION, "fd44f500114ca2c8373e02bda1134753619e76de869ddf8ec86c14e008be5b84"),
    ]:
        download_verified(
            f"https://github.com/bee-san/vita-vn-ocr/releases/download/{RELEASE}/{filename}",
            directory / filename,
            digest,
        )
    # The model's provenance and licence travel with the local weights.
    attribution = "VOCR6-ATTRIBUTION.md"
    download_verified(
        f"https://github.com/bee-san/vita-vn-ocr/releases/download/{RELEASE}/{attribution}",
        directory / attribution,
        "9a5ff2aee4cb8194f41e54f3a2dac88ce3de6ff4aa7b8ddd123dd5b792c9843b",
    )
    build = directory / "build" / UPSTREAM_REVISION
    subprocess.run(
        [
            cmake,
            "-S",
            str(ROOT / "native/vita-ocr"),
            "-B",
            str(build),
            f"-DVOCR_SOURCE_DIR={source / 'runtime'}",
            "-DCMAKE_BUILD_TYPE=Release",
        ],
        check=True,
    )
    command = [cmake, "--build", str(build), "--config", "Release", "--parallel", "2"]
    if args.spotter_only:
        command += ["--target", "gsm_vocr_spotter"]
    subprocess.run(command, check=True)
    command = [cmake, "--install", str(build), "--config", "Release", "--prefix", str(directory)]
    if args.spotter_only:
        command += ["--component", "spotter"]
    subprocess.run(command, check=True)
    from PIL import Image

    finder = VOCRLineFinder(directory)
    boxes, metadata = finder.detect(Image.new("RGB", (320, 100), "black"))
    if metadata["finder"] != "spotter" or boxes:
        raise RuntimeError(f"VOCR spotter smoke check failed: {metadata}")
    if args.spotter_only:
        print(f"VOCR spotter ready in {directory}. Recognizer model selection preserved.")
        return
    if not (directory / library_name()).is_file():
        raise FileNotFoundError("Build completed without the expected VOCR library")
    # Publish the installation only after all downloads and compilation succeed.
    installation = directory / "installation.json"
    previous = installation.read_bytes() if installation.exists() else None
    temporary = installation.with_suffix(".json.tmp")
    temporary.write_text(
        json.dumps({"revision": UPSTREAM_REVISION, "release": RELEASE, "model": args.model}, indent=2) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, installation)
    try:
        runtime = VitaOCRRuntime(directory)
        if runtime.recognize(Image.new("RGB", (320, 100), "black")):
            raise RuntimeError("VOCR smoke check unexpectedly detected lines in an empty image")
    except Exception:
        if previous is None:
            installation.unlink(missing_ok=True)
        else:
            installation.write_bytes(previous)
        raise
    print(f"VOCR ({args.model}) is ready in {directory}", flush=True)
    print("In GSM: OCR > Advanced > Recognition > Main OCR > VOCR (experimental).")


if __name__ == "__main__":
    main()
