"use strict";

const { EventEmitter } = require("node:events");

const DICTIONARY_BACKEND_IDS = Object.freeze({
  YOMITAN: "yomitan",
  HOSHIDICTS: "hoshidicts",
});

const POPUP_LIFECYCLE_STATES = Object.freeze({
  IDLE: "idle",
  LOADING: "loading",
  RESULTS: "results",
  EMPTY: "empty",
  ERROR: "error",
  SWITCHING: "switching",
});

const DICTIONARY_POPUP_COMMANDS = Object.freeze([
  "lookup",
  "dismiss",
  "scroll",
  "select-action",
  "reset-action-selection",
  "clear-action-selection",
  "confirm-action",
  "next-entry",
  "previous-entry",
  "recursive-back",
  "mine",
]);

class DictionaryPopupControllerError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "DictionaryPopupControllerError";
    this.code = code;
  }
}

function normalizeErrorCode(error, fallback = "BACKEND_ERROR") {
  return typeof error?.code === "string" && error.code
    ? error.code
    : fallback;
}

function normalizeResultLifecycle(result) {
  switch (result?.status) {
    case "results":
    case "ready":
      return POPUP_LIFECYCLE_STATES.RESULTS;
    case "empty":
    case "no-result":
      return POPUP_LIFECYCLE_STATES.EMPTY;
    case "error":
    case "unavailable":
      return POPUP_LIFECYCLE_STATES.ERROR;
    default:
      return POPUP_LIFECYCLE_STATES.LOADING;
  }
}

function validateBackend(backend) {
  if (
    !backend ||
    typeof backend !== "object" ||
    typeof backend.id !== "string" ||
    !backend.id ||
    typeof backend.lookup !== "function" ||
    typeof backend.command !== "function"
  ) {
    throw new TypeError("Dictionary backend does not implement the popup contract");
  }
  return backend;
}

class DictionaryPopupController extends EventEmitter {
  constructor(options = {}) {
    super();
    this.publishPopupEvent =
      typeof options.publishPopupEvent === "function"
        ? options.publishPopupEvent
        : null;
    this.logger = options.logger || console;
    this.backend = null;
    this.generation = 0;
    this.lifecycle = POPUP_LIFECYCLE_STATES.IDLE;
    this.anchorKey = null;
    this.blocked = false;
    this.blockReason = null;
    this.lastErrorCode = null;
    this.popupIds = new Map();
    this.lookupAbortController = null;
    this.onBackendPopupOpened = (event) => this.#handlePopupOpened(event);
    this.onBackendPopupClosed = (event) => this.#handlePopupClosed(event);
    this.onBackendState = (event) => this.#handleBackendState(event);
  }

  attachBackend(backend) {
    validateBackend(backend);
    if (this.backend === backend) {
      return this.getSnapshot();
    }

    this.#detachBackendEvents();
    this.invalidate("backend-attached");
    this.backend = backend;
    if (typeof backend.setGenerationProvider === "function") {
      backend.setGenerationProvider(() => this.generation);
    }
    backend.on?.("popup-opened", this.onBackendPopupOpened);
    backend.on?.("popup-closed", this.onBackendPopupClosed);
    backend.on?.("state", this.onBackendState);
    this.emit("backend-changed", {
      backendId: backend.id,
      generation: this.generation,
    });
    this.#emitState();
    return this.getSnapshot();
  }

  detachBackend(reason = "backend-detached") {
    this.#detachBackendEvents();
    this.invalidate(reason);
    this.backend = null;
    this.#emitState();
  }

