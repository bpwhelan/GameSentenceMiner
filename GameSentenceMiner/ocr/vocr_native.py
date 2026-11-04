"""Explicit, verified local native trials; bundled ONNX remains the portable default.

The marker is separate from model selection, so changing Small/Normal/Large does
not reset the backend. Packages live side by side: never overwrite a loaded DLL.
"""

import hashlib
import json
import os
import tempfile
from pathlib import Path

MARKER = "native-runtime.json"


class UnsupportedCPUError(ValueError):
    """A valid native package requires CPU/OS features that this host lacks."""


def cpu_features():
    # NumPy performs the CPUID *and OS vector-state* checks before setting AVX2.
    # Fail closed if this optional diagnostic API changes in a future NumPy.
    try:
        from numpy._core._multiarray_umath import __cpu_features__

        return {name for name, available in __cpu_features__.items() if available}
    except (ImportError, AttributeError):
        return set()


def validate_package(directory):
    from GameSentenceMiner.ocr.vita_ocr import UPSTREAM_REVISION, library_name
    from GameSentenceMiner.ocr.vocr_line_finder import spotter_library_name
    from GameSentenceMiner.ocr.vocr_runtime import platform_key

    directory = Path(directory)
    try:
        metadata = json.loads((directory / "runtime.json").read_text(encoding="utf-8"))
        if (metadata.get("schema"), metadata.get("abi_revision"), metadata.get("platform")) != (
            1,
            UPSTREAM_REVISION,
            platform_key(),
        ):
            raise ValueError("Incompatible local VOCR native package")
        features = metadata["required_cpu_features"]
        if not isinstance(features, list) or any(not isinstance(feature, str) for feature in features):
            raise ValueError("Invalid native CPU requirements")
        missing = set(features) - cpu_features()
        if missing:
            raise UnsupportedCPUError(
                f"VOCR native runtime requires {', '.join(sorted(missing))}; use the ONNX backend"
            )
        for name in (library_name(), spotter_library_name()):
            if hashlib.sha256((directory / name).read_bytes()).hexdigest() != metadata["libraries"][name]:
                raise ValueError(f"VOCR native library checksum failed: {name}")
        return metadata
    except (OSError, KeyError, TypeError, AttributeError) as error:
        raise ValueError("Invalid or incomplete local VOCR native package") from error


def _inside_runtime(directory, candidate):
    base = (Path(directory).resolve() / "runtime").resolve()
    candidate = Path(candidate).resolve()
    if candidate == base or not candidate.is_relative_to(base):
        raise ValueError("VOCR native directory must be inside this installation's runtime directory")
    return candidate


def local_runtime_directory(directory):
    directory = Path(directory)
    marker = directory / MARKER
    if not marker.is_file():
        return None
    try:
        selection = json.loads(marker.read_text(encoding="utf-8"))
        relative = Path(selection["directory"])
        if relative.is_absolute():
            raise ValueError("VOCR native directory must be relative")
        candidate = _inside_runtime(directory, directory / relative)
        data = (candidate / "runtime.json").read_bytes()
        if hashlib.sha256(data).hexdigest() != selection["metadata_sha256"]:
            raise ValueError("VOCR native package metadata checksum failed")
        validate_package(candidate)
        return candidate
    except (OSError, KeyError, TypeError) as error:
        raise ValueError("Invalid local VOCR native selection; reinstall the trial or use ONNX") from error


def activate(directory, runtime):
    """Publish a previously smoke-tested package atomically, preserving model size."""
    directory = Path(directory).resolve()
    runtime = _inside_runtime(directory, runtime)
    validate_package(runtime)
    selection = {
        "directory": runtime.relative_to(directory).as_posix(),
        "metadata_sha256": hashlib.sha256((runtime / "runtime.json").read_bytes()).hexdigest(),
    }
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=directory, suffix=".tmp", delete=False
        ) as file:
            temporary = Path(file.name)
            json.dump(selection, file, indent=2)
            file.write("\n")
        os.replace(temporary, directory / MARKER)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def deactivate(directory):
    """Return auto mode to bundled ONNX, keeping cached native packages and models."""
    (Path(directory) / MARKER).unlink(missing_ok=True)
