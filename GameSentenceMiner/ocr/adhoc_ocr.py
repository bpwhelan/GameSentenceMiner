"""Main-process ad-hoc (area-select) OCR.

Runs a one-shot screen-crop OCR without requiring the ``gsm_ocr`` subprocess, so
area-select OCR works whether or not continuous OCR is running.

Engine selection (constraint: never load a second copy of a local model):
  * Default to Google Lens (network, no local model).
  * Reuse the overlay processor's already-loaded engine instance when the
    configured ``ocr2`` engine matches the overlay's effective engine.
  * If the Lens pass can't connect, fall back to the overlay's loaded local
    engine when one exists.
"""

from __future__ import annotations

import threading
from datetime import datetime
from typing import Any, Callable, Optional

from GameSentenceMiner import obs
from GameSentenceMiner.owocr.owocr.ocr import post_process
from GameSentenceMiner.owocr.owocr.ocr_runtime import (
    TextFiltering,
    do_configured_ocr_replacements,
)
from GameSentenceMiner.util.config.configuration import OverlayEngine
from GameSentenceMiner.util.config.electron_config import (
    get_ocr_keep_newline,
    get_ocr_language,
    get_ocr_ocr2,
    get_ocr_send_to_clipboard,
)
from GameSentenceMiner.util.logging_config import logger
from GameSentenceMiner.util.text_log import TextSource

# Map the overlay engine enum value -> the OverlayProcessor attribute that holds
# the (lazily) instantiated engine object.
_OVERLAY_ATTR_BY_ENGINE = {
    OverlayEngine.LENS.value: "lens",
    OverlayEngine.ONEOCR.value: "oneocr",
    OverlayEngine.MEIKIOCR.value: "meikiocr",
    OverlayEngine.SCREENAI.value: "screenai",
}

# Map a configured ocr2 engine name (OCR tab values) -> overlay engine enum value.
_OCR2_TO_OVERLAY = {
    "glens": OverlayEngine.LENS.value,
    "lens": OverlayEngine.LENS.value,
    "oneocr": OverlayEngine.ONEOCR.value,
    "meikiocr": OverlayEngine.MEIKIOCR.value,
    "screenai": OverlayEngine.SCREENAI.value,
}

_lens_lock = threading.Lock()
_lens_engine = None


def _get_default_lens():
    """Lazily create (once) a standalone Google Lens engine for the default path."""
    global _lens_engine
    with _lens_lock:
        if _lens_engine is None:
            from GameSentenceMiner.owocr.owocr.ocr import GoogleLens

            _lens_engine = GoogleLens(lang=get_ocr_language(), get_furigana_sens_from_file=False)
        return _lens_engine


def _get_overlay_processor():
    try:
        from GameSentenceMiner.util.overlay.get_overlay_coords import get_overlay_processor

        return get_overlay_processor()
    except Exception as e:
        logger.debug(f"Ad-hoc OCR: overlay processor unavailable: {e}")
        return None


def _overlay_local_engine(overlay) -> tuple[Any, Optional[str]]:
    """Return the overlay's loaded local engine (oneocr/meiki/screenai), if any."""
    if not overlay:
        return None, None
    for value in (
        OverlayEngine.ONEOCR.value,
        OverlayEngine.MEIKIOCR.value,
        OverlayEngine.SCREENAI.value,
    ):
        inst = getattr(overlay, _OVERLAY_ATTR_BY_ENGINE[value], None)
        if inst is not None:
            return inst, value
    return None, None


def _resolve_engines() -> tuple[tuple[Any, str], tuple[Any, Optional[str]]]:
    """Resolve (primary_engine, primary_name), (fallback_engine, fallback_name).

    Primary defaults to Lens, but reuses the overlay's already-loaded instance
    when the configured ocr2 engine matches the overlay's effective engine.
    Fallback is the overlay's loaded local engine (used if the Lens pass fails).
    """
    overlay = _get_overlay_processor()
    fallback = _overlay_local_engine(overlay)

    ocr2 = (get_ocr_ocr2() or "").strip().lower()
    desired = _OCR2_TO_OVERLAY.get(ocr2)
    overlay_engine_value = None
    if overlay is not None:
        try:
            overlay_engine_value = overlay._get_effective_engine()
        except Exception:
            overlay_engine_value = None

    if overlay is not None and desired is not None and desired == overlay_engine_value:
        attr = _OVERLAY_ATTR_BY_ENGINE.get(desired)
        inst = getattr(overlay, attr, None) if attr else None
        if inst is not None:
            logger.info(f"Ad-hoc OCR: reusing overlay's loaded '{desired}' engine.")
            return (inst, desired), fallback

    return (_get_default_lens(), OverlayEngine.LENS.value), fallback


def _run_ocr_pass(img, engine_obj, engine_name: str) -> tuple[Optional[str], Optional[str]]:
    """Run a single OCR pass. Returns (filtered_text, error_message).

    On engine failure returns (None, <message>); on empty result returns ("", None).
    """
    try:
        result = engine_obj(img, 0)
    except Exception as e:
        return None, f"{engine_name} raised: {e}"

    res, text, *_ = (list(result) + [None] * 6)[:6]
    if not res:
        return None, str(text) if text else f"{engine_name} returned no result"

    if text is None:
        text = ""
    if isinstance(text, list):
        text = [do_configured_ocr_replacements(line) for line in text]
    else:
        text = do_configured_ocr_replacements(text)

    filtering = TextFiltering(lang=get_ocr_language())
    filtered_text, _orig_text = filtering(text, None, engine=engine_name, is_second_ocr=True)
    if get_ocr_language() in ("ja", "zh"):
        filtered_text = post_process(filtered_text, keep_blank_lines=get_ocr_keep_newline(TextSource.SCREEN_CROPPER))
    return filtered_text, None


def run_area_select_ocr(
    submit_coro: Callable[[Any], Any],
    source: str = TextSource.SCREEN_CROPPER,
) -> None:
    """Launch the screen cropper, OCR the selection, and feed it to the text log.

    Blocking (waits for the cropper); call on a worker thread, not the hotkey
    callback thread (which holds a lock) nor the asyncio loop. ``submit_coro``
    schedules the resulting coroutine on the text async loop.
    """
    from GameSentenceMiner.ui.qt_main import launch_screen_cropper

    cropped_img = launch_screen_cropper(transparent_mode=False)
    if cropped_img is None:
        logger.info("Screen cropper cancelled")
        return

    (primary, primary_name), (fallback, fallback_name) = _resolve_engines()

    text, err = _run_ocr_pass(cropped_img, primary, primary_name)
    if text is None and fallback is not None and fallback is not primary:
        logger.info(f"Ad-hoc OCR primary engine failed ({err}); falling back to '{fallback_name}'.")
        text, err = _run_ocr_pass(cropped_img, fallback, fallback_name or "local")

    if not text:
        logger.info(f"Ad-hoc area-select OCR produced no text.{f' ({err})' if err else ''}")
        return

    # If OBS isn't actually capturing a video source, still show the text but
    # don't count it toward the current game's stats / persist it to the DB.
    exclude_from_stats = not obs.is_game_capture_active()

    from GameSentenceMiner.gametext import handle_new_text_event

    coro = handle_new_text_event(
        text,
        datetime.now(),
        source=source,
        source_display_name="GSM OCR",
        copy_to_clipboard=get_ocr_send_to_clipboard(source),
        exclude_from_stats=exclude_from_stats,
    )
    try:
        submit_coro(coro)
    except Exception as e:
        try:
            coro.close()
        except Exception:
            pass
        logger.error(f"Failed to submit ad-hoc OCR result: {e}")