  #detachBackendEvents() {
    if (!this.backend) {
      return;
    }
    this.backend.removeListener?.("popup-opened", this.onBackendPopupOpened);
    this.backend.removeListener?.("popup-closed", this.onBackendPopupClosed);
    this.backend.removeListener?.("state", this.onBackendState);
  }

  setBlocked(blocked, reason = null) {
    this.blocked = blocked === true;
    this.blockReason = this.blocked ? String(reason || "transition") : null;
    if (this.blocked) {
      this.lifecycle = POPUP_LIFECYCLE_STATES.SWITCHING;
    } else if (this.lifecycle === POPUP_LIFECYCLE_STATES.SWITCHING) {
      this.lifecycle = this.popupIds.size > 0
        ? POPUP_LIFECYCLE_STATES.RESULTS
        : POPUP_LIFECYCLE_STATES.IDLE;
    }
    this.#emitState();
  }

  invalidate(reason = "invalidated", options = {}) {
    if (this.lookupAbortController) {
      this.lookupAbortController.abort(reason);
      this.lookupAbortController = null;
    }
    this.generation += 1;
    this.anchorKey = null;
    this.lastErrorCode = null;
    if (options.keepPopups !== true) {
      this.#clearPopups(reason);
    }
    if (!this.blocked) {
      this.lifecycle = POPUP_LIFECYCLE_STATES.IDLE;
    }
    this.emit("generation-changed", {
      generation: this.generation,
      reason,
    });
    this.#emitState();
    return this.generation;
  }

  async lookup(intent = {}) {
    if (this.blocked) {
      throw new DictionaryPopupControllerError(
        "LOOKUP_BLOCKED",
        `Dictionary lookup is blocked during ${this.blockReason || "a backend transition"}`,
      );
    }
    if (!this.backend) {
      throw new DictionaryPopupControllerError(
        "BACKEND_UNAVAILABLE",
        "No dictionary backend is active",
      );
    }

    const generation = this.invalidate("lookup");
    const controller = new AbortController();
    this.lookupAbortController = controller;
    this.anchorKey =
      typeof intent.anchorKey === "string" && intent.anchorKey
        ? intent.anchorKey
        : null;
    this.lifecycle = POPUP_LIFECYCLE_STATES.LOADING;
    this.#emitState();

    try {
      const result = await this.backend.lookup({
        ...intent,
        generation,
        signal: controller.signal,
      });
      if (
        generation !== this.generation ||
        controller.signal.aborted ||
        this.backend?.id !== this.getSnapshot().backendId
      ) {
        return { status: "stale", generation };
      }

      this.lookupAbortController = null;
      if (this.popupIds.size === 0) {
        this.lifecycle = normalizeResultLifecycle(result);
      }
      this.lastErrorCode =
        this.lifecycle === POPUP_LIFECYCLE_STATES.ERROR
          ? normalizeErrorCode(result, "LOOKUP_FAILED")
          : null;
      this.#emitState();
      return {
        status: "applied",
        generation,
        result,
      };
    } catch (error) {
      if (generation !== this.generation || controller.signal.aborted) {
        return { status: "stale", generation };
      }
      this.lookupAbortController = null;
      this.lifecycle = POPUP_LIFECYCLE_STATES.ERROR;
      this.lastErrorCode = normalizeErrorCode(error, "LOOKUP_FAILED");
      this.#emitState();
      throw error;
    }
  }

  async command(command, params = {}) {
    if (!DICTIONARY_POPUP_COMMANDS.includes(command)) {
      throw new DictionaryPopupControllerError(
        "INVALID_COMMAND",
        `Unknown dictionary popup command: ${String(command)}`,
      );
    }
    if (!this.backend) {
      throw new DictionaryPopupControllerError(
        "BACKEND_UNAVAILABLE",
        "No dictionary backend is active",
      );
    }
    if (
      this.backend.capabilities instanceof Set &&
      !this.backend.capabilities.has(command)
    ) {
      return {
        status: "unsupported",
        command,
        generation: this.generation,
      };
    }

    try {
      const value = await this.backend.command(command, {
        ...params,
        generation: this.generation,
      });
      return {
        status: value?.status || "handled",
        command,
        generation: this.generation,
        value,
      };
    } catch (error) {
      return {
        status: "failed",
        command,
        generation: this.generation,
        errorCode: normalizeErrorCode(error, "COMMAND_FAILED"),
      };
    }
  }

  async dismiss(reason = "dismissed") {
    const closingGeneration = this.generation;
    const backend = this.backend;
    this.invalidate(reason);
    if (!backend) {
      return { status: "handled", generation: this.generation };
    }
    try {
      const value = await backend.command("dismiss", {
        reason,
        generation: closingGeneration,
      });
      return {
        status: value?.status || "handled",
        generation: this.generation,
        value,
      };
    } catch (error) {
      return {
        status: "failed",
        generation: this.generation,
        errorCode: normalizeErrorCode(error, "DISMISS_FAILED"),
      };
    }
  }

  getCapabilities() {
    if (!this.backend?.capabilities) {
      return [];
    }
    return Array.from(this.backend.capabilities);
  }

  getSnapshot() {
    return {
      backendId: this.backend?.id || null,
      generation: this.generation,
      lifecycle: this.lifecycle,
      active: this.popupIds.size > 0,
      popupCount: this.popupIds.size,
      popupIds: Array.from(this.popupIds.keys()),
      anchorKey: this.anchorKey,
      blocked: this.blocked,
      blockReason: this.blockReason,
      capabilities: this.getCapabilities(),
      lastErrorCode: this.lastErrorCode,
    };
  }

  #handlePopupOpened(event = {}) {
    if (!this.backend || event.backendId && event.backendId !== this.backend.id) {
      return false;
    }
    const generation = Number.isSafeInteger(event.generation)
      ? event.generation
      : this.generation;
    if (generation !== this.generation) {
      return false;
    }
    const popupId =
      typeof event.popupId === "string" && event.popupId
        ? event.popupId
        : `popup-${generation}-${this.popupIds.size + 1}`;
    if (this.popupIds.has(popupId)) {
      return false;
    }

    this.popupIds.set(popupId, {
      generation,
      backendId: this.backend.id,
    });
    this.lifecycle = POPUP_LIFECYCLE_STATES.RESULTS;
    this.lastErrorCode = null;
    this.#publishPopupState(true, event.reason || "popup-opened");
    this.#emitState();
    return true;
  }

  #handlePopupClosed(event = {}) {
    if (!this.backend || event.backendId && event.backendId !== this.backend.id) {
      return false;
    }
    const generation = Number.isSafeInteger(event.generation)
      ? event.generation
      : this.generation;
    if (generation !== this.generation) {
      return false;
    }

    let popupId =
      typeof event.popupId === "string" && event.popupId
        ? event.popupId
        : null;
    if (!popupId && this.popupIds.size > 0) {
      popupId = this.popupIds.keys().next().value;
    }
    if (!popupId || !this.popupIds.has(popupId)) {
      return false;
    }
    this.popupIds.delete(popupId);

    if (this.popupIds.size === 0) {
      this.lifecycle = POPUP_LIFECYCLE_STATES.IDLE;
      this.anchorKey = null;
      this.#publishPopupState(false, event.reason || "popup-closed");
    } else {
      this.#publishPopupState(true, event.reason || "nested-popup-closed");
    }
    this.#emitState();
    return true;
  }

  #handleBackendState(event = {}) {
    const generation = Number.isSafeInteger(event.generation)
      ? event.generation
      : this.generation;
    if (generation !== this.generation) {
      return;
    }
    if (Object.values(POPUP_LIFECYCLE_STATES).includes(event.lifecycle)) {
      this.lifecycle = event.lifecycle;
    }
    if (typeof event.errorCode === "string") {
      this.lastErrorCode = event.errorCode;
    }
    this.#emitState();
  }

  #clearPopups(reason) {
    if (this.popupIds.size === 0) {
      return;
    }
    this.popupIds.clear();
    this.#publishPopupState(false, reason);
  }

  #publishPopupState(active, reason) {
    const event = {
      type: "dictionary-popup-event",
      active: active === true,
      backendId: this.backend?.id || null,
      generation: this.generation,
      popupCount: this.popupIds.size,
      reason,
    };
    this.publishPopupEvent?.(event);
    this.emit("popup-state", event);
  }

  #emitState() {
    this.emit("state", this.getSnapshot());
  }
}

module.exports = {
  DICTIONARY_BACKEND_IDS,
  DICTIONARY_POPUP_COMMANDS,
  DictionaryPopupController,
  DictionaryPopupControllerError,
  POPUP_LIFECYCLE_STATES,
};
