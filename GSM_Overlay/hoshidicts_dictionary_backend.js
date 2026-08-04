"use strict";

const { EventEmitter } = require("node:events");

const { HoshiDictsMediaResolver } = require("./hoshidicts_media.js");
const {
  normalizeTermLookupResult,
} = require("./hoshidicts_result_model.js");

class HoshiDictsDictionaryBackendError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "HoshiDictsDictionaryBackendError";
    this.code = code;
  }
}

function backendError(code, message) {
  return new HoshiDictsDictionaryBackendError(code, message);
}

function errorCode(error, fallback = "HOSHIDICTS_ERROR") {
  return typeof error?.code === "string" && error.code ? error.code : fallback;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(minimum, Math.min(maximum, Math.round(number)));
}

function normalizeCatalog(catalog) {
  if (
    !catalog ||
    typeof catalog !== "object" ||
    !Number.isSafeInteger(catalog.generation) ||
    catalog.generation <= 0 ||
    !Array.isArray(catalog.dictionaries) ||
    catalog.dictionaries.length > 64
  ) {
    throw backendError("CATALOG_INVALID", "HoshiDicts catalog is invalid");
  }
  const seen = new Set();
  const dictionaries = catalog.dictionaries.map((rawDictionary, index) => {
    if (!rawDictionary || typeof rawDictionary !== "object") {
      throw backendError("CATALOG_INVALID", "HoshiDicts dictionary is invalid");
    }
    const id = rawDictionary.id;
    const title = rawDictionary.title;
    const displayTitle = rawDictionary.displayTitle ?? title;
    const path = rawDictionary.path;
    const types = rawDictionary.types;
    if (
      typeof id !== "string" ||
      !id ||
      id.length > 128 ||
      seen.has(id) ||
      typeof title !== "string" ||
      !title ||
      title.length > 512 ||
      typeof displayTitle !== "string" ||
      !displayTitle ||
      displayTitle.length > 512 ||
      typeof path !== "string" ||
      !path ||
      path.length > 4096 ||
      !Array.isArray(types) ||
      types.length === 0 ||
      types.length > 4 ||
      types.some(
        (type) =>
          !["term", "frequency", "pitch", "kanji"].includes(type),
      )
    ) {
      throw backendError("CATALOG_INVALID", "HoshiDicts dictionary metadata is invalid");
    }
    seen.add(id);
    return {
      id,
      title,
      displayTitle,
      path,
      types: Array.from(new Set(types)),
      priority: boundedInteger(rawDictionary.priority, index, 0, 63),
    };
  });
  return {
    generation: catalog.generation,
    dictionaries,
  };
}

