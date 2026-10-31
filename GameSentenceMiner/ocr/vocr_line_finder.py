"""Pinned VOCR textspot8 line detection, with structural GRAD fallback."""

import ctypes as C
import hashlib
import sys
import threading
from pathlib import Path

import numpy as np
from PIL import Image

from GameSentenceMiner.ocr.vita_ocr import (
    UPSTREAM_REVISION,
    _aligned,
    _Image,
    _LineSet,
    library_name,
)

SPOTTER_FILE = "textspot8_t64n8c16_w8.vtsp"
SPOTTER_SHA256 = "e129d41adfa02c658a7d13d6f98064e6ab6ce9a2bc8c7a56da700a21357b5e1c"
SPOTTER_ATTRIBUTION = "SPOTTER-ATTRIBUTION.md"


def spotter_library_name():
    return (
        "gsm_vocr_spotter.dll"
        if sys.platform == "win32"
        else ("libgsm_vocr_spotter.dylib" if sys.platform == "darwin" else "libgsm_vocr_spotter.so")
    )


class _Box(C.Structure):
    _fields_ = [(name, C.c_uint16) for name in ("x", "y", "w", "h")] + [
        (name, C.c_ubyte) for name in ("vertical", "conf", "dark", "block", "tag", "tconf")
    ]


class _Block(C.Structure):
    _fields_ = [(name, C.c_uint16) for name in ("x", "y", "w", "h")] + [
        (name, C.c_ubyte) for name in ("vertical", "first", "count", "tag")
    ]


class _Set(C.Structure):
    _fields_ = [
        ("boxes", _Box * 64),
        ("blocks", _Block * 64),
        ("count", C.c_uint),
        ("block_count", C.c_uint),
        ("pick", C.c_int),
        ("truncated", C.c_uint),
        ("presence", C.c_uint),
    ]


