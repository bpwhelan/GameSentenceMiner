"use strict";

const DICTIONARY_POPUP_SELECTOR = [
  "#hoshidicts-popup-root",
  ".hoshidicts-popup",
  "iframe.yomitan-popup",
  ".yomitan-popup",
  "yomitan-popup-tag-name",
  "[data-dictionary-popup-owner]",
].join(",");

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function eventComposedPath(event) {
  if (typeof event?.composedPath === "function") {
    const path = event.composedPath();
    if (Array.isArray(path)) {
      return path;
    }
  }

  const path = [];
  let node = event?.target || null;
  while (node) {
    path.push(node);
    node = node.parentNode || node.host || null;
  }
  return path;
}

function isDictionaryPopupNode(node) {
  return (
    node &&
    typeof node.matches === "function" &&
    node.matches(DICTIONARY_POPUP_SELECTOR)
  );
}

function eventHitsDictionaryPopup(event) {
  return eventComposedPath(event).some(isDictionaryPopupNode);
}

function classifyDictionaryPointerEvent(event, state = {}) {
  if (eventHitsDictionaryPopup(event)) {
    return "inside-popup";
  }
  if (state.popupActive === true) {
    return "dismiss-popup";
  }
  if (state.interactionSuppressed === true) {
    return "restore-pass-through";
  }
  return "outside-popup";
}

function codePoints(value) {
  return Array.from(String(value || ""));
}

function utf16OffsetForCodePoint(value, codePointOffset) {
  return codePoints(value)
    .slice(0, Math.max(0, codePointOffset))
    .join("").length;
}

function codePointOffsetFromUtf16(value, utf16Offset) {
  return codePoints(String(value || "").slice(0, Math.max(0, utf16Offset)))
    .length;
}

function getTextBoxFromEvent(event) {
  for (const node of eventComposedPath(event)) {
    if (node && typeof node.matches === "function" && node.matches(".text-box")) {
      return node;
    }
  }
  return event?.target?.closest?.(".text-box") || null;
}

function getLineTextBoxes(document, target) {
  const lineIndex = target?.dataset?.lineIndex;
  const scope = target?.closest?.(".text-block-container") || document;
  const boxes = Array.from(scope?.querySelectorAll?.(".text-box") || []);
  if (lineIndex === undefined) {
    return boxes.includes(target) ? [target] : [];
  }
  return boxes.filter((box) => box.dataset?.lineIndex === lineIndex);
}

function pointOffsetFromCaret(document, event, target) {
  let caret = null;
  if (typeof document?.caretPositionFromPoint === "function") {
    caret = document.caretPositionFromPoint(event.clientX, event.clientY);
    if (caret) {
      caret = {
        node: caret.offsetNode,
        offset: caret.offset,
      };
    }
  } else if (typeof document?.caretRangeFromPoint === "function") {
    const range = document.caretRangeFromPoint(event.clientX, event.clientY);
    if (range) {
      caret = {
        node: range.startContainer,
        offset: range.startOffset,
      };
    }
  }
  if (!caret?.node || !target.contains(caret.node)) {
    return null;
  }

  const text = String(target.textContent || "");
  if (caret.node.nodeType === 3) {
    return Math.min(
      codePoints(text).length - 1,
      codePointOffsetFromUtf16(caret.node.nodeValue, caret.offset),
    );
  }
  return Math.min(codePoints(text).length - 1, Math.max(0, caret.offset));
}

function pointOffsetFromGeometry(window, event, target, textLength) {
  const rect = target.getBoundingClientRect();
  const style = window?.getComputedStyle?.(target);
  const vertical = String(
    style?.writingMode || target.style?.writingMode || "",
  ).startsWith("vertical");
  const extent = vertical ? rect.height : rect.width;
  const position = vertical
    ? finiteNumber(event.clientY) - rect.top
    : finiteNumber(event.clientX) - rect.left;
  const ratio =
    extent > 0
      ? Math.max(0, Math.min(0.999999, position / extent))
      : 0;
  return Math.min(textLength - 1, Math.max(0, Math.floor(ratio * textLength)));
}

