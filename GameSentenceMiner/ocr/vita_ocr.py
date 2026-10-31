"""Desktop binding for bee-san/vita-vn-ocr's pinned C99 runtime.

First use installs prebuilt libraries and models; importing this module never
downloads, compiles, or loads native code. ABI declarations follow
vocr.h, vocr_lines.h and vocr_charbox.h at UPSTREAM_REVISION.
"""

import ctypes as C
import hashlib
import json
import os
import sys
import tempfile
import threading
from pathlib import Path

import numpy as np

from GameSentenceMiner.util.data_directory import get_app_directory

UPSTREAM_REVISION = "205f47ec4e56ca87c00e7dba0a61c9aaec726707"
RELEASE = "v0.5.0"
MODELS = {
    "normal": ("VOCR6.2_N_w8g2.vocr", "107cf084cc0c1a3a61ce4c3f9b9cf6b31d6dff80f0a1bdb94afd3f7ee9ae3bc9"),
    "small": ("VOCR6.2_S_w8.vocr", "864bbd196d5bc5d3a7bd7918cf7274b3503dfe65d440017ef0781ea7e7ba37d2"),
    "large": ("VOCR6.2_L_w8_2l.vocr", "65310013e8f990886e4e8097b2fe55eb98cdf082d7193eea510601fc0ac26c82"),
}
SETUP_HELP = "Select VOCR in GSM to download its runtime and model automatically. Check your connection and retry if setup fails."


def get_install_directory():
    override = os.environ.get("GSM_VITA_OCR_DIR")
    return Path(override).expanduser().resolve() if override else Path(get_app_directory()) / "ocr" / "vita-vn-ocr"


def library_name():
    return (
        "gsm_vita_ocr.dll"
        if sys.platform == "win32"
        else ("libgsm_vita_ocr.dylib" if sys.platform == "darwin" else "libgsm_vita_ocr.so")
    )


def read_installation(directory=None):
    directory = Path(directory) if directory is not None else get_install_directory()
    try:
        installation = json.loads((directory / "installation.json").read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise FileNotFoundError(f"VOCR is not installed. {SETUP_HELP}") from error
    if (
        not isinstance(installation, dict)
        or installation.get("revision") != UPSTREAM_REVISION
        or not isinstance(installation.get("model"), str)
        or installation["model"] not in MODELS
    ):
        raise ValueError(f"VOCR installation is incompatible. {SETUP_HELP}")
    return installation


def write_installation(directory, model):
    if model not in MODELS:
        raise ValueError("Choose a VOCR model: small, normal or large")
    directory = Path(directory)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=directory, suffix=".tmp", delete=False
        ) as file:
            temporary = Path(file.name)
            json.dump({"revision": UPSTREAM_REVISION, "release": RELEASE, "model": model}, file, indent=2)
            file.write("\n")
        os.replace(temporary, directory / "installation.json")
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


class _Image(C.Structure):
    _fields_ = [
        ("pixels", C.c_void_p),
        ("width", C.c_uint),
        ("height", C.c_uint),
        ("stride", C.c_size_t),
        ("format", C.c_uint),
    ]


class _Options(C.Structure):
    _fields_ = [
        ("tile_frames", C.c_uint),
        ("head_frames", C.c_uint),
        ("max_width", C.c_uint),
        ("mode", C.c_int),
        ("head_gate", C.c_uint),
        ("two_level", C.c_uint),
    ]


class _Extra(C.Structure):
    _fields_ = [
        ("logits", C.c_void_p),
        ("best", C.c_void_p),
        ("cap_frames", C.c_uint),
        ("cancel", C.c_void_p),
        ("user", C.c_void_p),
        ("width", C.c_uint),
        ("frames", C.c_uint),
        ("chars", C.c_uint),
        ("topk", C.c_uint),
        ("topk_logit", C.c_void_p),
        ("topk_class", C.c_void_p),
        ("blank_logit", C.c_void_p),
        ("conf_min", C.c_float),
        ("conf_mean", C.c_float),
        ("head_in", C.c_void_p),
        ("gate_score", C.c_void_p),
        ("gated", C.c_uint),
        ("ungated", C.c_uint),
        ("esc_score", C.c_void_p),
        ("escaped", C.c_uint),
    ]


