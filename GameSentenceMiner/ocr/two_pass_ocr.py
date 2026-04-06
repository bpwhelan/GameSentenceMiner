"""Compatibility shim for legacy two_pass_ocr imports.

The two-pass OCR controller now lives in ``GameSentenceMiner.ocr.gsm_ocr``.
"""

from GameSentenceMiner.ocr.gsm_ocr import (
    OCRCompareSettings,
    SecondPassResult,
    TextFilteringCallable,
    TwoPassConfig,
    TwoPassOCRController,
    _coords_close,
    _copy_img,
    _normalize_bypass_text,
    _select_bypass_output_text,
    compare_ocr_results,
)

__all__ = [
    "SecondPassResult",
    "TextFilteringCallable",
    "TwoPassConfig",
    "TwoPassOCRController",
    "OCRCompareSettings",
    "compare_ocr_results",
    "_copy_img",
    "_coords_close",
    "_normalize_bypass_text",
    "_select_bypass_output_text",
]
