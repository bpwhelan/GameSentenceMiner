"""Export GSM's pinned VOCR S/N/L recognizers and textspot8, without PyTorch.

Requires onnx==1.20.1 and a clean checkout of bee-san/vita-vn-ocr at GSM's pin.
The upstream readers are build-time dependencies only. Inference needs neither
that checkout nor a compiler/native VOCR library. See docs/VOCR_ONNX.md.
"""

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto as T
from onnx import helper as H
from onnx import numpy_helper as N

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from GameSentenceMiner.ocr.vita_ocr import MODELS, RELEASE, UPSTREAM_REVISION
from GameSentenceMiner.ocr.vocr_line_finder import SPOTTER_FILE, SPOTTER_SHA256

EXPORT_VERSION = 1


class Graph:
    def __init__(self):
        self.nodes = []
        self.initializers = []
        self.serial = 0

    def name(self, prefix):
        self.serial += 1
        return f"{prefix}_{self.serial}"

    def const(self, value, dtype=np.float32):
        name = self.name("constant")
        self.initializers.append(N.from_array(np.asarray(value, dtype=dtype), name))
        return name

    def op(self, kind, *inputs, **attrs):
        name = self.name(kind)
        self.nodes.append(H.make_node(kind, list(inputs), [name], name=name, **attrs))
        return name

    def slice(self, x, start, end, axis):
        return self.op(
            "Slice", x, self.const([start], np.int64), self.const([end], np.int64), self.const([axis], np.int64)
        )

    def quant16(self, x):
        maximum = self.op("ReduceMax", self.op("Abs", x), self.const([-1], np.int64), keepdims=1)
        safe = self.op("Where", self.op("Greater", maximum, self.const(0)), maximum, self.const(1))
        scaled = self.op("Mul", x, self.op("Div", self.const(32767), safe))
        q = self.op(
            "Mul", self.op("Sign", scaled), self.op("Floor", self.op("Add", self.op("Abs", scaled), self.const(0.5)))
        )
        q = self.op("Clip", q, self.const(-32767), self.const(32767))
        return q, self.op("Div", maximum, self.const(32767))

    def matrix(self, x, weight, scale, bias, mode):
        """W8F for fast; W8I's int16 activations/exact integer sums for faithful."""
        if mode == "fast":
            y = self.op("MatMul", x, self.const((weight.astype(np.float32) * scale[:, None]).T))
        else:
            q, sx = self.quant16(x)
            # Split q16 into signed base-256 digits. Each <=512-term dot is
            # bounded by 512*255*127 < 2**24, so float32 GEMM is integer-exact.
            # Combining the digits rounds once, exactly like C's int32 -> float.
            high = self.op("Cast", self.op("Cast", self.op("Div", q, self.const(256)), to=T.INT32), to=T.FLOAT)
            low = self.op("Sub", q, self.op("Mul", high, self.const(256)))
            sums = []
            for start in range(0, weight.shape[1], 512):
                end = min(start + 512, weight.shape[1])
                w = self.const(weight[:, start:end].T)
                hi = self.op("MatMul", self.slice(high, start, end, -1), w)
                lo = self.op("MatMul", self.slice(low, start, end, -1), w)
                # Integer casts also prevent ORT's MatMulAddFusion from
                # changing the required rounding by adding lo during GEMM.
                hi = self.op("Cast", hi, to=T.INT32)
                lo = self.op("Cast", lo, to=T.INT32)
                combined = self.op("Add", self.op("Mul", hi, self.const(256, np.int32)), lo)
                sums.append(self.op("Cast", combined, to=T.FLOAT))
            y = sums[0]
            for part in sums[1:]:
                y = self.op("Add", y, part)
            y = self.op("Mul", y, self.op("Mul", sx, self.const(scale)))
        return self.op("Add", y, self.const(bias)) if bias is not None else y

    def score(self, hidden, weight, bias):
        # Preserve the gate/escape's ordered additions; thresholds can be close.
        score = self.const(bias)
        for i, w in enumerate(weight):
            score = self.op("Add", score, self.op("Mul", self.slice(hidden, i, i + 1, -1), self.const(w)))
        return score

    def save(self, destination, inputs, outputs, metadata):
        graph = H.make_graph(self.nodes, destination.stem, inputs, outputs, self.initializers)
        model = H.make_model(
            graph,
            opset_imports=[H.make_opsetid("", 18)],
            producer_name="GameSentenceMiner",
            producer_version=str(EXPORT_VERSION),
        )
        model.ir_version = 10
        H.set_model_props(model, {"gsm_vocr": json.dumps(metadata, ensure_ascii=False)})
        onnx.checker.check_model(model, full_check=True)
        onnx.save_model(model, destination)