function getCharacterAnchor(document, target, codePointOffset) {
  const fallback = target.getBoundingClientRect();
  const textNode = Array.from(target.childNodes || []).find(
    (node) => node.nodeType === 3 && node.nodeValue,
  );
  if (!textNode || typeof document?.createRange !== "function") {
    return fallback;
  }

  try {
    const text = String(textNode.nodeValue || "");
    const start = utf16OffsetForCodePoint(text, codePointOffset);
    const end = utf16OffsetForCodePoint(text, codePointOffset + 1);
    const range = document.createRange();
    range.setStart(textNode, start);
    range.setEnd(textNode, end);
    const rect = range.getBoundingClientRect?.();
    if (rect && rect.width > 0 && rect.height > 0) {
      return rect;
    }
  } catch {
    // A disappearing text node falls back to the stable text-box bounds.
  }
  return fallback;
}

function rectToAnchor(rect) {
  return {
    x: finiteNumber(rect?.left ?? rect?.x),
    y: finiteNumber(rect?.top ?? rect?.y),
    width: Math.max(0, finiteNumber(rect?.width)),
    height: Math.max(0, finiteNumber(rect?.height)),
  };
}

function buildDictionaryPointerLookupIntent(event, options = {}) {
  const document = options.document || globalThis.document;
  const window = options.window || globalThis.window;
  const target = getTextBoxFromEvent(event);
  if (!document || !target || eventHitsDictionaryPopup(event)) {
    return null;
  }

  const targetText = codePoints(target.textContent);
  if (targetText.length === 0) {
    return null;
  }
  const boxes = getLineTextBoxes(document, target);
  const targetIndex = boxes.indexOf(target);
  if (targetIndex < 0) {
    return null;
  }

  const caretOffset = pointOffsetFromCaret(document, event, target);
  const targetOffset =
    caretOffset === null
      ? pointOffsetFromGeometry(
          window,
          event,
          target,
          targetText.length,
        )
      : caretOffset;
  const priorLength = boxes
    .slice(0, targetIndex)
    .reduce((total, box) => total + codePoints(box.textContent).length, 0);
  const absoluteOffset = priorLength + targetOffset;
  const lineText = boxes.map((box) => String(box.textContent || "")).join("");
  const lookupText = codePoints(lineText).slice(absoluteOffset).join("");
  if (!lookupText.trim()) {
    return null;
  }

  const sourceSentence =
    boxes.map((box) => box.dataset?.sourceSentence).find(Boolean) ||
    lineText;
  const lineId =
    boxes.map((box) => box.dataset?.lineId).find(Boolean) || null;
  const renderGeneration =
    target.dataset?.renderGeneration ||
    boxes.map((box) => box.dataset?.renderGeneration).find(Boolean) ||
    "unknown";
  const lineIndex = target.dataset?.lineIndex || "unknown";
  const anchor = rectToAnchor(
    getCharacterAnchor(document, target, targetOffset),
  );

  return {
    text: lookupText,
    sourceSentence,
    ...(lineId ? { lineId } : {}),
    anchor,
    anchorKey: `${renderGeneration}:${lineIndex}:${absoluteOffset}`,
    pointer: {
      x: finiteNumber(event.clientX, anchor.x),
      y: finiteNumber(event.clientY, anchor.y),
    },
  };
}

class DictionaryPointerScanner {
  constructor(options = {}) {
    if (typeof options.lookup !== "function") {
      throw new TypeError("DictionaryPointerScanner requires a lookup function");
    }
    this.document = options.document || globalThis.document;
    this.window = options.window || globalThis.window;
    this.lookup = options.lookup;
    this.getBackendId =
      typeof options.getBackendId === "function"
        ? options.getBackendId
        : () => null;
    this.isInteractionSuppressed =
      typeof options.isInteractionSuppressed === "function"
        ? options.isInteractionSuppressed
        : () => false;
    this.debounceMs = Math.max(
      0,
      Math.min(1000, finiteNumber(options.debounceMs, 120)),
    );
    this.setTimeoutFn = options.setTimeoutFn || setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
    this.logger = options.logger || console;
    this.timer = null;
    this.pendingIntent = null;
    this.lastAnchorKey = null;
    this.started = false;
    this.boundPointerMove = (event) => this.handlePointerMove(event);
  }

