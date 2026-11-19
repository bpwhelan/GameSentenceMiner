# SPDX-License-Identifier: GPL-3.0-or-later
"""CPU MIDA line detection for the Python OCR worker, following rtr46/meikipop."""

import hashlib
import os

import cv2
import numpy as np
import onnxruntime as ort

from GameSentenceMiner.native.downloads import huggingface_model
from GameSentenceMiner.ocr.vita_ocr import get_install_directory
from GameSentenceMiner.ocr.vocr_onnx import ONNXRuntime, bundled_directory, check_dimensions
from GameSentenceMiner.ocr.vocr_onnx_decode import line_dark

REVISION = "8503f1ccf4bc214b9c4710b5d19cba5ce422df83"
FILENAME = "mida_l_alpha_v0.0.1.onnx"
DIGEST = "9f72bce58b50b1837bb16e81c5c035d32d9cd45d84dcef56f0b6fb2ef25e8aed"


class MidaFinder:
    kind = "mida"

    def __init__(self, *, classify_polarity=True):
        self.classify_polarity = classify_polarity
        path = huggingface_model(
            "rtr46/mida", FILENAME, get_install_directory().parent / FILENAME, revision=REVISION, sha256=DIGEST
        )
        with path.open("rb") as model:
            if hashlib.file_digest(model, "sha256").hexdigest() != DIGEST:
                raise ValueError("MIDA model checksum failed")
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = min(4, os.cpu_count() or 1)
        opts.inter_op_num_threads = 1
        opts.add_session_config_entry("session.intra_op.allow_spinning", "0")
        opts.add_session_config_entry("session.inter_op.allow_spinning", "0")
        self.session = ort.InferenceSession(str(path), opts, providers=["CPUExecutionProvider"])

    def detect(self, image):
        w, h = image.size
        check_dimensions(w, h)
        height = max(1, round(h * min(960 / w, 544 / h)))
        width = min(1920, max(1, round(w * height / h)))
        rgb = np.asarray(image.convert("RGB"))
        resized = cv2.resize(rgb, (width, height), interpolation=cv2.INTER_LINEAR)
        tensor = np.ascontiguousarray(resized[:, :, ::-1].transpose(2, 0, 1)[None], dtype=np.float32) / 255
        kernel, orientation, above, below = self.session.run(["maps"], {"images": tensor})[0][0]
        count, labels, stats, _ = cv2.connectedComponentsWithStats((kernel > 0).astype(np.uint8), connectivity=4)
        fx, fy = width / w, height / h
        boxes = []
        for index in range(1, count):
            left, top, cols, rows, area = stats[index]
            if area < 2:
                continue
            yy, xx = np.nonzero(labels[top : top + rows, left : left + cols] == index)
            yy, xx = yy + top, xx + left
            if orientation[yy, xx].sum(dtype=np.float64) > 0:
                continue
            centers = 8 * yy + 3.5
            y0 = (centers - 8 * above[yy, xx]).mean() / fy
            y1 = (centers + 8 * below[yy, xx]).mean() / fy
            if y1 - y0 < 1:
                continue
            grow = 0.4 * (y1 - y0) * fy / fx + max(2, round(4 * h / 544))
            x0 = max(0, int(np.floor(8 * left / fx - grow)))
            x1 = min(w, int(np.ceil(8 * (left + cols) / fx + grow)))
            y0, y1 = max(0, int(np.floor(y0))), min(h, int(np.ceil(y1)))
            if x1 > x0 and y1 > y0:
                crop = rgb[y0:y1, x0:x1]
                boxes.append(
                    {
                        "box": (x0, y0, x1, y1),
                        "vertical": False,
                        "dark": self.classify_polarity and bool(line_dark(crop, (0, 0, x1 - x0, y1 - y0))),
                        "score": 1.0,
                    }
                )
        boxes.sort(key=lambda b: (b["box"][1], b["box"][0]))
        return boxes, {"finder": self.kind, "file": FILENAME, "revision": REVISION}


def create_runtime(directory=None):
    directory = directory or get_install_directory()
    return ONNXRuntime(
        bundled_directory(), model="large", mode="fast", installation_directory=directory, finder=MidaFinder()
    )