class HoshiDictsDictionaryBackend extends EventEmitter {
  constructor(options = {}) {
    super();
    if (!options.client || typeof options.client.request !== "function") {
      throw new TypeError("HoshiDictsDictionaryBackend requires a host client");
    }
    if (!options.popup || typeof options.popup.showResults !== "function") {
      throw new TypeError("HoshiDictsDictionaryBackend requires a popup renderer");
    }
    this.id = "hoshidicts";
    this.client = options.client;
    this.popup = options.popup;
    this.miningClient =
      options.miningClient &&
      typeof options.miningClient.refreshReadiness === "function" &&
      typeof options.miningClient.mine === "function"
        ? options.miningClient
        : null;
    this.shouldDismissAfterMine =
      typeof options.shouldDismissAfterMine === "function"
        ? options.shouldDismissAfterMine
        : () => false;
    this.getGeneration =
      typeof options.getGeneration === "function"
        ? options.getGeneration
        : () => 0;
    this.lookupDispatcher =
      typeof options.lookupDispatcher === "function"
        ? options.lookupDispatcher
        : null;
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
      "recursive-back",
    ]);
    this.miningReadiness = Object.freeze({
      ready: false,
      status: "unknown",
      message: "",
      missing: [],
    });
    this.miningRefreshPromise = null;
    this.miningReadinessEpoch = 0;
    this.started = false;
    this.catalog = null;
    this.hostInfo = null;
    this.mediaResolver = null;
    this.openPopupGeneration = null;
    this.lookupSettings = {
      scanLength: 16,
      maxResults: 16,
      recursiveLookupEnabled: true,
    };
    this.onHostExit = (event) => this.#handleHostExit(event);
    this.popup.setMineDispatcher?.((selection) =>
      this.#mineSelection(selection),
    );
    this.popup.setMineSuccessHandler?.(() => {
      if (this.shouldDismissAfterMine()) {
        this.#closePopup("mine-success");
      }
    });
  }

  setGenerationProvider(provider) {
    if (typeof provider === "function") {
      this.getGeneration = provider;
    }
  }

  setLookupDispatcher(dispatcher) {
    this.lookupDispatcher =
      typeof dispatcher === "function" ? dispatcher : null;
    this.popup.setLookupDispatcher?.((intent) => {
      if (!this.lookupDispatcher) {
        return { status: "unsupported" };
      }
      return this.lookupDispatcher(intent);
    });
  }

  async start(context = {}) {
    this.#applyProfileSettings(context);
    if (!this.started) {
      this.hostInfo = await this.client.start?.();
      this.client.on?.("exit", this.onHostExit);
      this.started = true;
      this.miningReadinessEpoch += 1;
    }
    try {
      if (context.catalog) {
        await this.#configureCatalog(context.catalog, context.signal);
      } else if (!this.catalog) {
        throw backendError(
          "CATALOG_NOT_CONFIGURED",
          "HoshiDicts requires an active dictionary catalog",
        );
      }
      this.emit("state", {
        lifecycle: "idle",
        generation: this.getGeneration(),
      });
      void this.refreshMiningReadiness();
      return this.getSnapshot();
    } catch (error) {
      if (!this.catalog) {
        this.miningReadinessEpoch += 1;
        this.started = false;
        this.client.removeListener?.("exit", this.onHostExit);
        await this.client.stop?.().catch?.(() => {});
      }
      throw error;
    }
  }

  async stop(options = {}) {
    this.#closePopup(options.reason || "backend-stop");
    this.client.removeListener?.("exit", this.onHostExit);
    try {
      await this.client.stop?.();
    } finally {
      this.miningReadinessEpoch += 1;
      this.started = false;
      this.catalog = null;
      this.hostInfo = null;
      this.mediaResolver = null;
      this.#setMiningReadiness({
        ready: false,
        status: "inactive",
        message: "Hoshi mining is inactive.",
        missing: [],
      });
    }
  }

  async configure(context = {}) {
    if (!this.started) {
      throw backendError("HOST_NOT_RUNNING", "HoshiDicts host is not running");
    }
    this.#applyProfileSettings(context);
    if (context.catalog) {
      await this.#configureCatalog(context.catalog, context.signal);
    }
    void this.refreshMiningReadiness();
    return this.getSnapshot();
  }

  #setMiningReadiness(readiness = {}) {
    this.miningReadiness = Object.freeze({
      ready: readiness.ready === true,
      status:
        typeof readiness.status === "string" && readiness.status
          ? readiness.status
          : "unknown",
      message: typeof readiness.message === "string" ? readiness.message : "",
      missing: Array.isArray(readiness.missing)
        ? readiness.missing.slice(0, 32)
        : [],
    });
    if (this.miningReadiness.ready) {
      this.capabilities.add("mine");
    } else {
      this.capabilities.delete("mine");
    }
    this.popup.setMiningReadiness?.(this.miningReadiness);
    this.emit("state", {
      lifecycle: this.popup.getSnapshot?.().state || "idle",
      generation: this.getGeneration(),
      miningStatus: this.miningReadiness.status,
    });
    return this.miningReadiness;
  }

  refreshMiningReadiness() {
    if (!this.miningClient) {
      return Promise.resolve(
        this.#setMiningReadiness({
          ready: false,
          status: "unsupported",
          message: "Hoshi mining is unavailable in this build.",
          missing: [],
        }),
      );
    }
    if (this.miningRefreshPromise) {
      return this.miningRefreshPromise;
    }
    const epoch = this.miningReadinessEpoch;
    const refresh = Promise.resolve(
      this.miningClient.refreshReadiness(),
    )
      .then((readiness) =>
        epoch === this.miningReadinessEpoch && this.started
          ? this.#setMiningReadiness(readiness)
          : this.miningReadiness,
      )
      .catch((error) => {
        if (epoch !== this.miningReadinessEpoch || !this.started) {
          return this.miningReadiness;
        }
        return this.#setMiningReadiness({
          ready: false,
          status: "anki-unavailable",
          message:
            typeof error?.message === "string"
              ? error.message
              : "Could not check Hoshi mining readiness.",
          missing: ["AnkiConnect"],
        });
      })
      .finally(() => {
        if (this.miningRefreshPromise === refresh) {
          this.miningRefreshPromise = null;
        }
      });
    this.miningRefreshPromise = refresh;
    return refresh;
  }

  #applyProfileSettings(context = {}) {
    this.lookupSettings = {
      scanLength: boundedInteger(
        context.hoshiScanLength,
        this.lookupSettings.scanLength,
        1,
        64,
      ),
      maxResults: boundedInteger(
        context.hoshiMaxResults,
        this.lookupSettings.maxResults,
        1,
        64,
      ),
      recursiveLookupEnabled:
        context.hoshiRecursiveLookupEnabled === undefined
          ? this.lookupSettings.recursiveLookupEnabled
          : context.hoshiRecursiveLookupEnabled !== false,
    };
    this.popup.setRecursiveLookupEnabled?.(
      this.lookupSettings.recursiveLookupEnabled,
    );
  }

  async #configureCatalog(rawCatalog, signal) {
    const catalog = normalizeCatalog(rawCatalog);
    if (
      this.catalog &&
      this.catalog.generation === catalog.generation &&
      JSON.stringify(this.catalog.dictionaries) ===
        JSON.stringify(catalog.dictionaries)
    ) {
      return;
    }
    this.emit("state", {
      lifecycle: "loading",
      generation: this.getGeneration(),
      reason: "catalog-rebuilding",
    });
    await this.client.request(
      "catalog.configure",
      {
        generation: catalog.generation,
        dictionaries: catalog.dictionaries.map((dictionary) => ({
          id: dictionary.id,
          title: dictionary.title,
          path: dictionary.path,
          types: dictionary.types,
          priority: dictionary.priority,
        })),
      },
      { signal },
    );
    const styles = await this.client.request(
      "styles.list",
      { catalogGeneration: catalog.generation },
      { signal },
    );
    if (
      !styles ||
      styles.catalogGeneration !== catalog.generation ||
      !Array.isArray(styles.styles)
    ) {
      throw backendError(
        "STYLES_RESPONSE_INVALID",
        "HoshiDicts returned invalid dictionary styles",
      );
    }
    this.catalog = catalog;
    this.mediaResolver = new HoshiDictsMediaResolver({
      request: (method, params, options) =>
        this.client.request(method, params, options),
      catalogGeneration: catalog.generation,
      dictionaryIds: catalog.dictionaries.map((dictionary) => dictionary.id),
    });
    this.popup.setMediaResolver?.((dictionaryId, path, options) =>
      this.mediaResolver.resolve(dictionaryId, path, options),
    );
    this.popup.setDictionaryStyles(styles.styles);
  }

  #isStale(request) {
    return (
      request.signal?.aborted === true ||
      request.generation !== this.getGeneration()
    );
  }

  async lookup(request = {}) {
    if (!this.started || !this.catalog) {
      throw backendError("HOST_NOT_RUNNING", "HoshiDicts host is not ready");
    }
    const generation = request.generation;
    if (!Number.isSafeInteger(generation) || generation < 0) {
      throw backendError("INVALID_GENERATION", "Lookup generation is invalid");
    }
    const anchor = request.anchor || {};
    const commonOptions = {
      generation,
      anchor,
      sourceSentence:
        typeof request.sourceSentence === "string"
          ? request.sourceSentence
          : "",
      lineId: typeof request.lineId === "string" ? request.lineId : "",
    };
    void this.refreshMiningReadiness();
    const hasTermDictionary = this.catalog.dictionaries.some((dictionary) =>
      dictionary.types.includes("term"),
    );
    if (!hasTermDictionary) {
      this.popup.showState("no-dictionaries", commonOptions);
      this.#openPopup(generation, "no-enabled-term-dictionaries");
      return { status: "no-dictionaries", count: 0 };
    }
    if (typeof request.text !== "string" || !request.text.trim()) {
      throw backendError("LOOKUP_TEXT_REQUIRED", "HoshiDicts lookup text is required");
    }

    this.popup.showLoading(commonOptions);
    this.#openPopup(generation, "lookup-loading");
    this.emit("state", { lifecycle: "loading", generation });
    try {
      const response = await this.client.request(
        "lookup.term",
        {
          catalogGeneration: this.catalog.generation,
          requestGeneration: generation,
          text: request.text,
          scanLength: boundedInteger(
            request.scanLength,
            this.lookupSettings.scanLength,
            1,
            64,
          ),
          maxResults: boundedInteger(
            request.maxResults,
            this.lookupSettings.maxResults,
            1,
            64,
          ),
        },
        { signal: request.signal },
      );
      if (
        this.#isStale(request) ||
        response?.catalogGeneration !== this.catalog.generation ||
        response?.requestGeneration !== generation
      ) {
        return { status: "stale", generation };
      }
      const model = normalizeTermLookupResult(response, {
        dictionaries: this.catalog.dictionaries,
      });
      if (model.entries.length === 0) {
        this.popup.showState("empty", commonOptions);
        this.#openPopup(generation, "lookup-empty");
        this.emit("state", { lifecycle: "empty", generation });
        return { status: "empty", count: 0, model };
      }
      if (!this.popup.showResults(model, commonOptions)) {
        return { status: "stale", generation };
      }
      this.#openPopup(generation, "lookup-results");
      this.emit("state", { lifecycle: "results", generation });
      return { status: "results", count: model.entries.length, model };
    } catch (error) {
      if (this.#isStale(request)) {
        return { status: "stale", generation };
      }
      const code = errorCode(error, "LOOKUP_FAILED");
      this.popup.showState(
        ["HOST_EXITED", "HOST_NOT_FOUND", "PROTOCOL_MISMATCH"].includes(code)
          ? "host-unavailable"
          : "error",
        { ...commonOptions, errorCode: code },
      );
      this.#openPopup(generation, "lookup-error");
      this.emit("state", {
        lifecycle: "error",
        generation,
        errorCode: code,
      });
      throw error;
    }
  }

  async command(command, params = {}) {
    if (command === "dismiss") {
      this.#closePopup(params.reason || "dismissed");
      return { status: "handled" };
    }
    return await this.popup.command(command, params);
  }

  async #mineSelection(selection) {
    if (
      !this.miningClient ||
      !this.miningReadiness.ready ||
      !selection ||
      selection.generation !== this.getGeneration()
    ) {
      return {
        status: "failed",
        message: "The Hoshi mining selection is no longer available.",
      };
    }
    const result = await this.miningClient.mine(selection);
    if (["invalid-config", "anki-unavailable"].includes(result?.status)) {
      this.#setMiningReadiness({
        ready: false,
        status: result.status,
        message: result.message || "Hoshi mining is unavailable.",
        missing: [],
      });
    }
    return result;
  }

  #openPopup(generation, reason) {
    if (this.openPopupGeneration === generation) {
      return;
    }
    this.openPopupGeneration = generation;
    this.emit("popup-opened", {
      backendId: this.id,
      popupId: "hoshidicts-popup",
      generation,
      reason,
    });
  }

  #closePopup(reason) {
    const generation =
      this.openPopupGeneration === null
        ? this.getGeneration()
        : this.openPopupGeneration;
    this.popup.dismiss(reason);
    if (this.openPopupGeneration !== null) {
      this.emit("popup-closed", {
        backendId: this.id,
        popupId: "hoshidicts-popup",
        generation,
        reason,
      });
    }
    this.openPopupGeneration = null;
  }

  #handleHostExit(event) {
    const generation = this.getGeneration();
    this.miningReadinessEpoch += 1;
    this.started = false;
    this.#setMiningReadiness({
      ready: false,
      status: "host-unavailable",
      message: "Hoshi mining is unavailable because the native host exited.",
      missing: [],
    });
    this.popup.showState("host-unavailable", {
      generation,
      anchor: this.popup.getSnapshot?.().anchor,
      errorCode: "HOST_EXITED",
    });
    this.#openPopup(generation, "host-exited");
    this.emit("state", {
      lifecycle: "error",
      generation,
      errorCode: errorCode(event, "HOST_EXITED"),
    });
  }

  getSnapshot() {
    return {
      id: this.id,
      started: this.started,
      hostInfo: this.hostInfo,
      catalogGeneration: this.catalog?.generation || null,
      dictionaryCount: this.catalog?.dictionaries.length || 0,
      lookupSettings: { ...this.lookupSettings },
      miningReadiness: this.miningReadiness,
      popup: this.popup.getSnapshot?.() || null,
    };
  }
}

module.exports = {
  HoshiDictsDictionaryBackend,
  HoshiDictsDictionaryBackendError,
  normalizeCatalog,
};
