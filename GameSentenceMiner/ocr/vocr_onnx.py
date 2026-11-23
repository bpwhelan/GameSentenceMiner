"""Portable VOCR 6.2 recognition and textspot8 detection using ONNX Runtime.

The exported assets are verified before loading. There is no build-time ONNX or
upstream Python dependency here, and no native VOCR library is loaded.
"""

import copy
import hashlib
import json
import threading
from pathlib import Path
from types import SimpleNamespace

import cv2
import numpy as np
from PIL import Image

from GameSentenceMiner.native.downloads import asset_path, cached_asset_path
from GameSentenceMiner.ocr.vocr_onnx_charbox import INK, PITCH, ink_profile, positions, resized_width
from GameSentenceMiner.ocr.vocr_onnx_decode import _find_grad, grey_of, halve, spot_maps

BUNDLE_HELP = "Update GSM to restore its VOCR model manifest."


def bundled_directory():
    # The package keeps the manifest and may contain graphs from an older install.
    return Path(__file__).resolve().parents[1] / "assets" / "vocr"


def selected_directory(*, backend=None, directory=None):
    # The desktop always uses the pinned ONNX graphs. Only the standalone
    # C benchmark and its installer request the original ABI explicitly.
    if backend == "c":
        return None
    if backend not in (None, "auto", "onnx"):
        raise ValueError("Unknown VOCR backend")
    assets = bundled_directory()
    if not (assets / "manifest.json").is_file():
        raise FileNotFoundError(f"VOCR bundled models are missing. {BUNDLE_HELP}")
    return assets


def read_manifest(directory):
    from GameSentenceMiner.ocr.vita_ocr import UPSTREAM_REVISION

    manifest = json.loads((Path(directory) / "manifest.json").read_text(encoding="utf-8"))
    if (
        not isinstance(manifest, dict)
        or manifest.get("revision") != UPSTREAM_REVISION
        or manifest.get("export_version") != 1
        or not isinstance(manifest.get("files"), dict)
    ):
        raise ValueError(f"VOCR ONNX assets are incompatible. {BUNDLE_HELP}")
    return manifest


def installed_models(directory):
    from GameSentenceMiner.ocr.vita_ocr import MODELS

    directory = Path(directory)
    manifest = read_manifest(directory)

    def installed(name):
        bundled = directory / name
        file = bundled if bundled.is_file() else cached_asset_path(f"vocr/{name}")
        if file is None:
            return False
        if hashlib.sha256(file.read_bytes()).hexdigest() != manifest["files"].get(name):
            raise ValueError(f"VOCR ONNX model checksum failed: {name}. {BUNDLE_HELP}")
        return True

    if not installed("textspot8-faithful.onnx"):
        return []
    return [tier for tier in MODELS if installed(f"{tier}-faithful.onnx")]


def check_dimensions(width, height):
    if not (0 < width <= 16384 and 0 < height <= 16384 and width * height <= 64_000_000):
        raise ValueError("VOCR capture dimensions are unsupported")


def prepare_line(image, *, height=32, stride=8, max_width=1024, dark=False):
    if isinstance(image, Image.Image) and image.mode not in ("L", "RGB", "RGBA"):
        image = image.convert("RGBA")
    grey = grey_of(image)
    h, w = grey.shape
    check_dimensions(w, h)
    width = resized_width(w, h, height=height, max_width=max_width)
    if dark:
        grey = 255 - grey
    resized = cv2.resize(grey, (width, height), interpolation=cv2.INTER_LINEAR)
    padded = (width + stride - 1) // stride * stride
    resized = np.pad(resized, ((0, 0), (0, padded - width)), mode="edge")
    return (resized.astype(np.float32) / np.float32(127.5) - np.float32(1))[None, None], width


def decode_line(best, vocab, grey, width, *, stride):
    h, w = grey.shape
    boxes = positions(best, w, h, width, flags=PITCH | INK, profile=ink_profile(grey), stride=stride)
    chars = [{"text": vocab[b["cls"]], "box": (b["x0"] / 16, 0, (b["x1"] - b["x0"]) / 16, h)} for b in boxes]
    return "".join(c["text"] for c in chars), chars


