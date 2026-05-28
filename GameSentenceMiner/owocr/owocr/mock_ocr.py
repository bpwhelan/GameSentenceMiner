"""
Mock OCR module for CPU benchmarking.

This module re-exports everything from .ocr but replaces the __call__ methods
of all OCR engine classes with synthetic results. The synthetic text changes
every 5 invocations to exercise the deduplication/stability detection logic
in the pipeline without any actual OCR computation.

Toggle via USE_MOCK_OCR at the top of ocr_runtime.py.
"""

import threading
import time
from .ocr import *  # noqa: F403
from .ocr import (
    # Re-import everything explicitly that ocr_runtime.py uses by name
    build_spatial_text,
    line_dict_to_spatial_entry,
    # Dataclasses and helpers
    BoundingBox,
    Symbol,
    Word,
    Line,
    Paragraph,
    ImageProperties,
    EngineCapabilities,
    OcrResult,
    # Functions
    empty_post_process,
    post_process,
    input_to_pil_image,
    pil_image_to_bytes,
    pil_image_to_numpy_array,
    ocr_result_to_oneocr_tuple,
    normalize_japanese_ocr_dashes,
    normalize_japanese_ocr_text_and_segments,
    normalize_japanese_ocr_ellipses,
    get_regex,
    quad_to_bounding_box,
    rectangle_to_bounding_box,
    merge_bounding_boxes,
    limit_image_size,
    # Text detection
    TEXT_DETECTION_RESULT_SCHEMA,
    BaseTextDetector,
    MeikiTextDetector,
    OpenCvEastTextDetector,
    # Engine classes (we'll wrap these)
    MangaOcr,
    MangaOcrSegmented,
    GoogleVision,
    GoogleLens,
    Bing,
    AppleVision,
    AppleLiveText,
    WinRTOCR,
    ScreenAIOCR,
    OneOCR,
    MLKitOCR,
    MeikiOCR,
    AzureImageAnalysis,
    EasyOCR,
    RapidOCR,
    OCRSpace,
    GeminiOCR,
    GroqOCR,
    localLLMOCR,
    draw_detections,
)

# ---------------------------------------------------------------------------
# Synthetic OCR data that cycles every 5 calls
# ---------------------------------------------------------------------------

_SYNTHETIC_SENTENCES = [
    "今日はいい天気ですね。散歩に行きましょう。",
    "彼女は図書館で本を読んでいます。",
    "この料理はとても美味しいです。レシピを教えてください。",
    "電車が遅れているので、タクシーで行きましょう。",
    "明日の会議は午前十時から始まります。",
]

_mock_call_counter = 0
_mock_call_lock = threading.Lock()


def _get_synthetic_index() -> int:
    """Return the current synthetic sentence index (changes every 5 calls)."""
    global _mock_call_counter
    with _mock_call_lock:
        idx = _mock_call_counter // 5
        _mock_call_counter += 1
    return idx % len(_SYNTHETIC_SENTENCES)


def _build_synthetic_result(img=None):
    """
    Build a synthetic OCR result tuple matching the engine return format:
    (success, text, lines, crop_coords_list, crop_coords, response_dict)
    """
    idx = _get_synthetic_index()
    text = _SYNTHETIC_SENTENCES[idx]

    # Build realistic coordinate data as if the text was found in an image
    # Use a fixed 800x600 image assumption for bounding boxes
    img_w = 800
    img_h = 600
    if img is not None:
        try:
            img_w = img.width
            img_h = img.height
        except (AttributeError, TypeError):
            pass

    # Simulate a single line of text in the center of the image
    line_x1 = int(img_w * 0.1)
    line_y1 = int(img_h * 0.4)
    line_x2 = int(img_w * 0.9)
    line_y2 = int(img_h * 0.6)

    bounding_rect = {
        "x1": line_x1,
        "y1": line_y1,
        "x2": line_x2,
        "y2": line_y1,
        "x3": line_x2,
        "y3": line_y2,
        "x4": line_x1,
        "y4": line_y2,
    }

    # Build word-level data (one word per character for CJK)
    words = []
    char_count = len(text)
    char_width = (line_x2 - line_x1) / max(char_count, 1)
    for i, char in enumerate(text):
        cx1 = int(line_x1 + i * char_width)
        cx2 = int(line_x1 + (i + 1) * char_width)
        words.append(
            {
                "text": char,
                "bounding_rect": {
                    "x1": cx1,
                    "y1": line_y1,
                    "x2": cx2,
                    "y2": line_y1,
                    "x3": cx2,
                    "y3": line_y2,
                    "x4": cx1,
                    "y4": line_y2,
                },
            }
        )

    lines = [
        {
            "text": text,
            "bounding_rect": bounding_rect,
            "words": words,
        }
    ]

    crop_coords = (
        line_x1 - 5,
        line_y1 - 5,
        line_x2 + 5,
        line_y2 + 5,
    )

    crop_coords_list = [
        (
            line_x1 - 5,
            line_y1 - 5,
            line_x2 + 5,
            line_y2 + 5,
            text,
        )
    ]

    response_dict = {
        "image_properties": {"width": img_w, "height": img_h},
        "paragraphs": [
            {
                "bounding_box": {
                    "center_x": 0.5,
                    "center_y": 0.5,
                    "width": 0.8,
                    "height": 0.2,
                },
                "lines": [
                    {
                        "text": text,
                        "bounding_box": {
                            "center_x": 0.5,
                            "center_y": 0.5,
                            "width": 0.8,
                            "height": 0.2,
                        },
                        "words": [
                            {
                                "text": char,
                                "bounding_box": {
                                    "center_x": (0.1 + (i + 0.5) * 0.8 / max(char_count, 1)),
                                    "center_y": 0.5,
                                    "width": 0.8 / max(char_count, 1),
                                    "height": 0.2,
                                },
                            }
                            for i, char in enumerate(text)
                        ],
                    }
                ],
            }
        ],
        "engine_capabilities": {
            "words": True,
            "word_bounding_boxes": True,
            "lines": True,
            "line_bounding_boxes": True,
            "paragraphs": True,
            "paragraph_bounding_boxes": True,
        },
    }

    return (True, text, lines, crop_coords_list, crop_coords, response_dict)


