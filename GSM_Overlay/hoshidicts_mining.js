"use strict";

const { randomUUID: nodeRandomUUID } = require("node:crypto");

const RESULT_CHANNEL = "dictionary-mine-result";
const READINESS_RESULT_CHANNEL = "dictionary-mine-readiness-result";

class HoshiDictsMiningClientError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "HoshiDictsMiningClientError";
    this.code = code;
  }
}

function clientError(code, message) {
  return new HoshiDictsMiningClientError(code, message);
}

function normalizedReadiness(payload = {}) {
  return Object.freeze({
    ready: payload.ready === true,
    status:
      typeof payload.status === "string" && payload.status
        ? payload.status
        : "unknown",
    message: typeof payload.message === "string" ? payload.message : "",
    missing: Array.isArray(payload.missing)
      ? payload.missing.filter((value) => typeof value === "string").slice(0, 32)
      : [],
  });
}

class HoshiDictsMiningClient {
  constructor(options = {}) {
    if (!options.ipcRenderer || typeof options.ipcRenderer.send !== "function") {
      throw new TypeError("HoshiDictsMiningClient requires ipcRenderer");
    }
    this.ipcRenderer = options.ipcRenderer;
    this.randomUUID =
      typeof options.randomUUID === "function"
        ? options.randomUUID
        : nodeRandomUUID;
    this.timeoutMs = Math.max(
      100,
      Math.min(120_000, Number(options.timeoutMs) || 15_000),
    );
    this.sessionId =
      typeof options.sessionId === "string" && options.sessionId
        ? options.sessionId
        : this.randomUUID();
    this.readiness = normalizedReadiness();
    this.pending = new Map();
    this.destroyed = false;
    this.onMineResult = (_event, payload) =>
      this.#resolvePending("mine", payload);
    this.onReadinessResult = (_event, payload) => {
      if (payload?.backend === "hoshidicts") {
        this.readiness = normalizedReadiness(payload);
      }
      this.#resolvePending("readiness", payload);
    };
    this.ipcRenderer.on(RESULT_CHANNEL, this.onMineResult);
    this.ipcRenderer.on(READINESS_RESULT_CHANNEL, this.onReadinessResult);
  }

  #newRequestId() {
    if (this.destroyed) {
      throw clientError(
        "MINING_CLIENT_DESTROYED",
        "Hoshi mining client is closed",
      );
    }
    const requestId = String(this.randomUUID() || "").trim();
    if (!requestId || this.pending.has(requestId)) {
      throw clientError(
        "MINING_REQUEST_ID_INVALID",
        "Could not allocate a unique mining request ID",
      );
    }
    return requestId;
  }

  #waitFor(kind, requestId) {
    if (this.destroyed) {
      return Promise.reject(
        clientError("MINING_CLIENT_DESTROYED", "Hoshi mining client is closed"),
      );
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          clientError(
            "MINING_REQUEST_TIMEOUT",
            "Hoshi mining did not receive a backend response",
          ),
        );
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(requestId, { kind, resolve, reject, timer });
    });
  }

  #resolvePending(kind, payload) {
    const requestId =
      typeof payload?.request_id === "string" ? payload.request_id : "";
    const pending = this.pending.get(requestId);
    if (!pending || pending.kind !== kind) {
      return false;
    }
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    pending.resolve(payload);
    return true;
  }

  refreshReadiness() {
    const requestId = this.#newRequestId();
    const pending = this.#waitFor("readiness", requestId);
    this.ipcRenderer.send("dictionary-mine-readiness-request", {
      type: "dictionary-mine-readiness-request",
      backend: "hoshidicts",
      request_id: requestId,
    });
    return pending;
  }

  getReadiness() {
    return this.readiness;
  }

  mine(selection = {}) {
    if (!selection || typeof selection !== "object") {
      return Promise.reject(
        clientError("MINING_SELECTION_INVALID", "Hoshi mining selection is invalid"),
      );
    }
    const requestId = this.#newRequestId();
    const idempotencyKey =
      typeof selection.idempotency_key === "string" &&
      selection.idempotency_key
        ? selection.idempotency_key
        : requestId;
    const pending = this.#waitFor("mine", requestId);
    this.ipcRenderer.send("dictionary-mine-request", {
      type: "dictionary-mine-request",
      request_id: requestId,
      idempotency_key: idempotencyKey,
      session_id: this.sessionId,
      backend: "hoshidicts",
      line_id:
        typeof selection.line_id === "string" ? selection.line_id : "",
      source_sentence:
        typeof selection.source_sentence === "string"
          ? selection.source_sentence
          : "",
      lookup: selection.lookup,
      media: Array.isArray(selection.media) ? selection.media : [],
    });
    return pending;
  }

  destroy() {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.ipcRenderer.removeListener(RESULT_CHANNEL, this.onMineResult);
    this.ipcRenderer.removeListener(
      READINESS_RESULT_CHANNEL,
      this.onReadinessResult,
    );
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        clientError("MINING_CLIENT_DESTROYED", "Hoshi mining client is closed"),
      );
    }
    this.pending.clear();
  }
}

module.exports = {
  HoshiDictsMiningClient,
  HoshiDictsMiningClientError,
  normalizedReadiness,
};