def load_session(directory, filename, kind, *, threads=1):
    import onnxruntime as ort

    from GameSentenceMiner.ocr.vita_ocr import UPSTREAM_REVISION

    if threads < 1:
        raise ValueError("VOCR ONNX threads must be positive")
    directory = Path(directory)
    manifest = read_manifest(directory)
    try:
        bundled = directory / filename
        path = bundled if bundled.is_file() else asset_path(f"vocr/{filename}", bundled)
        data = path.read_bytes()
    except FileNotFoundError as error:
        raise FileNotFoundError(f"VOCR ONNX model is missing: {filename}. {BUNDLE_HELP}") from error
    if hashlib.sha256(data).hexdigest() != manifest.get("files", {}).get(filename):
        raise ValueError(f"VOCR ONNX checksum failed: {filename}. {BUNDLE_HELP}")
    options = ort.SessionOptions()
    options.intra_op_num_threads = threads
    options.inter_op_num_threads = 1
    # Busy-waiting worker pools interfere with capture and other OCR engines.
    options.add_session_config_entry("session.intra_op.allow_spinning", "0")
    try:
        session = ort.InferenceSession(data, sess_options=options, providers=["CPUExecutionProvider"])
    except Exception as error:
        raise RuntimeError(f"VOCR ONNX model could not load: {filename}: {error}") from error
    metadata = json.loads(session.get_modelmeta().custom_metadata_map["gsm_vocr"])
    if metadata.get("kind") != kind or metadata.get("revision") != UPSTREAM_REVISION:
        raise ValueError("VOCR ONNX model metadata is incompatible")
    return session, metadata


