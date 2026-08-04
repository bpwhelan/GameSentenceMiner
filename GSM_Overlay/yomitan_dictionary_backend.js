"use strict";

const { EventEmitter } = require("node:events");

const SCANNER_GATE_CLASS = "scan-disable";
const SCANNER_GATE_DATASET_KEY = "gsmDictionaryScanner";

const GENERIC_TO_YOMITAN_ACTION = Object.freeze({
  dismiss: "hide-popup",
  scroll: "scroll",
  "select-action": "select-action",
  "reset-action-selection": "reset-action-selection",
  "clear-action-selection": "clear-action-selection",
  "confirm-action": "confirm-action",
  "next-entry": "next-entry",
  "previous-entry": "previous-entry",
});

class YomitanDictionaryBackendError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "YomitanDictionaryBackendError";
    this.code = code;
  }
}

function finiteCoordinate(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

class YomitanDictionaryBackend extends EventEmitter {
  constructor(options = {}) {
    super();
    this.id = "yomitan";
    this.window = options.window || globalThis.window;
    this.document = options.document || globalThis.document;
    this.getBridge =
      typeof options.getBridge === "function"
        ? options.getBridge
        : () => this.window?.gsmYomitanBridge || null;
    this.getGeneration =
      typeof options.getGeneration === "function"
        ? options.getGeneration
        : () => 0;
    this.capabilities = new Set([
      "lookup",
      "dismiss",
      "scroll",
      "select-action",
      "reset-action-selection",
      "clear-action-selection",
      "confirm-action",
      "next-entry",
      "previous-entry",
      "mine",
    ]);
    this.started = false;
    this.scannerGateAdded = false;
    this.popupGenerations = new Map();
    this.generatedPopupId = 0;
    this.onPopupShown = (event) => this.#popupShown(event);
    this.onPopupHidden = (event) => this.#popupHidden(event);
  }

  setGenerationProvider(provider) {
    if (typeof provider === "function") {
      this.getGeneration = provider;
    }
  }

  async start() {
    if (!this.started) {
      this.window?.addEventListener?.(
        "yomitan-popup-shown",
        this.onPopupShown,
      );
      this.window?.addEventListener?.(
        "yomitan-popup-hidden",
        this.onPopupHidden,
      );
      this.started = true;
    }
    this.setScannerEnabled(true);
    this.emit("state", {
      lifecycle: "idle",
      generation: this.getGeneration(),
    });
  }

  async stop(options = {}) {
    this.setScannerEnabled(false);
    try {
      await this.#closePopups(options.reason || "backend-stop");
    } finally {
      if (this.started) {
        this.window?.removeEventListener?.(
          "yomitan-popup-shown",
          this.onPopupShown,
        );
        this.window?.removeEventListener?.(
          "yomitan-popup-hidden",
          this.onPopupHidden,
        );
        this.started = false;
      }
      this.popupGenerations.clear();
    }
  }

  async configure(context = {}) {
    if (context.scannerEnabled !== undefined) {
      this.setScannerEnabled(context.scannerEnabled === true);
    }
  }

  setScannerEnabled(enabled) {
    const root = this.document?.documentElement;
    if (!root?.classList) {
      return false;
    }

    if (enabled) {
      if (this.scannerGateAdded) {
        root.classList.remove(SCANNER_GATE_CLASS);
      }
      this.scannerGateAdded = false;
      if (root.dataset?.[SCANNER_GATE_DATASET_KEY] === "disabled") {
        delete root.dataset[SCANNER_GATE_DATASET_KEY];
      }
      return true;
    }

    if (!root.classList.contains(SCANNER_GATE_CLASS)) {
      root.classList.add(SCANNER_GATE_CLASS);
      this.scannerGateAdded = true;
    }
    if (root.dataset) {
      root.dataset[SCANNER_GATE_DATASET_KEY] = "disabled";
    }
    return true;
  }

  async tokenize(text, scanLength = 10, options = {}) {
    const bridge = this.getBridge();
    if (!bridge || typeof bridge.tokenize !== "function") {
      throw new YomitanDictionaryBackendError(
        "TOKENIZER_UNAVAILABLE",
        "The Yomitan tokenizer bridge is unavailable",
      );
    }
    return await bridge.tokenize(text, scanLength, options);
  }

  async lookup(request = {}) {
    const x = finiteCoordinate(request.pointer?.x ?? request.anchor?.x);
    const y = finiteCoordinate(request.pointer?.y ?? request.anchor?.y);
    if (x === null || y === null) {
      throw new YomitanDictionaryBackendError(
        "INVALID_ANCHOR",
        "Yomitan lookup requires a finite screen anchor",
      );
    }
    this.#sendControl("lookup-point", { x, y });
    return {
      status: "dispatched",
      generation: request.generation,
    };
  }

  async command(command, params = {}) {
    if (command === "mine") {
      this.#sendMine();
      return { status: "handled" };
    }
    if (command === "dismiss") {
      await this.#closePopups(params.reason || "dismiss");
      return { status: "handled" };
    }

    const action = GENERIC_TO_YOMITAN_ACTION[command];
    if (!action) {
      return { status: "unsupported" };
    }
    const adapterParams = { ...params };
    if (command === "scroll") {
      if (params.direction === "up") {
        adapterParams.direction = 1;
      } else if (params.direction === "down") {
        adapterParams.direction = -1;
      }
      if (Number.isFinite(params.amount)) {
        adapterParams.step = params.amount;
        delete adapterParams.amount;
      }
    } else if (command === "select-action") {
      if (params.direction === "previous") {
        adapterParams.direction = -1;
      } else if (params.direction === "next") {
        adapterParams.direction = 1;
      }
    }
    this.#sendControl(action, adapterParams);
    return { status: "handled" };
  }

  syncPopupStateFromDom(reason = "dom-sync") {
    const frames = this.#getPopupFrames().filter((frame) =>
      this.#isPopupFrameVisible(frame),
    );
    if (frames.length === 0) {
      return false;
    }

    const generation = this.getGeneration();
    const visibleIds = new Set(
      frames.map((_, index) => `yomitan-dom-popup-${index}`),
    );
    for (const popupId of visibleIds) {
      if (!this.popupGenerations.has(popupId)) {
        this.popupGenerations.set(popupId, generation);
        this.emit("popup-opened", {
          backendId: this.id,
          popupId,
          generation,
          reason,
        });
      }
    }
    for (const [popupId, popupGeneration] of this.popupGenerations) {
      if (popupId.startsWith("yomitan-dom-popup-") && !visibleIds.has(popupId)) {
        this.popupGenerations.delete(popupId);
        this.emit("popup-closed", {
          backendId: this.id,
          popupId,
          generation: popupGeneration,
          reason,
        });
      }
    }
    return true;
  }

  #popupShown(event) {
    const popupId =
      typeof event?.detail?.popupId === "string" && event.detail.popupId
        ? event.detail.popupId
        : `yomitan-popup-${++this.generatedPopupId}`;
    if (this.popupGenerations.has(popupId)) {
      return;
    }
    const generation = this.getGeneration();
    this.popupGenerations.set(popupId, generation);
    this.emit("popup-opened", {
      backendId: this.id,
      popupId,
      generation,
      reason: "yomitan-popup-shown",
    });
  }

  #popupHidden(event) {
    let popupId =
      typeof event?.detail?.popupId === "string" && event.detail.popupId
        ? event.detail.popupId
        : null;
    if (!popupId && this.popupGenerations.size > 0) {
      popupId = this.popupGenerations.keys().next().value;
    }
    if (!popupId || !this.popupGenerations.has(popupId)) {
      return;
    }
    const generation = this.popupGenerations.get(popupId);
    this.popupGenerations.delete(popupId);
    this.emit("popup-closed", {
      backendId: this.id,
      popupId,
      generation,
      reason: "yomitan-popup-hidden",
    });
  }

  async #closePopups(reason) {
    const bridge = this.getBridge();
    if (bridge && typeof bridge.closePopups === "function") {
      try {
        await bridge.closePopups({ timeoutMs: 1500, reason });
        return;
      } catch {
        // The control-message fallback remains available during bridge startup.
      }
    }
    this.#sendControl("hide-popup", { reason });
  }

  #sendControl(action, params = {}) {
    const message = {
      type: "gsm-yomitan-control",
      action,
      ...params,
    };
    this.window?.postMessage?.(message, "*");
    for (const frame of this.#getTargetFrames(action)) {
      try {
        frame.contentWindow?.postMessage(message, "*");
      } catch {
        // A disappearing nested frame must not abort the remaining dispatch.
      }
    }
  }

  #sendMine() {
    const message = {
      type: "gsm-trigger-anki-add",
      cardFormatIndex: 0,
    };
    this.window?.postMessage?.(message, "*");
    const frames = this.#getTargetFrames("mine");
    const frame = frames.at(-1);
    try {
      frame?.contentWindow?.postMessage(message, "*");
    } catch {
      // The root postMessage remains the compatibility path.
    }
  }

  #getPopupFrames() {
    const frames = Array.from(
      this.document?.querySelectorAll?.("iframe.yomitan-popup") || [],
    );
    if (frames.length > 0) {
      return frames;
    }
    const fallback = this.document?.querySelector?.("iframe");
    return fallback ? [fallback] : [];
  }

  #getTargetFrames(action) {
    const frames = this.#getPopupFrames();
    const frameScoped = new Set([
      "scroll",
      "select-action",
      "reset-action-selection",
      "clear-action-selection",
      "confirm-action",
      "next-entry",
      "previous-entry",
      "mine",
    ]);
    if (!frameScoped.has(action)) {
      return frames;
    }
    const visible = frames.filter((frame) => this.#isPopupFrameVisible(frame));
    if (visible.length > 0) {
      return [visible.at(-1)];
    }
    return frames.length > 0 ? [frames.at(-1)] : [];
  }

  #isPopupFrameVisible(frame) {
    if (!frame) {
      return false;
    }
    try {
      const style = this.window?.getComputedStyle?.(frame) || frame.style;
      if (style?.display === "none" || style?.visibility === "hidden") {
        return false;
      }
      const rect = frame.getBoundingClientRect?.();
      if (rect) {
        return rect.width > 0 && rect.height > 0;
      }
      return frame.getClientRects?.().length > 0;
    } catch {
      return true;
    }
  }
}

module.exports = {
  GENERIC_TO_YOMITAN_ACTION,
  SCANNER_GATE_CLASS,
  YomitanDictionaryBackend,
  YomitanDictionaryBackendError,
};
