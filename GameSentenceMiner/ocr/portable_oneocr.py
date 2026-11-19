"""Private local OneOCR worker for macOS and Linux, shared with the Rust overlay."""

import hashlib
import json
import os
import socket
import struct
import subprocess
import sys
import threading
from pathlib import Path

MAX_RESPONSE = 16 * 1024 * 1024


class OneOCRLineCache:
    """Cache the pinned engine's pure line stages. Page voting and geometry still run each time."""

    def __init__(self, engine):
        self.entries = {}
        self.reading = 0
        # Each instance belongs to a single worker and a single loaded model set.
        engine.analyzer.run_aux = self.wrap(engine.analyzer.run_aux)
        engine.analyzer.run_line_layout = self.wrap(engine.analyzer.run_line_layout)
        engine.recognizer.recognize = self.wrap(engine.recognizer.recognize)

    def begin(self):
        self.reading += 1
        self.entries = {key: item for key, item in self.entries.items() if self.reading - item[0] <= 4}

    def wrap(self, stage):
        def cached(image, *args):
            # The recognizer also depends on the script/model and mode chosen by this page's vote.
            pixels = image if image.flags.c_contiguous else image.tobytes()
            key = (stage.__name__, args, image.shape, image.dtype.str, hashlib.sha256(pixels).digest())
            item = self.entries.get(key)
            if item is not None:
                self.entries[key] = (self.reading, item[1])
                return item[1]
            result = stage(image, *args)
            if len(self.entries) < 512:
                # The page analyzer discards the raw network maps after extracting its scores.
                saved = {k: v for k, v in result.items() if k != "raw"} if stage.__name__ == "run_aux" else result
                self.entries[key] = (self.reading, saved)
            return result

        return cached


def worker():
    # Keep stdout exclusively for length-prefixed replies, including startup failures.
    source, sink = sys.stdin.buffer, sys.stdout.buffer
    sys.stdout = sys.stderr
    try:
        import cv2
        import numpy as np
        from oneocr_native.pipeline import OcrEngine

        engine = OcrEngine(providers=["CPUExecutionProvider"])
        cache = OneOCRLineCache(engine)
        sink.write(struct.pack("<I", 2) + b"{}")
        sink.flush()
        while header := source.read(8):
            width, height = struct.unpack("<II", header)
            if not (0 < width <= 10000 and 0 < height <= 10000 and width * height <= 64_000_000):
                raise ValueError("Unsupported OneOCR frame dimensions")
            raw = source.read(width * height * 4)
            rgba = np.frombuffer(raw, dtype=np.uint8).reshape(height, width, 4)
            cache.begin()
            result = engine.recognize_cv2(cv2.cvtColor(rgba, cv2.COLOR_RGBA2BGRA))
            response = json.dumps(result, ensure_ascii=False).encode("utf-8")
            if len(response) > MAX_RESPONSE:
                raise ValueError("OneOCR result exceeds the maximum response size")
            sink.write(struct.pack("<I", len(response)) + response)
            sink.flush()
    except Exception as error:  # noqa: BLE001 - communicate model and protocol failures across the process boundary
        message = json.dumps({"error": str(error)[:2048]}).encode("utf-8")
        sink.write(struct.pack("<I", len(message)) + message)
        sink.flush()


class PortableOneOCR:
    def __init__(self):
        self.path = os.environ.get("GSM_ONEOCR_PYTHON") or Path.home() / ".config/oneocr/venv/bin/python"
        self.lock = threading.RLock()
        self.process = None
        self._start()

    def _start(self):
        self.socket, child = socket.socketpair()
        self.socket.settimeout(60)
        try:
            with child:
                self.process = subprocess.Popen(
                    [str(self.path), "-I", str(Path(__file__).resolve())],
                    stdin=child,
                    stdout=child,
                    env={"ONEOCR_ORT_INTRA_OP_THREADS": "4", **os.environ, "ONEOCR_ORT_ALLOW_INTRA_OP_SPINNING": "0"},
                )
            ready = self._response()
            if "error" in ready:
                raise ValueError(ready["error"])
        except (OSError, ValueError) as error:
            self.close()
            raise RuntimeError(f"Set up portable OneOCR at {self.path}: {error}") from error

    def _read(self, size):
        data = bytearray()
        while len(data) < size:
            part = self.socket.recv(size - len(data))
            if not part:
                raise ConnectionError("Portable OneOCR worker exited")
            data.extend(part)
        return data

    def _response(self):
        (size,) = struct.unpack("<I", self._read(4))
        if not 0 < size <= MAX_RESPONSE:
            raise ValueError("Invalid portable OneOCR response length")
        return json.loads(self._read(size))

    def recognize_pil(self, image):
        with self.lock:
            if self.process is None or self.process.poll() is not None:
                self.close()
                self._start()
            try:
                self.socket.sendall(struct.pack("<II", *image.size))
                self.socket.sendall(image.convert("RGBA").tobytes())
                result = self._response()
                if "error" in result:
                    raise ValueError(result["error"])
                return result
            except (OSError, ValueError) as error:
                self.close()
                raise RuntimeError(f"Portable OneOCR failed: {error}") from error

    def close(self):
        with self.lock:
            self.socket.close()
            if self.process is not None:
                if self.process.poll() is None:
                    self.process.kill()
                self.process.wait()
                self.process = None


if __name__ == "__main__":
    worker()