def recognizer(blob, two, destination, *, tier, mode, digest):
    g = Graph()
    x = "image"
    residual = None
    for op in blob["ops"]:
        kind = op["type"]
        if kind in (1, 2):
            residual = x
            inputs = [x, g.const(op["w"].reshape(op["cout"], 1, op["kh"], op["kw"]))]
            if op["bias"] is not None:
                inputs.append(g.const(op["bias"]))
            x = g.op(
                "Conv",
                *inputs,
                strides=[op["sh"], op["sw"]],
                pads=[op["ph"], op["pw"]] * 2,
                group=op["cout"] if kind == 2 else 1,
            )
            if op["relu"]:
                x = g.op("Relu", x)
            continue
        if kind not in (3, 4):
            raise ValueError(f"Unsupported VOCR op {kind}; only the pinned S/N/L models are supported")
        if kind == 4:
            features = g.op("Transpose", g.op("Squeeze", x, g.const([0, 2], np.int64)), perm=[1, 0])
            logits = g.matrix(features, op["w"], op["scale"], op["bias"], mode)
            if two:
                if two["rare_k"]:
                    raise ValueError("The pinned models must use the full-width second-level head")
                l1 = two["l1_blocks"] * 8
                nonblank = g.op("ReduceMax", g.slice(logits, 1, l1, -1), g.const([-1], np.int64), keepdims=1)
                blank = g.slice(logits, 0, 1, -1)
                esc = two["esc"]
                hidden = g.matrix(features, esc["q"], esc["scale"], esc["bias"], "faithful")
                hidden = g.op("Add", hidden, g.op("Mul", nonblank, g.const(esc["wl1"])))
                hidden = g.op("Add", hidden, g.op("Mul", blank, g.const(esc["wb0"])))
                fire = g.op("Greater", g.score(g.op("Relu", hidden), esc["w2"], esc["b2"]), g.const(esc["t"]))
                permitted = g.op("Or", fire, g.const(np.arange(op["cout"]) < l1, np.bool_))
                logits = g.op("Where", permitted, logits, g.const(-np.inf))
            best = g.op("ArgMax", logits, axis=1, keepdims=0)
            if blob["gate"] and tier == "normal":
                gate = blob["gate"]
                hidden = g.op("Relu", g.matrix(features, gate["q"], gate["scale"], gate["bias"], "faithful"))
                skip = g.op("Greater", g.score(hidden, gate["w2"], gate["b2"]), g.const(gate["t"]))
                skip = g.op("Squeeze", skip, g.const([1], np.int64))
                best = g.op("Where", skip, g.const(0, np.int64), best)
            break
        if op["collapse"]:
            matrix = g.op("Transpose", x, perm=[0, 3, 2, 1])
            matrix = g.op("Reshape", matrix, g.const([0, 0, op["k"]], np.int64))
            matrix = g.op("Unsqueeze", matrix, g.const([1], np.int64))
        else:
            matrix = g.op("Transpose", x, perm=[0, 2, 3, 1])
        x = g.matrix(matrix, op["w"], op["scale"], op["bias"], mode)
        if op["relu"]:
            x = g.op("Relu", x)
        x = g.op("Transpose", x, perm=[0, 3, 1, 2])
        if op["res"]:
            x = g.op("Add", x, residual)
    else:
        raise ValueError("Missing output head")
    g.nodes.append(H.make_node("Identity", [best], ["best"]))
    metadata = {
        "kind": "recognizer",
        "tier": tier,
        "mode": mode,
        "revision": UPSTREAM_REVISION,
        "source_sha256": digest,
        "release": RELEASE,
        "export_version": EXPORT_VERSION,
        "height": blob["height"],
        "stride": blob["stride"],
        "max_width": blob["max_width"],
        "vocab": blob["vocab"],
        "head_gate": bool(blob["gate"] and tier == "normal"),
        "two_level": bool(two),
    }
    g.save(
        destination,
        [H.make_tensor_value_info("image", T.FLOAT, [1, 1, blob["height"], "width"])],
        [H.make_tensor_value_info("best", T.INT64, ["frames"])],
        metadata,
    )