class _Line(C.Structure):
    _fields_ = [(name, C.c_uint) for name in ("x", "y", "w", "h", "dark")]


class _LineSet(C.Structure):
    _fields_ = [("lines", _Line * 16), ("count", C.c_uint), ("truncated", C.c_uint)]


class _CharBox(C.Structure):
    _fields_ = [(name, C.c_uint16) for name in ("cls", "f0", "f1", "group")] + [
        (name, C.c_int32) for name in ("c", "x0", "x1", "i0", "i1")
    ]


def _aligned(size):
    storage = np.empty(size + 16, dtype=np.uint8)
    offset = -storage.ctypes.data % 16
    return storage[offset : offset + size]


class VitaOCRRuntime:
    def __init__(self, directory=None, *, model=None):
        from GameSentenceMiner.ocr.vocr_line_finder import VOCRLineFinder
        from GameSentenceMiner.ocr.vocr_runtime import ensure_installation, get_runtime_directory

        # Explicit directories let the installer validate a candidate before
        # publishing its selection, and keep source-build/native tests offline.
        directory = Path(directory) if directory is not None else ensure_installation()
        tier = read_installation(directory)["model"] if model is None else model
        if tier not in MODELS:
            raise ValueError("Choose a VOCR model: small, normal or large")
        self.directory = directory
        self.model = tier
        filename, expected_hash = MODELS[tier]
        self.metadata = {"size": tier, "file": filename, "revision": UPSTREAM_REVISION, "release": RELEASE}
        data = (directory / filename).read_bytes()
        if hashlib.sha256(data).hexdigest() != expected_hash:
            raise ValueError(f"VOCR model checksum failed. {SETUP_HELP}")
        self.lib = C.CDLL(str(get_runtime_directory(directory) / library_name()))
        self._bind()
        self._lock = threading.Lock()
        self._blob = _aligned(len(data))
        self._blob[:] = np.frombuffer(data, dtype=np.uint8)
        model_size, context_size = C.c_size_t(), C.c_size_t()
        self.lib.vocr_sizes(C.byref(model_size), C.byref(context_size))
        self._model = _aligned(model_size.value)
        self._context = _aligned(context_size.value)
        self._check(self.lib.vocr_check_crc(self._blob.ctypes.data, len(data)))
        self._check(self.lib.vocr_load(self._model.ctypes.data, self._blob.ctypes.data, len(data)))
        options = _Options(0, 0, 0, 3, int(tier == "normal"), int(tier != "small"))
        size = self.lib.vocr_arena_bytes(self._model.ctypes.data, C.byref(options))
        if not size:
            raise ValueError("VOCR model does not support the configured runtime options")
        self._arena = _aligned(size)
        self._check(
            self.lib.vocr_init(
                self._context.ctypes.data, self._model.ctypes.data, C.byref(options), self._arena.ctypes.data, size
            )
        )
        self.finder = VOCRLineFinder(directory)
        self._stride = int.from_bytes(data[20:22], "little")

    def _bind(self):
        pointer, size, uint = C.c_void_p, C.c_size_t, C.c_uint
        signatures = {
            "vocr_sizes": ([C.POINTER(size), C.POINTER(size)], None),
            "vocr_check_crc": ([pointer, size], C.c_int),
            "vocr_load": ([pointer, pointer, size], C.c_int),
            "vocr_arena_bytes": ([pointer, C.POINTER(_Options)], size),
            "vocr_init": ([pointer, pointer, C.POINTER(_Options), pointer, size], C.c_int),
            "vocr_run": ([pointer, C.POINTER(_Image), C.c_char_p, size, C.POINTER(_Extra)], C.c_int),
            "vocr_resized_width": ([pointer, uint, uint], uint),
            "vocr_strerror": ([C.c_int], C.c_char_p),
            "vocr_class_text": ([pointer, uint, C.POINTER(uint)], pointer),
            "vocr_lines_arena_bytes": ([uint, uint], size),
            "vocr_find_lines_fix": ([C.POINTER(_Image), C.c_int, uint, pointer, size, C.POINTER(_LineSet)], C.c_int),
            "vocr_charbox_find": (
                [
                    pointer,
                    C.POINTER(C.c_uint16),
                    uint,
                    uint,
                    uint,
                    uint,
                    uint,
                    pointer,
                    C.POINTER(_Image),
                    pointer,
                    C.POINTER(_CharBox),
                    uint,
                    C.POINTER(uint),
                ],
                C.c_int,
            ),
        }
        for name, (arguments, result) in signatures.items():
            function = getattr(self.lib, name)
            function.argtypes = arguments
            function.restype = result

    def _check(self, status):
        if status:
            raise RuntimeError(f"VOCR: {self.lib.vocr_strerror(status).decode('utf-8')} ({status})")

    def recognize(self, image):
        """Return horizontal lines and CTC character boxes in input-image pixels.

        One context owns mutable scratch buffers. Serialize calls even when GSM
        uses the same instance from its overlay and recognition worker threads.
        """
        width, height = image.size
        if not (0 < width <= 16384 and 0 < height <= 16384 and width * height <= 64_000_000):
            raise ValueError("VOCR capture dimensions are unsupported")
        pixels = np.ascontiguousarray(image.convert("RGBA"), dtype=np.uint8)
        with self._lock:
            boxes, metadata = self.finder.detect(image)
            lines = []
            for box in boxes:
                if box["vertical"]:
                    continue
                x1, y1, x2, y2 = box["box"]
                lines.append(self._recognize_line(pixels, _Line(x1, y1, x2 - x1, y2 - y1, int(box["dark"]))))
            return VOCRLines(lines, metadata)

    def _recognize_line(self, pixels, line):
        crop = _Image(
            pixels.ctypes.data + line.y * pixels.strides[0] + line.x * 4,
            line.w,
            line.h,
            pixels.strides[0],
            4 | (0x100 if line.dark else 0),
        )
        frames = self.lib.vocr_resized_width(self._model.ctypes.data, line.w, line.h) // self._stride + 1
        best = (C.c_uint16 * frames)()
        extra = _Extra(best=C.cast(best, C.c_void_p), cap_frames=frames)
        text = C.create_string_buffer(4096)
        self._check(self.lib.vocr_run(self._context.ctypes.data, C.byref(crop), text, len(text), C.byref(extra)))
        characters = []
        if text.value:
            boxes, count = (_CharBox * 256)(), C.c_uint()
            self._check(
                self.lib.vocr_charbox_find(
                    self._model.ctypes.data,
                    best,
                    1,
                    extra.frames,
                    line.w,
                    line.h,
                    6,
                    None,
                    C.byref(crop),
                    None,
                    boxes,
                    256,
                    C.byref(count),
                )
            )
            for box in boxes[: count.value]:
                length = C.c_uint()
                value = self.lib.vocr_class_text(self._model.ctypes.data, box.cls, C.byref(length))
                characters.append(
                    {
                        "text": C.string_at(value, length.value).decode("utf-8"),
                        "box": (line.x + box.x0 / 16, line.y, (box.x1 - box.x0) / 16, line.h),
                    }
                )
        return {"text": text.value.decode("utf-8"), "box": (line.x, line.y, line.w, line.h), "characters": characters}


class VOCRLines(list):
    def __init__(self, lines, finder_metadata):
        super().__init__(lines)
        self.finder_metadata = finder_metadata