class VOCRLineFinder:
    def __init__(self, directory=None):
        from GameSentenceMiner.ocr.vocr_runtime import ensure_installation, get_runtime_directory

        self.directory = Path(directory) if directory is not None else ensure_installation(detector_only=True)
        runtime_directory = get_runtime_directory(self.directory)
        self._lock = threading.Lock()
        self._arena = np.empty(0, dtype=np.uint8)
        self.fallback_reason = ""
        self.kind = "spotter"
        try:
            data = (self.directory / SPOTTER_FILE).read_bytes()
            if hashlib.sha256(data).hexdigest() != SPOTTER_SHA256:
                raise ValueError("VOCR spotter checksum failed")
            self.lib = C.CDLL(str(runtime_directory / spotter_library_name()))
            for name in ("gsm_vocr_spotter_model_bytes", "gsm_vocr_spotter_box_bytes", "gsm_vocr_spotter_set_bytes"):
                function = getattr(self.lib, name)
                function.argtypes, function.restype = [], C.c_size_t
            if self.lib.gsm_vocr_spotter_box_bytes() != C.sizeof(
                _Box
            ) or self.lib.gsm_vocr_spotter_set_bytes() != C.sizeof(_Set):
                raise ValueError("VOCR spotter ABI mismatch")
            self._blob = _aligned(len(data))
            self._blob[:] = np.frombuffer(data, dtype=np.uint8)
            self._model = _aligned(self.lib.gsm_vocr_spotter_model_bytes())
            self.lib.vocr_textspot6_load.argtypes = [C.c_void_p, C.c_void_p, C.c_size_t]
            self.lib.vocr_textspot6_load.restype = C.c_int
            status = self.lib.vocr_textspot6_load(self._model.ctypes.data, self._blob.ctypes.data, len(data))
            if status:
                raise ValueError(f"VOCR spotter model load failed ({status})")
            self.lib.vocr_textspot6_frame_arena_bytes_flags.argtypes = [C.c_void_p, C.c_uint, C.c_uint, C.c_uint]
            self.lib.vocr_textspot6_frame_arena_bytes_flags.restype = C.c_size_t
            self.lib.vocr_textspot6_find.argtypes = [
                C.c_void_p,
                C.POINTER(_Image),
                C.c_uint,
                C.c_void_p,
                C.c_size_t,
                C.POINTER(_Set),
            ]
            self.lib.vocr_textspot6_find.restype = C.c_int
        except (OSError, ValueError, AttributeError, MemoryError) as error:
            self.kind = "grad"
            self.fallback_reason = str(error)
            fallback = runtime_directory / spotter_library_name()
            self.lib = C.CDLL(str(fallback if fallback.is_file() else runtime_directory / library_name()))
        # The spotter library carries GRAD too, for per-frame structural errors.
        self.lib.vocr_lines_arena_bytes.argtypes = [C.c_uint, C.c_uint]
        self.lib.vocr_lines_arena_bytes.restype = C.c_size_t
        self.lib.vocr_find_lines.argtypes = [C.POINTER(_Image), C.c_int, C.c_void_p, C.c_size_t, C.POINTER(_LineSet)]
        self.lib.vocr_find_lines.restype = C.c_int

    def detect(self, image):
        """Return boxes in original-image pixels. An empty spotter read is final."""
        if not image.width or not image.height or image.width * image.height > 64_000_000:
            raise ValueError("VOCR capture dimensions are unsupported")
        scaled = image.convert("RGBA")
        # Match the console-scale domain while supporting desktop and 4K captures.
        scaled.thumbnail((960, 544), Image.Resampling.LANCZOS)
        pixels = np.ascontiguousarray(scaled, dtype=np.uint8)
        native = _Image(pixels.ctypes.data, scaled.width, scaled.height, pixels.strides[0], 4)
        with self._lock:
            kind, reason = self.kind, self.fallback_reason
            if kind == "spotter":
                # The crop decode uses the half-scale console view, including
                # tight dialogue crops whose own height would not trigger it.
                flags = 4  # VOCR_TEXTSPOT6_SCALE2
                size = self.lib.vocr_textspot6_frame_arena_bytes_flags(
                    self._model.ctypes.data, scaled.width, scaled.height, flags
                )
                if self._arena.size < size:
                    self._arena = np.empty(size, dtype=np.uint8)
                found = _Set()
                status = (
                    self.lib.vocr_textspot6_find(
                        self._model.ctypes.data, C.byref(native), flags, self._arena.ctypes.data, size, C.byref(found)
                    )
                    if size
                    else -1
                )
                if not status and not found.truncated:
                    boxes = [
                        (box.x, box.y, box.w, box.h, box.dark, box.vertical, box.conf / 127, box.tag)
                        for box in found.boxes[: found.count]
                    ]
                else:
                    kind, reason = "grad", f"Spotter refused capture ({status}, truncated={found.truncated})"
            if kind == "grad":
                size = self.lib.vocr_lines_arena_bytes(scaled.width, scaled.height)
                if self._arena.size < size:
                    self._arena = np.empty(size, dtype=np.uint8)
                found = _LineSet()
                status = self.lib.vocr_find_lines(C.byref(native), 0, self._arena.ctypes.data, size, C.byref(found))
                if status or found.truncated:
                    raise RuntimeError(f"VOCR GRAD line finder failed ({status}, truncated={found.truncated})")
                boxes = [(box.x, box.y, box.w, box.h, box.dark, False, 1.0, 0) for box in found.lines[: found.count]]
            sx, sy = image.width / scaled.width, image.height / scaled.height
            return [
                {
                    "box": (
                        int(x * sx),
                        int(y * sy),
                        min(image.width, int((x + w) * sx + 0.999)),
                        min(image.height, int((y + h) * sy + 0.999)),
                    ),
                    "dark": bool(dark),
                    "vertical": bool(vertical),
                    "score": score,
                    "tag": tag,
                    "finder": kind,
                    "fallback_reason": reason,
                }
                for x, y, w, h, dark, vertical, score, tag in boxes
            ], {
                "finder": kind,
                "file": SPOTTER_FILE if kind == "spotter" else "",
                "revision": UPSTREAM_REVISION,
                "fallback_reason": reason,
            }