def head_to_maps(head, height, width, tags):
    head = np.asarray(head)[0].astype(np.int64)
    _, h, w = head.shape
    base = head[:16].reshape(2, 2, 4, h, w).transpose(2, 3, 0, 4, 1).reshape(4, h * 2, w * 2)
    tag_maps = head[16:].reshape(2, 2, tags, h, w).transpose(2, 3, 0, 4, 1).reshape(tags, h * 2, w * 2)
    return np.concatenate([base, tag_maps])[:, : (height + 3) // 4, : (width + 3) // 4]


class ONNXLineFinder:
    kind = "spotter"
    fallback_reason = ""

    def __init__(self, directory, *, mode="faithful", threads=1):
        from GameSentenceMiner.ocr.vocr_line_finder import SPOTTER_SHA256

        if mode not in ("fast", "faithful"):
            raise ValueError("Choose a supported VOCR ONNX mode")
        self.directory = Path(directory)
        self.mode = mode
        self.session, self.metadata = load_session(directory, f"textspot8-{mode}.onnx", "detector", threads=threads)
        if self.metadata.get("source_sha256") != SPOTTER_SHA256 or self.metadata.get("mode") != mode:
            raise ValueError("VOCR ONNX detector does not match the pinned model")
        self.decode_model = SimpleNamespace(**self.metadata)

    def detect_maps(self, image):
        """Unscaled grayscale input -> stride-4 maps at the forced half scale."""
        grey = grey_of(image)
        reduced = halve(grey)
        tensor = (reduced.astype(np.float32) - np.float32(128))[None, None]
        head = self.session.run(["head"], {"image": tensor})[0]
        return head_to_maps(head, *reduced.shape, self.metadata["tags"])

    def detect(self, image):
        check_dimensions(*image.size)
        scaled = image.convert("RGBA")
        scaled.thumbnail((960, 544), Image.Resampling.LANCZOS)
        grey = grey_of(scaled)
        maps = self.detect_maps(grey)
        found = spot_maps(self.decode_model, maps, 2, grey)
        kind, reason = "spotter", ""
        boxes = found.boxes
        if found.truncated:
            grad, dark, truncated = _find_grad(grey)
            if truncated:
                raise RuntimeError("VOCR GRAD line finder exceeded its 16-line limit")
            kind, reason = "grad", "Spotter refused capture (0, truncated=1)"
            boxes = [
                SimpleNamespace(x=x, y=y, w=w, h=h, dark=d, vertical=False, conf=127, tag=0)
                for (x, y, w, h), d in zip(grad, dark)
            ]
        sx, sy = image.width / scaled.width, image.height / scaled.height
        metadata = {
            "finder": kind,
            "file": self.metadata["file"] if kind == "spotter" else "",
            "revision": self.metadata["revision"],
            "fallback_reason": reason,
            "backend": "onnx",
            "mode": self.mode,
        }
        return [
            {
                "box": (
                    int(b.x * sx),
                    int(b.y * sy),
                    min(image.width, int((b.x + b.w) * sx + 0.999)),
                    min(image.height, int((b.y + b.h) * sy + 0.999)),
                ),
                "dark": bool(b.dark),
                "vertical": bool(b.vertical),
                "score": b.conf / 127,
                "tag": b.tag,
                "finder": kind,
                "fallback_reason": reason,
            }
            for b in boxes
        ], metadata


class ONNXRuntime:
    def __init__(
        self,
        directory,
        *,
        model="normal",
        mode="faithful",
        detector_mode="faithful",
        threads=1,
        installation_directory=None,
        finder=None,
    ):
        from GameSentenceMiner.ocr.vita_ocr import MODELS

        if model not in MODELS or mode not in ("fast", "faithful"):
            raise ValueError("Choose a supported VOCR model and ONNX mode")
        self.assets_directory = Path(directory)
        self.directory = Path(installation_directory) if installation_directory is not None else Path(directory).parent
        self.model = model
        self.mode = mode
        self.session, self._model_metadata = load_session(
            directory, f"{model}-{mode}.onnx", "recognizer", threads=threads
        )
        if (
            self._model_metadata.get("source_sha256") != MODELS[model][1]
            or self._model_metadata.get("tier") != model
            or self._model_metadata.get("mode") != mode
        ):
            raise ValueError("VOCR ONNX recognizer does not match the selected pinned model")
        self.metadata = {
            "size": model,
            "file": f"{model}-{mode}.onnx",
            "revision": self._model_metadata["revision"],
            "release": self._model_metadata["release"],
            "backend": "onnx",
            "mode": mode,
        }
        self.finder = finder if finder is not None else ONNXLineFinder(directory, mode=detector_mode, threads=threads)
        self._lock = threading.Lock()
        self._reading = 0
        self._line_cache = {}

    def recognize_line(self, image, *, dark=False):
        if image.mode not in ("L", "RGB", "RGBA"):
            image = image.convert("RGBA")
        data = self._model_metadata
        tensor, width = prepare_line(
            image, height=data["height"], stride=data["stride"], max_width=data["max_width"], dark=dark
        )
        best = self.session.run(["best"], {"image": tensor})[0]
        text, characters = decode_line(best, data["vocab"], grey_of(image), width, stride=data["stride"])
        return {"text": text, "box": (0, 0, image.width, image.height), "characters": characters}, best

    def recognize(self, image):
        from GameSentenceMiner.ocr.vita_ocr import VOCRLines

        check_dimensions(*image.size)
        with self._lock:
            boxes, metadata = self.finder.detect(image)
            self._reading += 1
            self._line_cache = {k: v for k, v in self._line_cache.items() if self._reading - v[0] <= 4}
            lines = []
            for box in boxes:
                if box["vertical"]:
                    continue
                x1, y1, x2, y2 = box["box"]
                crop = image.crop((x1, y1, x2, y2))
                if crop.mode not in ("L", "RGB", "RGBA"):
                    crop = crop.convert("RGBA")
                key = (x1, y1, x2, y2, crop.mode, box["dark"], hashlib.sha256(crop.tobytes()).digest())
                cached = self._line_cache.get(key)
                if cached is not None:
                    self._line_cache[key] = self._reading, cached[1]
                    lines.append(copy.deepcopy(cached[1]))
                    continue
                line, _ = self.recognize_line(crop, dark=box["dark"])
                line["box"] = (x1, y1, x2 - x1, y2 - y1)
                for character in line["characters"]:
                    x, y, w, h = character["box"]
                    character["box"] = (x + x1, y + y1, w, h)
                if len(self._line_cache) < 512:
                    self._line_cache[key] = self._reading, copy.deepcopy(line)
                lines.append(line)
            return VOCRLines(lines, metadata)
