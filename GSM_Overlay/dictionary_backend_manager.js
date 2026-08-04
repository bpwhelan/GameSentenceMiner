"use strict";

const { EventEmitter } = require("node:events");

const {
  DICTIONARY_BACKEND_IDS,
  DictionaryPopupControllerError,
} = require("./dictionary_popup_controller.js");

const BACKEND_MANAGER_STATES = Object.freeze({
  IDLE: "idle",
  SWITCHING: "switching",
  READY: "ready",
  ERROR: "error",
});

class DictionaryBackendManagerError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "DictionaryBackendManagerError";
    this.code = code;
  }
}

function errorCode(error, fallback) {
  return typeof error?.code === "string" && error.code ? error.code : fallback;
}

class DictionaryBackendManager extends EventEmitter {
  constructor(options = {}) {
    super();
    if (!options.controller) {
      throw new TypeError("DictionaryBackendManager requires a popup controller");
    }
    this.controller = options.controller;
    this.backends = new Map();
    this.activeBackend = null;
    this.state = BACKEND_MANAGER_STATES.IDLE;
    this.blocked = false;
    this.lastErrorCode = null;
    this.profileContext = {};
    this.catalogContext = {};
    this.transition = Promise.resolve();
    for (const backend of options.backends || []) {
      this.registerBackend(backend);
    }
  }

  registerBackend(backend) {
    if (!backend || typeof backend.id !== "string" || !backend.id) {
      throw new TypeError("Dictionary backend must have an id");
    }
    if (this.backends.has(backend.id)) {
      throw new DictionaryBackendManagerError(
        "DUPLICATE_BACKEND",
        `Dictionary backend ${backend.id} is already registered`,
      );
    }
    this.backends.set(backend.id, backend);
    return backend;
  }

  async start(
    backendId = DICTIONARY_BACKEND_IDS.YOMITAN,
    context = {},
  ) {
    if (this.activeBackend) {
      return await this.switchBackend(backendId, context);
    }
    return await this.#runTransition(async () => {
      const backend = this.#requireBackend(backendId);
      this.#setSwitching(backendId);
      try {
        await backend.start?.({
          ...this.#buildContext(context),
          reason: "startup",
        });
        this.controller.attachBackend(backend);
        this.activeBackend = backend;
        this.state = BACKEND_MANAGER_STATES.READY;
        this.lastErrorCode = null;
        return this.getSnapshot();
      } catch (error) {
        this.state = BACKEND_MANAGER_STATES.ERROR;
        this.lastErrorCode = errorCode(error, "BACKEND_START_FAILED");
        throw error;
      } finally {
        this.#setBlocked(false);
        this.#publishStatus();
      }
    });
  }

  async switchBackend(backendId, context = {}) {
    return await this.#runTransition(async () => {
      const nextBackend = this.#requireBackend(backendId);
      if (this.activeBackend === nextBackend) {
        await nextBackend.configure?.({
          ...this.#buildContext(context),
          reason: "backend-refresh",
        });
        this.state = BACKEND_MANAGER_STATES.READY;
        this.#publishStatus();
        return this.getSnapshot();
      }

      const previousBackend = this.activeBackend;
      this.#setSwitching(backendId);
      await this.controller.dismiss("backend-switch");
      try {
        await previousBackend?.stop?.({
          ...this.#buildContext(context),
          reason: "backend-switch",
          nextBackendId: backendId,
        });
        await nextBackend.start?.({
          ...this.#buildContext(context),
          reason: "backend-switch",
          previousBackendId: previousBackend?.id || null,
        });
        this.controller.attachBackend(nextBackend);
        this.activeBackend = nextBackend;
        this.state = BACKEND_MANAGER_STATES.READY;
        this.lastErrorCode = null;
        return this.getSnapshot();
      } catch (error) {
        this.lastErrorCode = errorCode(error, "BACKEND_SWITCH_FAILED");
        try {
          await nextBackend.stop?.({
            ...this.#buildContext(context),
            reason: "failed-backend-start",
          });
        } catch {
          // The original transition error is authoritative.
        }

        if (previousBackend) {
          try {
            await previousBackend.start?.({
              ...this.#buildContext(context),
              reason: "backend-switch-rollback",
              failedBackendId: backendId,
            });
            this.controller.attachBackend(previousBackend);
            this.activeBackend = previousBackend;
            this.state = BACKEND_MANAGER_STATES.READY;
          } catch (rollbackError) {
            this.activeBackend = null;
            this.controller.detachBackend("backend-rollback-failed");
            this.state = BACKEND_MANAGER_STATES.ERROR;
            this.lastErrorCode = errorCode(
              rollbackError,
              "BACKEND_ROLLBACK_FAILED",
            );
          }
        } else {
          this.activeBackend = null;
          this.controller.detachBackend("backend-start-failed");
          this.state = BACKEND_MANAGER_STATES.ERROR;
        }
        throw error;
      } finally {
        this.#setBlocked(false);
        this.#publishStatus();
      }
    });
  }

  async updateProfile(context = {}) {
    this.profileContext = { ...context };
    await this.controller.dismiss("profile-change");
    await this.activeBackend?.configure?.({
      ...this.#buildContext(),
      reason: "profile-change",
    });
    this.#publishStatus();
    return this.getSnapshot();
  }

  async updateCatalog(context = {}) {
    this.catalogContext = { ...context };
    await this.controller.dismiss("catalog-change");
    await this.activeBackend?.configure?.({
      ...this.#buildContext(),
      reason: "catalog-change",
    });
    this.#publishStatus();
    return this.getSnapshot();
  }

  async lookup(intent) {
    if (this.blocked) {
      throw new DictionaryPopupControllerError(
        "LOOKUP_BLOCKED",
        "Dictionary lookup is blocked during a backend transition",
      );
    }
    return await this.controller.lookup(intent);
  }

  async command(command, params = {}) {
    return await this.controller.command(command, params);
  }

  async dismiss(reason = "dismissed") {
    return await this.controller.dismiss(reason);
  }

  getSnapshot() {
    return {
      backendId: this.activeBackend?.id || null,
      state: this.state,
      blocked: this.blocked,
      lastErrorCode: this.lastErrorCode,
      controller: this.controller.getSnapshot(),
    };
  }

  #requireBackend(backendId) {
    const backend = this.backends.get(backendId);
    if (!backend) {
      throw new DictionaryBackendManagerError(
        "BACKEND_UNKNOWN",
        `Dictionary backend ${String(backendId)} is not registered`,
      );
    }
    return backend;
  }

  #buildContext(context = {}) {
    return {
      ...this.catalogContext,
      ...this.profileContext,
      ...context,
    };
  }

  #setSwitching(targetBackendId) {
    this.state = BACKEND_MANAGER_STATES.SWITCHING;
    this.#setBlocked(true, `switch:${targetBackendId}`);
    this.#publishStatus({ targetBackendId });
  }

  #setBlocked(blocked, reason = null) {
    this.blocked = blocked === true;
    this.controller.setBlocked(this.blocked, reason);
  }

  #publishStatus(extra = {}) {
    this.emit("status", {
      ...this.getSnapshot(),
      ...extra,
    });
  }

  #runTransition(operation) {
    const run = this.transition.then(operation, operation);
    this.transition = run.catch(() => {});
    return run;
  }
}

module.exports = {
  BACKEND_MANAGER_STATES,
  DictionaryBackendManager,
  DictionaryBackendManagerError,
};
