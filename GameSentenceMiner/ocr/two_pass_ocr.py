"""
Two-pass OCR controller.

Encapsulates the entire two-pass OCR pipeline in a single, testable class.
All side-effects (sending text, saving images, running the second OCR engine)
are performed through injectable callbacks so the controller can be exercised
in isolation by unit tests.

Modes:
    1. Disabled          – text is sent directly after dedup.
    2. Same engine       – OCR1 == OCR2; second pass is bypassed, text is
                           filtered and sent immediately on trigger.
    3. Different engines – full two-pass; OCR1 for initial detection, OCR2
                           for refinement.
    4. Meiki first pass  – OCR1 is Meiki text detection; needs bounding-box
                           stability checking before queueing second pass.

Second-pass trigger conditions:
    * Text disappears      (text="" after having pending text)
    * Text unavailable     (orig_text=[] after having content)
    * Text completely changes (< 20% similarity AND different start/end chars)
    * Force-stable mode enabled
"""

from __future__ import annotations

import re
from copy import copy
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable, Protocol, Sequence, runtime_checkable

from GameSentenceMiner.ocr.compare import compare_ocr_results, is_evolving_text, normalize_for_comparison


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
        May be ``None`` if two-pass is disabled or same-engine mode is in use.
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
    # Broader similarity threshold for endpoint-anchored change detection.
    # At this threshold, same-speaker lines that still differ significantly
    # at an endpoint (e.g. "Speaker: A..." vs "Speaker: B...") will trigger,
    # even if the overall ratio exceeds the tighter CHANGE_THRESHOLD.
    PARTIAL_CHANGE_THRESHOLD: int = 50
    # Meiki bounding-box tolerance in pixels.
    MEIKI_TOL: int = 5

    def __init__(
        self,
        config: TwoPassConfig,
        filtering: TextFilteringCallable | None = None,
        send_result: Callable[..., Any] | None = None,
        run_second_ocr: Callable[..., SecondPassResult] | None = None,
        save_image: Callable[..., Any] | None = None,
        get_ocr2_image: Callable[..., Any] | None = None,
    ):
        self.config = config
        self.filtering = filtering
        self._send_result = send_result or (lambda *a, **kw: None)
        self._run_second_ocr = run_second_ocr
        self._save_image = save_image or (lambda *a, **kw: None)
        self._get_ocr2_image = get_ocr2_image or (lambda coords, img: img)

        # --- public state (read freely, mutate via methods only) -----------
        self.last_sent_result: str = ""
        self.last_ocr2_result: list = []
        self.force_stable: bool = False

        # --- internal state ------------------------------------------------
        self._pending: _PendingTextState | None = None
        self._meiki = _MeikiTracker()
        self._consecutive_empty: int = 0
        self._last_non_empty_text: str = ""

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
        self._consecutive_empty = 0
        self._last_non_empty_text = ""

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
        should_process = self._should_trigger(text, orig_text_string)

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
                text, orig_text_string, current_time, img,
                crop_coords, response_dict, raw_text_string,
            )

    # ------------------------------------------------------------------
    # Decision helpers
    # ------------------------------------------------------------------

    def _should_trigger(self, text: str, orig_text_string: str) -> bool:
        """Decide whether to trigger the second OCR pass."""
        if not self._pending:
            return False

        # Fall back to pending.text when orig_text was empty (e.g. ScreenAI
        # sometimes returns orig_text=[] while still producing a text string).
        p_orig = self._pending.orig_text or self._pending.text
        # Similarly, if the incoming frame has no raw token list, use its text.
        incoming = orig_text_string or text

        # Case 1: text disappeared
        if not text:
            return True

        # Case 2: force-stable
        if self.force_stable:
            return True

        # Case 3: text completely changed.
        # Compare on normalized text (punctuation stripped) so that shared
        # trailing punctuation (e.g. ・・・ / ...) or speaker tags don't
        # prevent the trigger from firing.
        is_low_sim = not compare_ocr_results(p_orig, incoming,
                                             self.CHANGE_THRESHOLD)
        # Also trigger at a broader threshold when the texts clearly differ at
        # an endpoint — catches same-speaker consecutive lines that share a
        # short character-name prefix but have completely different utterances
        # (e.g. "\u30a8\u30a4\u30c0\uff1a\u3088\u304f\u805e\u3051" → "\u30a8\u30a4\u30c0\uff1a\u7acb\u3061\u53bb\u308c").
        is_moderate_diff = not compare_ocr_results(p_orig, incoming,
                                                   self.PARTIAL_CHANGE_THRESHOLD)
        if (is_low_sim or is_moderate_diff):
            p_norm  = normalize_for_comparison(p_orig)
            in_norm = normalize_for_comparison(incoming)
            if p_norm and in_norm:
                # Guard: skip trigger when shorter text looks like a prefix
                # of the longer one — that's evolving text, not a new line.
                shorter_n = p_norm if len(p_norm) <= len(in_norm) else in_norm
                longer_n  = in_norm if len(p_norm) <= len(in_norm) else p_norm
                if is_evolving_text(shorter_n, longer_n):
                    return False
                # Require at least one endpoint to differ (OR, not AND) so
                # that same-speaker lines with the same opening still trigger.
                starts_diff = p_norm[0] != in_norm[0]
                ends_diff   = p_norm[-1] != in_norm[-1]
                if starts_diff or ends_diff:
                    return True

        return False

    def _is_text_evolving(self, orig_text_string: str) -> bool:
        """True when incoming text is an evolution of the pending text."""
        if not self._pending:
            return False
        # Use orig_text when available; fall back to text so that an empty
        # orig_text list doesn't prevent correct evolution detection.
        p_ref = self._pending.orig_text or self._pending.text
        return compare_ocr_results(p_ref, orig_text_string, self.CHANGE_THRESHOLD)

    # ------------------------------------------------------------------
    # State mutation
    # ------------------------------------------------------------------

    def _update_pending(
        self,
        text: str,
        orig_text_string: str,
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
            self._pending.img = _copy_img(img)
            self._pending.crop_coords = crop_coords
            self._pending.response_dict = response_dict
        else:
            self._pending = _PendingTextState(
                text=text,
                raw_text=raw_text,
                orig_text=orig_text_string,
                start_time=current_time,
                img=_copy_img(img),
                crop_coords=crop_coords,
                response_dict=response_dict,
            )
        if text:
            self._last_non_empty_text = orig_text_string
            self._consecutive_empty = 0

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

    def _send_bypass(
        self,
        ocr1_text: str,
        time: datetime,
        img: Any,
        *,
        response_dict: dict | None = None,
        source: str = "ocr",
    ) -> bool:
        """Bypass the second OCR engine (same-engine mode).

        Runs filtering for internal continuity bookkeeping, but dispatches the
        normalized raw OCR1 text so punctuation/symbols are preserved in output.
        Returns True if text was sent.
        """
        filtered_text, orig_text = self._filter(
            ocr1_text,
            None,  # blank memory: re-filter the raw orig_text from scratch
            engine=self.config.ocr2_engine,
            is_second_ocr=True,
        )
        text = _select_bypass_output_text(
            ocr1_text,
            filtered_text,
            keep_newline=self.config.keep_newline,
        )

        if compare_ocr_results(self.last_sent_result, text,
                               self.DEDUP_THRESHOLD):
            return False

        self._save_image(img)
        self.last_ocr2_result = orig_text
        self.last_sent_result = text
        self._send_result(text, time, response_dict=response_dict,
                          source=source)
        return True

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
        """Run the *real* second OCR engine and send the result."""
        if self._run_second_ocr is None:
            # No second engine configured – fall back to bypass.
            self._send_bypass(ocr1_text, time, img,
                              response_dict=response_dict, source=source)
            return

        ocr2_img = self._get_ocr2_image(crop_coords, img)

        result: SecondPassResult = self._run_second_ocr(
            ocr2_img,
            self.last_ocr2_result,
            self.filtering,
            self.config.ocr2_engine,
        )

        text = result.text
        orig_text = result.orig_text
        gen_response = result.response_dict

        # If second-pass returns empty text but first-pass had text, fall back.
        if not str(text or "").strip() and str(ocr1_text or "").strip():
            fallback_payload = response_dict or gen_response
            self._send_bypass(ocr1_text, time, img,
                              response_dict=fallback_payload, source=source)
            return

        if compare_ocr_results(self.last_sent_result, text,
                               self.DEDUP_THRESHOLD):
            return

        self._save_image(ocr2_img)
        self.last_ocr2_result = orig_text
        self.last_sent_result = text
        final_payload = response_dict or gen_response
        self._send_result(text, time, response_dict=final_payload,
                          source=source)

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

        # Use raw pre-filter text when available so bypass/fallback preserves punctuation
        # that may have been removed by TextFiltering memory.
        # Use orig_text when unavailable so that the bypass filter receives
        # the full OCR output rather than text already trimmed by TextFiltering memory.
        pending_text = pending.raw_text or pending.orig_text or pending.text
        pending_time = pending.start_time
        pending_img = pending.img
        pending_crop = pending.crop_coords
        pending_response = response_dict or pending.response_dict

        if self.config.same_engine:
            # Bypass mode: skip actual second OCR, just filter + send.
            self._send_bypass(
                pending_text, pending_time, pending_img,
                response_dict=pending_response, source=source,
            )
        else:
            # Full second pass with different engine.
            self._execute_second_pass(
                pending_text, pending_time, pending_img,
                crop_coords=pending_crop,
                response_dict=pending_response, source=source,
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

            # Stable → queue second pass.
            ocr2_img = self._get_ocr2_image(crop_coords, m.previous_img)
            self._execute_second_pass(
                text, m.last_crop_time or time, ocr2_img,
                crop_coords=crop_coords,
                response_dict=response_dict, source=source,
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

    # ------------------------------------------------------------------
    # Filtering helper
    # ------------------------------------------------------------------

    def _filter(
        self,
        text: str,
        last_result: list | None,
        *,
        engine: str | None = None,
        is_second_ocr: bool = False,
    ) -> tuple[str, list]:
        """Run text through the filtering callable if available."""
        if self.filtering is None:
            return text, [text] if text else []
        return self.filtering(text, last_result, engine=engine,
                              is_second_ocr=is_second_ocr)


# ---------------------------------------------------------------------------
# Module-level helpers
# ---------------------------------------------------------------------------


def _normalize_bypass_text(text: str, keep_newline: bool) -> str:
    """Normalize text for the bypass (same-engine) path."""
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
    """Choose outgoing bypass text while preserving punctuation when safe.

    Rules:
    - If filter produced empty text, honor it.
    - If filter output is a stripped subsequence of raw OCR text, use raw text.
      (common case: filter removed punctuation/symbols only)
    - If punctuation-insensitive normalization is equal, use raw text.
    - Otherwise use filtered text for substantive transformations.
    """
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