  start() {
    if (!this.started) {
      this.document?.addEventListener?.(
        "pointermove",
        this.boundPointerMove,
        { capture: true, passive: true },
      );
      this.started = true;
    }
    return this;
  }

  handlePointerMove(event) {
    if (
      this.getBackendId() !== "hoshidicts" ||
      this.isInteractionSuppressed() ||
      eventHitsDictionaryPopup(event)
    ) {
      this.cancelPending();
      return false;
    }
    const intent = buildDictionaryPointerLookupIntent(event, {
      document: this.document,
      window: this.window,
    });
    if (!intent) {
      this.cancelPending();
      return false;
    }
    if (
      intent.anchorKey === this.lastAnchorKey ||
      intent.anchorKey === this.pendingIntent?.anchorKey
    ) {
      return false;
    }

    this.cancelPending();
    this.pendingIntent = intent;
    this.timer = this.setTimeoutFn(() => {
      const pending = this.pendingIntent;
      this.timer = null;
      this.pendingIntent = null;
      if (
        !pending ||
        this.getBackendId() !== "hoshidicts" ||
        this.isInteractionSuppressed()
      ) {
        return;
      }
      this.lastAnchorKey = pending.anchorKey;
      Promise.resolve(this.lookup(pending)).catch((error) => {
        this.lastAnchorKey = null;
        this.logger.warn?.(
          `[DictionaryPointer] Lookup failed (${String(
            error?.code || "LOOKUP_FAILED",
          )})`,
        );
      });
    }, this.debounceMs);
    return true;
  }

  cancelPending() {
    if (this.timer !== null) {
      this.clearTimeoutFn(this.timer);
      this.timer = null;
    }
    this.pendingIntent = null;
  }

  invalidate() {
    this.cancelPending();
    this.lastAnchorKey = null;
  }

  dispose() {
    this.invalidate();
    if (this.started) {
      this.document?.removeEventListener?.(
        "pointermove",
        this.boundPointerMove,
        { capture: true },
      );
      this.started = false;
    }
  }
}

function buildDictionaryInteractionSnapshot(state = {}) {
  const popup = state.popup || {};
  const popupActive = popup.active === true;
  const manualHoldActive = state.manualHoldActive === true;
  const manualToggleActive = state.manualToggleActive === true;
  const gamepadNavigationActive = state.gamepadNavigationActive === true;
  const resizeMode = state.resizeMode === true;
  const manualActive = manualHoldActive || manualToggleActive;
  let focusOwner = "game";
  if (manualActive) {
    focusOwner = "manual";
  } else if (gamepadNavigationActive) {
    focusOwner = "gamepad";
  } else if (resizeMode) {
    focusOwner = "resize";
  } else if (popupActive && state.focusOnLookup === true) {
    focusOwner = "dictionary-popup";
  }

  return {
    popup: {
      active: popupActive,
      owner:
        popupActive && typeof popup.backendId === "string"
          ? popup.backendId
          : null,
      count: Number.isSafeInteger(popup.popupCount)
        ? Math.max(0, popup.popupCount)
        : 0,
      generation: Number.isSafeInteger(popup.generation)
        ? popup.generation
        : 0,
    },
    focusOwner,
    expectedClickThrough:
      !popupActive &&
      !manualActive &&
      !gamepadNavigationActive &&
      !resizeMode,
    manual: {
      enabled: state.manualMode === true,
      holdActive: manualHoldActive,
      toggleActive: manualToggleActive,
      interactionSuppressed:
        state.manualMode === true && !manualActive,
    },
    magpie: {
      active: state.magpieState?.active === true,
      signature:
        typeof state.magpieState?.signature === "string"
          ? state.magpieState.signature
          : null,
    },
  };
}

module.exports = {
  DICTIONARY_POPUP_SELECTOR,
  DictionaryPointerScanner,
  buildDictionaryInteractionSnapshot,
  buildDictionaryPointerLookupIntent,
  classifyDictionaryPointerEvent,
  eventHitsDictionaryPopup,
  isDictionaryPopupNode,
};