def detector(model, destination, *, mode):
    if model.version != 4 or model.form != "trunk":
        raise ValueError("Only GSM's pinned textspot8 trunk is supported")
    g = Graph()
    x = "image"
    for layer in model.net.layers:
        # Every sum of integer products must fit exactly in float32, including
        # partial sums in any SIMD reduction order (and fused bias additions).
        bound = np.abs(layer.w).reshape(layer.cout, -1).sum(1) * 128 + np.abs(layer.b)
        if np.any(bound >= 2**24):
            raise ValueError("Detector convolution exceeds the exact float32 integer range")
        if np.any(bound.astype(object) * layer.m.astype(object) + (1 << (layer.sh - 1)).astype(object) >= 2**53):
            raise ValueError("Detector requantization exceeds exact float64 integer range")
        pad = (layer.k // 2) * layer.dil
        shape = (1, -1, 1, 1)
        x = g.op(
            "Conv",
            x,
            g.const(layer.w),
            g.const(layer.b),
            strides=[layer.stride] * 2,
            dilations=[layer.dil] * 2,
            pads=[pad] * 4,
            group=layer.cin if layer.kind == 1 else 1,
        )
        if mode == "faithful":
            # The exported power-of-two fraction and the checked product fit
            # exactly in double. This reproduces the integer half-away shift
            # without the CPU cost of a broadcast int64 divide at every cell.
            x = g.op(
                "Mul", g.op("Cast", x, to=T.DOUBLE), g.const((layer.m / (2.0**layer.sh)).reshape(shape), np.float64)
            )
            rounded = g.op("Floor", g.op("Add", g.op("Abs", x), g.const(0.5, np.float64)))
            x = g.op("Cast", g.op("Mul", g.op("Sign", x), rounded), to=T.FLOAT)
        else:
            x = g.op("Mul", x, g.const((layer.m / (2.0**layer.sh)).reshape(shape)))
            x = g.op("Mul", g.op("Sign", x), g.op("Floor", g.op("Add", g.op("Abs", x), g.const(0.5))))
        x = g.op("Clip", x, g.const(0 if layer.relu else -128), g.const(127))
    g.nodes.append(H.make_node("Identity", [x], ["head"]))
    metadata = {
        "kind": "detector",
        "mode": mode,
        "revision": UPSTREAM_REVISION,
        "source_sha256": SPOTTER_SHA256,
        "export_version": EXPORT_VERSION,
        "stride": model.stride,
        "tags": model.tags,
        "min_cells": model.min_cells,
        "conf_min": model.conf_min,
        "file": SPOTTER_FILE,
    }
    g.save(
        destination,
        [H.make_tensor_value_info("image", T.FLOAT, [1, 1, "height", "width"])],
        [H.make_tensor_value_info("head", T.FLOAT, [1, model.net.outputs, "rows", "cols"])],
        metadata,
    )


def export(source, directory, output, modes):
    revision = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
    if revision != UPSTREAM_REVISION:
        raise ValueError(f"Upstream checkout must be pinned to {UPSTREAM_REVISION}")
    subprocess.run(
        ["git", "-C", str(source), "diff", "--exit-code", "HEAD", "--", "train", "synth", "LICENSE"],
        check=True,
        stdout=subprocess.DEVNULL,
    )
    sys.path[:0] = [str(source / "train"), str(source / "synth")]
    import export as reader
    import head2level
    import textspot6_twin

    output.mkdir(parents=True, exist_ok=True)
    manifest = {"export_version": EXPORT_VERSION, "revision": UPSTREAM_REVISION, "release": RELEASE, "files": {}}
    from GameSentenceMiner.ocr.vocr_runtime import SUPPORT_ASSETS

    for name in ("VOCR6-ATTRIBUTION.md", "SPOTTER-ATTRIBUTION.md"):
        if hashlib.sha256((directory / name).read_bytes()).hexdigest() != SUPPORT_ASSETS[name]:
            raise ValueError(f"Attribution checksum mismatch: {name}")
        shutil.copy2(directory / name, output / name)
    shutil.copy2(source / "LICENSE", output / "COPYING")
    for tier, (filename, digest) in MODELS.items():
        data = (directory / filename).read_bytes()
        if hashlib.sha256(data).hexdigest() != digest:
            raise ValueError(f"Checksum mismatch: {filename}")
        blob, two = reader.read_blob(data), head2level.read_trailer(data)
        for mode in modes:
            target = output / f"{tier}-{mode}.onnx"
            recognizer(blob, two, target, tier=tier, mode=mode, digest=digest)
            manifest["files"][target.name] = hashlib.sha256(target.read_bytes()).hexdigest()
            print(f"Exported {target.name} ({target.stat().st_size:,} bytes)", flush=True)
    data = (directory / SPOTTER_FILE).read_bytes()
    if hashlib.sha256(data).hexdigest() != SPOTTER_SHA256:
        raise ValueError("Spotter checksum mismatch")
    model = textspot6_twin.Model(data)
    for mode in modes:
        target = output / f"textspot8-{mode}.onnx"
        detector(model, target, mode=mode)
        manifest["files"][target.name] = hashlib.sha256(target.read_bytes()).hexdigest()
        print(f"Exported {target.name} ({target.stat().st_size:,} bytes)", flush=True)
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def download_models(directory):
    from GameSentenceMiner.ocr.vocr_runtime import SUPPORT_ASSETS, download_verified

    directory = Path(directory).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    assets = {**{name: digest for name, digest in MODELS.values()}, **SUPPORT_ASSETS}
    for name, digest in assets.items():
        download_verified(
            f"https://github.com/bee-san/vita-vn-ocr/releases/download/{RELEASE}/{name}", directory / name, digest
        )


def install_export(source, directory):
    """Stage legacy benchmark assets in DIR/onnx; GSM uses its package bundle."""
    import tempfile
    import uuid

    from PIL import Image

    from GameSentenceMiner.ocr.vita_ocr import read_installation, write_installation
    from GameSentenceMiner.ocr.vocr_onnx import ONNXRuntime
    from GameSentenceMiner.ocr.vocr_runtime import _process_lock, _replace

    source, directory = Path(source).resolve(), Path(directory).resolve()
    if directory == source or directory.is_relative_to(source):
        raise ValueError("The installation directory must be outside the export directory")
    directory.mkdir(parents=True, exist_ok=True)
    with _process_lock(directory), tempfile.TemporaryDirectory(prefix=".onnx-", dir=directory) as temporary:
        stage = Path(temporary) / "assets"
        shutil.copytree(source, stage)
        for tier in MODELS:
            runtime = ONNXRuntime(stage, model=tier)
            if runtime.recognize(Image.new("RGB", (64, 64), "black")):
                raise ValueError(f"{tier}: the blank-image smoke check failed")
        try:
            selected = read_installation(directory)["model"]
        except FileNotFoundError:
            selected = "normal"
        target = directory / "onnx"
        if not target.resolve().is_relative_to(directory):
            raise ValueError("The ONNX installation must stay inside the requested directory")
        backup = None
        if target.exists():
            backup = directory / f"onnx.previous-{uuid.uuid4().hex}"
            _replace(target, backup)
        try:
            _replace(stage, target)
        except OSError:
            if backup:
                _replace(backup, target)
            raise
        write_installation(directory, selected)
    print(f"Installed ONNX assets in {target}; active model: {selected}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--models", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--modes", nargs="+", choices=["fast", "faithful"], default=["fast", "faithful"])
    parser.add_argument(
        "--download-models", action="store_true", help="Download pinned weights and attribution, without the C runtime"
    )
    parser.add_argument(
        "--install",
        type=Path,
        help="Stage validated models in DIR/onnx for external benchmarks, not GSM's package bundle",
    )
    args = parser.parse_args()
    if args.download_models:
        download_models(args.models.resolve())
    export(args.source.resolve(), args.models.resolve(), args.output.resolve(), args.modes)
    if args.install:
        install_export(args.output.resolve(), args.install.resolve())
