"""
Two-pass OCR controller.

Encapsulates the entire two-pass OCR pipeline in a single, testable class.
All side-effects (sending text, saving images, queueing/running the second OCR engine)
are performed through injectable callbacks so the controller can be exercised
in isolation by unit tests.

Modes:
    1. Disabled     - text is sent directly after dedup.
    2. Two-pass     - OCR1 detects line changes, OCR2 refines final text.
    3. Meiki first  - OCR1 is Meiki text detection; uses box stability checks.

Second-pass trigger conditions:
    * Text disappears (text="" after having pending text)
    * Text completely changes (< 20% similarity and different start/end chars)
    * Force-stable mode enabled
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime
from time import perf_counter
from typing import Any, Callable, Protocol, runtime_checkable

from GameSentenceMiner.ocr.compare import compare_ocr_results, normalize_for_comparison
from GameSentenceMiner.util.logging_config import logger


# ---------------------------------------------------------------------------
# Protocols / callbacks the controller depends on
# ---------------------------------------------------------------------------

@runtime_checkable
class TextFilteringCallable(Protocol):
    """Signature of ``TextFiltering.__call__``."""

    def __call__(
        self,
        text: str,
        last_result: list | None,
        *,
        engine: str | None = None,
        is_second_ocr: bool = False,
    ) -> tuple[str, list]: ...


@dataclass
class TwoPassConfig:
    """Snapshot of config values the controller needs.

    Callers build this from ``get_ocr_*`` helpers so that the controller
    itself never reaches into global config state.
    """

    two_pass_enabled: bool = True
    ocr1_engine: str = ""
    ocr2_engine: str = ""
    ocr1_engine_readable: str = ""
    ocr2_engine_readable: str = ""
    optimize_second_scan: bool = True
    keep_newline: bool = False
    language: str = "ja"

    @property
    def same_engine(self) -> bool:
        """True when both engines are configured identically."""
        e1 = self.ocr1_engine.strip().lower()
        e2 = self.ocr2_engine.strip().lower()
        return bool(e1 and e1 == e2)

    @property
    def is_meiki_first(self) -> bool:
        return "meiki" in self.ocr1_engine.strip().lower()


@dataclass
class SecondPassResult:
    """Value returned by the ``run_second_ocr`` callback."""

    text: str = ""
    orig_text: list = field(default_factory=list)
    response_dict: dict | None = None


@dataclass
class _PendingTextState:
    """Internal bookkeeping for text awaiting the second OCR pass."""

    text: str
    raw_text: str
    orig_text: str
    orig_text_list: list
    start_time: datetime
    img: Any  # PIL.Image or bytes
    crop_coords: Any
    response_dict: dict | None = None


@dataclass
class _MeikiTracker:
    """Internal bookkeeping for Meiki bounding-box stability."""

    last_crop_coords: tuple | None = None
    last_crop_time: datetime | None = None
    last_success_coords: tuple | None = None
    previous_img: Any = None


# ---------------------------------------------------------------------------
# Controller
# ---------------------------------------------------------------------------


class TwoPassOCRController:
    """Manages the full lifecycle of the two-pass OCR pipeline.

    Parameters
    ----------
    config:
        Snapshot of two-pass config values.
    filtering:
        ``TextFiltering`` instance (or any callable with same signature).
    send_result:
        Callback invoked when final text should be dispatched.
        Signature: ``(text, time, response_dict=None, source=None) -> None``
    run_second_ocr:
        Callback that actually executes the second OCR engine.
        Signature: ``(img, last_result, filtering, engine,
        furigana_filter_sensitivity, image_metadata) -> SecondPassResult``
        Can be ``None`` for tests that only exercise queueing behavior.
    save_image:
        Callback to persist debug images.  ``(img, pre_crop_image=None) -> None``
    get_ocr2_image:
        Callable that crops the image for the second pass.
        ``(crop_coords, og_image) -> Image``
    """

    # Duplicate-detection threshold used everywhere.
    DEDUP_THRESHOLD: int = 80
    # Similarity below which text is considered "completely different".
    CHANGE_THRESHOLD: int = 20
    # Meiki bounding-box tolerance in pixels.
    MEIKI_TOL: int = 5

    def __init__(
        self,
        config: TwoPassConfig,
        filtering: TextFilteringCallable | None = None,
        send_result: Callable[..., Any] | None = None,
        run_second_ocr: Callable[..., SecondPassResult] | None = None,
        queue_second_pass: Callable[..., Any] | None = None,
        save_image: Callable[..., Any] | None = None,
        get_ocr2_image: Callable[..., Any] | None = None,
    ):
        self.config = config
        self.filtering = filtering
        self._send_result = send_result or (lambda *a, **kw: None)
        self._run_second_ocr = run_second_ocr
        self._queue_second_pass = queue_second_pass
        self._save_image = save_image or (lambda *a, **kw: None)
        self._get_ocr2_image = get_ocr2_image or (lambda coords, img: img)

        # --- public state (read freely, mutate via methods only) -----------
        self.last_sent_result: str = ""
        self.last_ocr2_result: list = []
        self.force_stable: bool = False

        # --- internal state ------------------------------------------------
        self._pending: _PendingTextState | None = None
        self._meiki = _MeikiTracker()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def reset(self) -> None:
        """Reset all state to initial values."""
        self.last_sent_result = ""
        self.last_ocr2_result = []
        self.force_stable = False
        self._pending = None
        self._meiki = _MeikiTracker()

    def set_force_stable(self, value: bool) -> None:
        self.force_stable = value

    def toggle_force_stable(self) -> bool:
        self.force_stable = not self.force_stable
        return self.force_stable

    # ------------------------------------------------------------------
    # Main entry point – replaces ``ocr_result_callback``
    # ------------------------------------------------------------------

    def handle_ocr_result(
        self,
        text: str,
        orig_text: list,
        time: datetime | None = None,
        img: Any = None,
        *,
        came_from_ss: bool = False,
        crop_coords: Any = None,
        meiki_boxes: list | None = None,
        response_dict: dict | None = None,
        source: str = "ocr",
        manual: bool = False,
        raw_text: str | None = None,
    ) -> None:
        """Process a single OCR result through the two-pass pipeline.

        This is the *only* method tests need to call to simulate OCR frames.
        """
        orig_text_string = "".join(
            item for item in orig_text if item is not None
        ) if orig_text else ""
        orig_text_list = [item for item in (orig_text or []) if item is not None]
        raw_text_string = str(raw_text if raw_text is not None else (text or ""))
        current_time = time or datetime.now()

        # --- Screenshot mode: immediate send ---
        if came_from_ss:
            self._save_image(img)
            self._send_result(text, current_time,
                              response_dict=response_dict, source=source)
            self._clear_pending()
            return

        # --- Meiki bounding-box stability ---
        if meiki_boxes:
            if self._handle_meiki(text, crop_coords, current_time, img,
                                  response_dict, source):
                return

        # --- Disabled / manual: direct send with dedup ---
        if manual or not self.config.two_pass_enabled:
            self._send_direct(text, current_time, img,
                              response_dict=response_dict, source=source)
            return

        # --- Two-pass logic ---
        should_process = self._should_trigger(
            text, orig_text_string,
        )

        # Also trigger if empty text + pending state
        if not should_process and not text and self._pending:
            should_process = True

        if should_process:
            self._process_trigger(
                text, orig_text_string, current_time, img,
                response_dict, source,
            )

        # Track incoming text
        if text:
            self._update_pending(
                text, orig_text_string, orig_text_list, current_time, img,
                crop_coords, response_dict, raw_text_string,
            )

    # ------------------------------------------------------------------
    # Decision helpers
    # ------------------------------------------------------------------

    def _should_trigger(
        self, text: str, orig_text_string: str,
    ) -> bool:
        """Decide whether to trigger the second OCR pass."""
        if not self._pending:
            return False

        p_orig_text = self._pending.orig_text

        # Case 1: text disappeared
        if not text:
            return True

        # Case 2: force-stable
        if self.force_stable:
            return True

        # Case 3: text changed significantly.
        is_low_similarity = not compare_ocr_results(
            p_orig_text, orig_text_string, self.CHANGE_THRESHOLD
        )
        if is_low_similarity and p_orig_text and orig_text_string:
            starts_diff = p_orig_text[0] != orig_text_string[0]
            ends_diff = p_orig_text[-1] != orig_text_string[-1]
            if starts_diff and ends_diff:
                return True

        return False

    def _is_text_evolving(
        self, orig_text_string: str,
    ) -> bool:
        """True when incoming text is an evolution of the pending text."""
        if not self._pending:
            return False
        return compare_ocr_results(
            self._pending.orig_text, orig_text_string, self.CHANGE_THRESHOLD
        )

    # ------------------------------------------------------------------
    # State mutation
    # ------------------------------------------------------------------

    def _update_pending(
        self,
        text: str,
        orig_text_string: str,
        orig_text_list: list,
        current_time: datetime,
        img: Any,
        crop_coords: Any,
        response_dict: dict | None,
        raw_text: str,
    ) -> None:
        if self._is_text_evolving(orig_text_string):
            assert self._pending is not None
            self._pending.text = text
            self._pending.raw_text = raw_text
            self._pending.orig_text = orig_text_string
            self._pending.orig_text_list = orig_text_list
            self._pending.img = _copy_img(img)
            self._pending.crop_coords = crop_coords
            self._pending.response_dict = response_dict
        else:
            self._pending = _PendingTextState(
                text=text,
                raw_text=raw_text,
                orig_text=orig_text_string,
                orig_text_list=orig_text_list,
                start_time=current_time,
                img=_copy_img(img),
                crop_coords=crop_coords,
                response_dict=response_dict,
            )

    def _send_same_engine_filtered(
        self,
        orig_text_list: list,
        time: datetime,
        img: Any,
        *,
        raw_text: str = "",
        response_dict=None,
        source: str = "ocr",
    ) -> None:
        start = perf_counter()
        joined = "".join(str(x) for x in (orig_text_list or []) if x is not None)
        if not joined:
            return
        if self.filtering is None:
            filtered_text, orig_text = joined, [joined]
        else:
            filtered_text, orig_text = self.filtering(joined, self.last_ocr2_result, engine=self.config.ocr2_engine + ".2", is_second_ocr=True)
        self.last_ocr2_result = orig_text
        keep_newline = self.config.keep_newline
        try:
            from GameSentenceMiner.owocr.owocr.ocr import post_process
            from GameSentenceMiner.util.config.electron_config import get_ocr_keep_newline, get_ocr_language
            keep_newline = get_ocr_keep_newline()
            if get_ocr_language() in ("ja", "zh"):
                filtered_text = post_process(filtered_text, keep_blank_lines=keep_newline)
        except Exception:
            pass
        last_sent = self.last_sent_result
        if (
            last_sent
            and filtered_text
            and len(filtered_text) > len(last_sent)
        ):
            if filtered_text.startswith(last_sent):
                filtered_text = filtered_text[len(last_sent):].strip()
            elif filtered_text.endswith(last_sent):
                filtered_text = filtered_text[:-len(last_sent)].strip()
        # raw_candidate = str(raw_text or joined)
        # text = _select_bypass_output_text(raw_candidate, filtered_text, keep_newline=keep_newline)
        # if not str(text or "").strip() and str(raw_candidate or "").strip():
        #     text = _normalize_bypass_text(raw_candidate, keep_newline=keep_newline)
        #     if text and not orig_text:
        #         orig_text = [text]
        # logger.debug("OCR Run 2 (bypassed) debug: raw='{}' filtered='{}' final='{}'", raw_candidate, filtered_text, text)
        if filtered_text:
            elapsed = perf_counter() - start
            engine_name = self.config.ocr1_engine_readable or self.config.ocr1_engine or self.config.ocr2_engine or "OCR1"
            logger.info(
                f"OCR Run 2 (bypassed): Text recognized in {elapsed:0.03f}s using {engine_name} (filtered from OCR1 orig_text): {filtered_text}"
            )
        self._dispatch_second_pass_result(filtered_text, orig_text, time, img, response_dict=response_dict, source=source)

    def _clear_pending(self) -> None:
        self._pending = None
        if self.force_stable:
            self.force_stable = False

    # ------------------------------------------------------------------
    # Sending
    # ------------------------------------------------------------------

    def _send_direct(
        self,
        text: str,
        time: datetime,
        img: Any,
        *,
        response_dict: dict | None = None,
        source: str = "ocr",
    ) -> None:
        """Send text directly (no second pass), with dedup."""
        if not text:
            return
        if compare_ocr_results(self.last_sent_result, text,
                               self.DEDUP_THRESHOLD):
            return
        self._save_image(img)
        self._send_result(text, time, response_dict=response_dict,
                          source=source)
        self.last_sent_result = text
        self._clear_pending()

    def _dispatch_second_pass_result(
        self,
        text: str,
        orig_text: list,
        time: datetime,
        img: Any,
        *,
        response_dict: dict | None = None,
        source: str = "ocr",
    ) -> bool:
        """Finalize a second-pass result."""
        if not text:
            return False
        last_sent = self.last_sent_result
        if (
            last_sent
            and len(text) > len(last_sent)
        ):
            if text.startswith(last_sent):
                text = text[len(last_sent):].strip()
            elif text.endswith(last_sent):
                text = text[:-len(last_sent)].strip()
            if not text:
                return False
        if compare_ocr_results(self.last_sent_result, text,
                               self.DEDUP_THRESHOLD):
            return False

        self._save_image(img)
        self.last_ocr2_result = orig_text
        self.last_sent_result = text
        self._send_result(text, time, response_dict=response_dict,
                          source=source)
        return True

    def _build_ocr2_image(
        self,
        crop_coords: Any,
        og_image: Any,
        *,
        extra_padding: int = 0,
    ) -> Any:
        try:
            return self._get_ocr2_image(crop_coords, og_image, extra_padding)
        except TypeError:
            return self._get_ocr2_image(crop_coords, og_image)

    def _queue_second_pass_task(
        self,
        ocr1_text: str,
        time: datetime,
        img: Any,
        *,
        pre_crop_image: Any = None,
        ignore_furigana_filter: bool = False,
        ignore_previous_result: bool = False,
        image_metadata: dict | None = None,
        response_dict: dict | None = None,
        source: str = "ocr",
    ) -> bool:
        if self._queue_second_pass is None:
            return False
        result = self._queue_second_pass(
            ocr1_text,
            time,
            img,
            self.filtering,
            pre_crop_image,
            ignore_furigana_filter,
            ignore_previous_result,
            image_metadata,
            response_dict,
            source,
        )
        if result is None:
            return True
        return bool(result)

    def _execute_second_pass(
        self,
        ocr1_text: str,
        time: datetime,
        img: Any,
        *,
        crop_coords: Any = None,
        response_dict: dict | None = None,
        source: str = "ocr",
    ) -> None:
        """Run OCR2 immediately and dispatch the result."""
        if self._run_second_ocr is None:
            return

        ocr2_img = self._build_ocr2_image(crop_coords, img)
        result = self._run_second_ocr(
            ocr2_img,
            self.last_ocr2_result,
            self.filtering,
            self.config.ocr2_engine,
        )

        final_payload = response_dict or result.response_dict
        self._dispatch_second_pass_result(
            result.text,
            result.orig_text,
            time,
            ocr2_img,
            response_dict=final_payload,
            source=source,
        )

    # ------------------------------------------------------------------
    # Trigger processing
    # ------------------------------------------------------------------

    def _process_trigger(
        self,
        text: str,
        orig_text_string: str,
        current_time: datetime,
        img: Any,
        response_dict: dict | None,
        source: str,
    ) -> None:
        """Handle a trigger event (text disappeared / changed / force stable)."""
        pending = self._pending
        if not pending:
            return

        # Keep queue semantics aligned with the production helper:
        # dedup against pending OCR1 text before queueing OCR2 work.
        if compare_ocr_results(self.last_sent_result, pending.text, self.DEDUP_THRESHOLD):
            self._clear_pending()
            return

        pending_text = pending.text
        pending_time = pending.start_time
        pending_img = pending.img
        pending_crop = pending.crop_coords
        pending_response = response_dict or pending.response_dict

        if self.config.same_engine:
            self._send_same_engine_filtered(
                pending.orig_text_list, pending_time, pending_img,
                raw_text=pending.raw_text,
                response_dict=pending_response, source=source,
            )
            self._clear_pending()
            return

        ocr2_img = self._build_ocr2_image(pending_crop, pending_img)
        queued = self._queue_second_pass_task(
            pending_text,
            pending_time,
            ocr2_img,
            pre_crop_image=pending_img,
            response_dict=pending_response,
            source=source,
        )
        if not queued:
            self._execute_second_pass(
                pending_text,
                pending_time,
                pending_img,
                crop_coords=pending_crop,
                response_dict=pending_response,
                source=source,
            )

        self._clear_pending()

    # ------------------------------------------------------------------
    # Meiki stability
    # ------------------------------------------------------------------

    def _handle_meiki(
        self,
        text: str,
        crop_coords: Any,
        time: datetime,
        img: Any,
        response_dict: dict | None,
        source: str,
    ) -> bool:
        """Handle Meiki bounding-box stability.  Returns True → caller returns."""
        m = self._meiki

        if m.last_crop_coords is None:
            m.last_crop_coords = crop_coords
            m.last_crop_time = time
            m.previous_img = _copy_img(img)
            return True

        if not crop_coords or not m.last_crop_coords:
            m.last_crop_coords = crop_coords
            m.last_crop_time = time
            return True

        close = _coords_close(crop_coords, m.last_crop_coords, self.MEIKI_TOL)

        if close:
            # Already sent for these coords?
            if m.last_success_coords and _coords_close(
                crop_coords, m.last_success_coords, self.MEIKI_TOL
            ):
                m.last_crop_coords = None
                m.last_crop_time = None
                return True

            stable_time = m.last_crop_time or time
            pre_crop_img = m.previous_img
            ocr2_img = self._build_ocr2_image(
                crop_coords, pre_crop_img, extra_padding=10
            )
            queued = self._queue_second_pass_task(
                text,
                stable_time,
                ocr2_img,
                pre_crop_image=pre_crop_img,
                response_dict=response_dict,
                source=source,
            )
            if not queued:
                self._execute_second_pass(
                    text,
                    stable_time,
                    ocr2_img,
                    crop_coords=None,
                    response_dict=response_dict,
                    source=source,
                )
            m.last_success_coords = crop_coords
            m.last_crop_coords = None
            m.last_crop_time = None
            return True
        else:
            m.last_crop_coords = crop_coords
            m.last_success_coords = None
            m.previous_img = _copy_img(img)
            return True


def _copy_img(img: Any) -> Any:
    """Safely copy an image if it supports ``.copy()``."""
    if img is None:
        return None
    if hasattr(img, "copy"):
        try:
            return img.copy()
        except Exception:
            return img
    return img


def _coords_close(
    a: tuple | list, b: tuple | list, tol: int,
) -> bool:
    """True when all four bounding-box coordinates are within *tol*."""
    try:
        return all(abs(int(a[i]) - int(b[i])) <= tol for i in range(4))
    except Exception:
        return False


def _normalize_bypass_text(text: str, keep_newline: bool) -> str:
    """Legacy helper kept for compatibility with existing imports/tests."""
    normalized = str(text or "").replace("\r\n", "\n").replace("\r", "\n")
    if not keep_newline:
        normalized = re.sub(
            r"(?<=[\.\!\?\u3002\uff01\uff1f])\n+(?=\S)", " ", normalized,
        )
        normalized = normalized.replace("\n", "")
        normalized = re.sub(r"[ \t]{2,}", " ", normalized).strip()
    return normalized


def _select_bypass_output_text(
    ocr1_text: str,
    filtered_text: str,
    *,
    keep_newline: bool,
) -> str:
    """Legacy helper kept for compatibility with existing imports/tests."""
    raw_text = _normalize_bypass_text(ocr1_text, keep_newline)
    filtered_text = _normalize_bypass_text(filtered_text, keep_newline)

    def _is_subsequence(needle: str, haystack: str) -> bool:
        if not needle:
            return True
        idx = 0
        for char in haystack:
            if idx < len(needle) and needle[idx] == char:
                idx += 1
                if idx == len(needle):
                    return True
        return False

    if not filtered_text:
        return filtered_text

    if raw_text and filtered_text != raw_text and _is_subsequence(filtered_text, raw_text):
        return raw_text

    if raw_text and normalize_for_comparison(raw_text) == normalize_for_comparison(filtered_text):
        return raw_text

    return filtered_text
