"""Meiki v0.1 detector variants with the upstream recognition pipeline."""

import hashlib

import cv2
import meikiocr.ocr as upstream
import numpy as np
import onnxruntime as ort
from huggingface_hub import hf_hub_download
from huggingface_hub.errors import LocalEntryNotFoundError

from GameSentenceMiner.util.gpu_runtime import onnx_providers

DETECTION_REPO = "rtr46/meiki.text.detect.v0"
DETECTION_REVISION = "a9cffa4f60cbf72ddb87edf19c6f98a01cd042e6"
MODELS = {
    "small": (320, 192, "8cdc5daa5c13a5f93adb40ee2e53ad1a3d2f7e372584c5c665b038adeb74ae6d"),
    "large": (960, 544, "40b6a016667745cae7d3055929ae3b8b1e7716aac795f5904cd3c2c7c3b8404b"),
}


def session_options():
    options = ort.SessionOptions()
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    options.add_session_config_entry("session.intra_op.allow_spinning", "0")
    options.add_session_config_entry("session.inter_op.allow_spinning", "0")
    return options


def create_detection_session(model, provider="CPUExecutionProvider"):
    if not isinstance(model, str) or model not in MODELS:
        raise ValueError("Choose a MeikiOCR detector: small or large")
    width, height, digest = MODELS[model]
    filename = f"meiki.text.detect.v0.1.{width}x{height}.onnx"
    download = {"repo_id": DETECTION_REPO, "filename": filename, "revision": DETECTION_REVISION}
    try:
        path = hf_hub_download(**download, local_files_only=True)
    except LocalEntryNotFoundError:
        path = hf_hub_download(**download)
    with open(path, "rb") as file:
        if hashlib.file_digest(file, "sha256").hexdigest() != digest:
            raise ValueError(f"MeikiOCR model checksum failed for {filename}")
    return ort.InferenceSession(
        path, sess_options=session_options(), providers=onnx_providers(provider == "CUDAExecutionProvider")
    )


class MeikiOCRPipeline(upstream.MeikiOCR):
    def __init__(self, *, model_name="large", provider="CPUExecutionProvider", max_batch_size=8):
        ort.set_default_logger_severity(3)
        self.det_width, self.det_height, _ = MODELS[model_name]
        self.model_name = model_name
        self.det_session = create_detection_session(model_name, provider)
        options = session_options()
        self.rec_session = ort.InferenceSession(
            upstream._get_model_path(upstream.REC_MODEL_REPO, upstream.REC_MODEL_NAME),
            sess_options=options,
            providers=onnx_providers(provider == "CUDAExecutionProvider"),
        )
        self.vrec_session = ort.InferenceSession(
            upstream._get_model_path(upstream.REC_MODEL_REPO, upstream.VREC_MODEL_NAME),
            sess_options=options,
            providers=onnx_providers(provider == "CUDAExecutionProvider"),
        )
        self.active_provider = self.det_session.get_providers()[0]
        if provider == "CUDAExecutionProvider" and any(
            "CUDAExecutionProvider" not in session.get_providers()
            for session in (self.det_session, self.rec_session, self.vrec_session)
        ):
            raise RuntimeError("MeikiOCR could not load all models on CUDA; using CPU instead.")
        self.max_batch_size = max_batch_size

    def _preprocess_for_detection(self, image):
        # Match upstream's top-left letterboxing. Keep dimensions on the
        # instance so concurrent small/large scans cannot affect one another.
        height, width = image.shape[:2]
        scale = min(self.det_width / width, self.det_height / height)
        resized = cv2.resize(image, (max(1, int(width * scale)), max(1, int(height * scale))))
        tensor = np.zeros((self.det_height, self.det_width, 3), dtype=np.float32)
        tensor[: resized.shape[0], : resized.shape[1]] = resized.astype(np.float32) / 255.0
        return tensor.transpose(2, 0, 1)[None], scale

    def _run_detection_inference(self, tensor, scale):
        inputs = self.det_session.get_inputs()
        return self.det_session.run(
            None,
            {
                inputs[0].name: tensor,
                inputs[1].name: np.array([[self.det_width / scale, self.det_height / scale]], dtype=np.int64),
            },
        )