def _build_synthetic_detection_result(img=None):
    """Build a synthetic text detection result for detector classes."""
    img_w = 800
    img_h = 600
    if img is not None:
        try:
            img_w = img.width
            img_h = img.height
        except (AttributeError, TypeError):
            pass

    detections = [
        {"box": [img_w * 0.1, img_h * 0.4, img_w * 0.9, img_h * 0.6], "score": 0.95},
    ]

    crop_x1 = int(img_w * 0.1) - 5
    crop_y1 = int(img_h * 0.4) - 5
    crop_x2 = int(img_w * 0.9) + 5
    crop_y2 = int(img_h * 0.6) + 5

    return (
        True,
        {
            "schema": TEXT_DETECTION_RESULT_SCHEMA,
            "detector": "mock_detector",
            "boxes": detections,
            "crop_coords": (crop_x1, crop_y1, crop_x2, crop_y2),
            "crop_coords_list": [(crop_x1, crop_y1, crop_x2, crop_y2)],
        },
    )


# ---------------------------------------------------------------------------
# Wrap all OCR engine classes to return synthetic results
# ---------------------------------------------------------------------------

_OCR_ENGINE_CLASSES = [
    MangaOcr,
    MangaOcrSegmented,
    GoogleVision,
    GoogleLens,
    Bing,
    AppleVision,
    AppleLiveText,
    WinRTOCR,
    ScreenAIOCR,
    OneOCR,
    MLKitOCR,
    MeikiOCR,
    AzureImageAnalysis,
    EasyOCR,
    RapidOCR,
    OCRSpace,
    GeminiOCR,
    GroqOCR,
    localLLMOCR,
]

_TEXT_DETECTOR_CLASSES = [
    MeikiTextDetector,
    OpenCvEastTextDetector,
]


def _make_mock_ocr_call(original_init):
    """Create a mock __init__ that marks the engine as available without loading models."""

    def mock_init(self, *args, **kwargs):
        # Set minimal attributes that the runtime expects
        self.available = True
        # Preserve class-level attributes
        if not hasattr(self, "name"):
            self.name = getattr(self.__class__, "name", "mock")
        if not hasattr(self, "readable_name"):
            self.readable_name = getattr(self.__class__, "readable_name", "Mock OCR")

    return mock_init


def _make_mock_call():
    """Create a mock __call__ that returns synthetic OCR results."""

    def mock_call(self, img=None, *args, **kwargs):
        # Parse the image just enough to get dimensions (simulates input handling overhead)
        pil_img = None
        if img is not None:
            try:
                pil_img, _ = input_to_pil_image(img)
            except Exception:
                pass
        time.sleep(0.2)
        return _build_synthetic_result(pil_img)

    return mock_call


def _make_mock_detector_call():
    """Create a mock __call__ for text detector classes."""

    def mock_detector_call(self, img=None, *args, **kwargs):
        pil_img = None
        if img is not None:
            try:
                pil_img, _ = input_to_pil_image(img)
            except Exception:
                pass
        return _build_synthetic_detection_result(pil_img)

    return mock_detector_call


# Patch all OCR engine classes
for _cls in _OCR_ENGINE_CLASSES:
    _cls.__init__ = _make_mock_ocr_call(_cls.__init__)
    _cls.__call__ = _make_mock_call()

# Patch all text detector classes
for _cls in _TEXT_DETECTOR_CLASSES:
    _cls.__init__ = _make_mock_ocr_call(_cls.__init__)
    _cls.__call__ = _make_mock_detector_call()
