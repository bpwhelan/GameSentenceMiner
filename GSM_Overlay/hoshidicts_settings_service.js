"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const {
  HoshiDictsClient,
  resolveHoshiDictsExecutable,
} = require("./hoshidicts_client.js");
const {
  HoshiDictsImportManager,
} = require("./hoshidicts_import_manager.js");
const { HoshiDictsStore } = require("./hoshidicts_store.js");

const VALID_DICTIONARY_BACKENDS = new Set(["yomitan", "hoshidicts"]);
const MAX_IMPORT_HISTORY = 32;

function normalizeDictionaryBackend(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return VALID_DICTIONARY_BACKENDS.has(normalized) ? normalized : "yomitan";
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(minimum, Math.min(maximum, Math.round(number)));
}

function normalizeDictionaryOrder(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set();
  const normalized = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }
    const id = entry.trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    normalized.push(id);
  }
  return normalized;
}

function normalizeDictionaryEnabled(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const normalized = {};
  for (const [id, enabled] of Object.entries(value)) {
    if (
      typeof enabled === "boolean" &&
      id &&
      id !== "__proto__" &&
      id !== "constructor" &&
      id !== "prototype"
    ) {
      normalized[id] = enabled;
    }
  }
  return normalized;
}

function normalizeHoshiProfileSettings(settings = {}) {
  const source =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? settings
      : {};
  return {
    dictionaryBackend: normalizeDictionaryBackend(source.dictionaryBackend),
    hoshiDictionaryOrder: normalizeDictionaryOrder(source.hoshiDictionaryOrder),
    hoshiDictionaryEnabled: normalizeDictionaryEnabled(
      source.hoshiDictionaryEnabled,
    ),
    hoshiScanLength: boundedInteger(source.hoshiScanLength, 16, 1, 64),
    hoshiMaxResults: boundedInteger(source.hoshiMaxResults, 16, 1, 64),
    hoshiRecursiveLookupEnabled:
      source.hoshiRecursiveLookupEnabled !== false,
    hoshiLowRamImport: source.hoshiLowRamImport !== false,
  };
}

function removeDictionaryFromSettings(settings, dictionaryId) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return false;
  }
  let changed = false;
  const order = normalizeDictionaryOrder(settings.hoshiDictionaryOrder);
  const nextOrder = order.filter((id) => id !== dictionaryId);
  if (
    nextOrder.length !== order.length ||
    !Array.isArray(settings.hoshiDictionaryOrder)
  ) {
    settings.hoshiDictionaryOrder = nextOrder;
    changed = true;
  }

  const enabled = normalizeDictionaryEnabled(settings.hoshiDictionaryEnabled);
  if (Object.prototype.hasOwnProperty.call(enabled, dictionaryId)) {
    delete enabled[dictionaryId];
    changed = true;
  }
  if (
    changed ||
    !settings.hoshiDictionaryEnabled ||
    typeof settings.hoshiDictionaryEnabled !== "object" ||
    Array.isArray(settings.hoshiDictionaryEnabled)
  ) {
    settings.hoshiDictionaryEnabled = enabled;
  }
  return changed;
}

function findHoshiDictionaryReferences(settings, dictionaryId) {
  const references = [];
  const containsReference = (candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return false;
    }
    return (
      normalizeDictionaryOrder(candidate.hoshiDictionaryOrder).includes(
        dictionaryId,
      ) ||
      Object.prototype.hasOwnProperty.call(
        normalizeDictionaryEnabled(candidate.hoshiDictionaryEnabled),
        dictionaryId,
      )
    );
  };

  if (containsReference(settings)) {
    references.push("Current settings");
  }
  const profiles = settings?.overlayProfileSettings;
  if (profiles && typeof profiles === "object" && !Array.isArray(profiles)) {
    for (const [profileName, profileSettings] of Object.entries(profiles)) {
      if (containsReference(profileSettings)) {
        references.push(String(profileName));
      }
    }
  }
  return references;
}

function removeHoshiDictionaryReferences(settings, dictionaryId) {
  removeDictionaryFromSettings(settings, dictionaryId);
  const changedProfiles = [];
  const profiles = settings?.overlayProfileSettings;
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) {
    return changedProfiles;
  }
  for (const [profileName, profileSettings] of Object.entries(profiles)) {
    if (removeDictionaryFromSettings(profileSettings, dictionaryId)) {
      changedProfiles.push(profileName);
    }
  }
  return changedProfiles;
}

function stableError(error, fallback = "HOSHIDICTS_ERROR") {
  return {
    code:
      typeof error?.code === "string" && error.code
        ? error.code
        : fallback,
    message:
      typeof error?.message === "string" && error.message
        ? error.message
        : "HoshiDicts operation failed",
  };
}

class HoshiDictsSettingsService extends EventEmitter {
  constructor(options = {}) {
    super();
    if (!options.dataPath) {
      throw new TypeError("HoshiDictsSettingsService requires a data path");
    }
    this.dataPath = path.resolve(options.dataPath);
    this.clientVersion = options.clientVersion || "unknown";
    this.store = options.store || new HoshiDictsStore(this.dataPath);
    this.resolveExecutable =
      options.resolveExecutable ||
      (() =>
        resolveHoshiDictsExecutable({
          resourcesPath: options.resourcesPath,
        }));
    this.createClient =
      options.createClient ||
      ((clientOptions = {}) =>
        new HoshiDictsClient({
          clientVersion: this.clientVersion,
          ...clientOptions,
        }));
    this.storeExists =
      options.storeExists ||
      (() => fs.existsSync(this.store.rootPath));
    this.importManager =
      options.importManager ||
      new HoshiDictsImportManager({
        store: this.store,
        clientVersion: this.clientVersion,
        createClient: () =>
          this.createClient({
            executablePath: this.#resolveExecutable(),
          }),
      });
    this.initialized = false;
    this.initializePromise = null;
    this.hostMetadata = null;
    this.hostError = null;
    this.reindexRequired = [];
    this.catalogGeneration = 0;
    this.catalogSignature = null;
    this.imports = new Map();
    this.importSequence = 0;

    this.importManager.on?.("progress", (event) => {
      this.#recordImportProgress(event);
    });
    this.importManager.on?.("failed", (event) => {
      const current = this.imports.get(String(event?.jobId || "")) || {};
      this.#recordImportProgress({
        ...current,
        ...event,
        phase: "failed",
        status: "failed",
      });
    });
  }

  #resolveExecutable() {
    return this.resolveExecutable();
  }

  async #initializeStore() {
    if (this.initialized) {
      return;
    }
    if (!this.initializePromise) {
      this.initializePromise = Promise.resolve(
        this.store.initialize({
          activeJobIds: this.importManager
            .getActiveImports()
            .map((entry) => entry.jobId),
        }),
      )
        .then(() => {
          this.initialized = true;
        })
        .finally(() => {
          this.initializePromise = null;
        });
    }
    await this.initializePromise;
  }

  #inspectHostAvailability() {
    try {
      return {
        available: true,
        status: this.hostError
          ? "error"
          : this.hostMetadata
            ? "ready"
            : "stopped",
        errorCode: this.hostError?.code || null,
        hostVersion: this.hostMetadata?.hostVersion || null,
        hoshidictsCommit: this.hostMetadata?.hoshidictsCommit || null,
        capabilities: this.hostMetadata?.capabilities || [],
      };
    } catch {
      return {
        available: false,
        status: "unavailable",
        errorCode: "HOST_NOT_FOUND",
        hostVersion: null,
        hoshidictsCommit: null,
        capabilities: [],
      };
    }
  }

  #hostState() {
    try {
      this.#resolveExecutable();
      return this.#inspectHostAvailability();
    } catch (error) {
      const failure = stableError(error, "HOST_NOT_FOUND");
      return {
        available: false,
        status: "unavailable",
        errorCode: failure.code,
        hostVersion: null,
        hoshidictsCommit: null,
        capabilities: [],
      };
    }
  }

  async #getHostMetadata() {
    if (this.hostMetadata) {
      return this.hostMetadata;
    }
    const executablePath = this.#resolveExecutable();
    const client = this.createClient({ executablePath });
    try {
      this.hostMetadata = await client.start();
      this.hostError = null;
      return this.hostMetadata;
    } catch (error) {
      this.hostError = stableError(error, "HOST_START_FAILED");
      throw error;
    } finally {
      await client.shutdown?.();
    }
  }

  #recordImportProgress(event = {}) {
    const jobId = String(event.jobId || "");
    if (!jobId) {
      return;
    }
    const current = this.imports.get(jobId) || {};
    const details =
      event.details && typeof event.details === "object"
        ? event.details
        : {};
    const next = {
      ...current,
      jobId,
      phase: event.phase || current.phase || "created",
      completed:
        event.completed === undefined
          ? current.completed ?? null
          : event.completed,
      total:
        event.total === undefined ? current.total ?? null : event.total,
      status:
        event.status ||
        details.status ||
        current.status ||
        (event.phase === "cancelled" ? "cancelled" : "running"),
      code: event.code || current.code || null,
      sequence: ++this.importSequence,
    };
    this.imports.delete(jobId);
    this.imports.set(jobId, next);
    while (this.imports.size > MAX_IMPORT_HISTORY) {
      this.imports.delete(this.imports.keys().next().value);
    }
    this.emit("state-changed", { reason: "import-progress", jobId });
  }

  #importsSnapshot() {
    const snapshots = new Map(
      [...this.imports.entries()].map(([jobId, entry]) => [
        jobId,
        { ...entry },
      ]),
    );
    for (const active of this.importManager.getActiveImports()) {
      const jobId = String(active.jobId || "");
      if (!jobId) {
        continue;
      }
      snapshots.set(jobId, {
        ...(snapshots.get(jobId) || {}),
        ...active,
        jobId,
        status: active.cancelled ? "cancelled" : "running",
      });
    }
    return [...snapshots.values()]
      .sort((left, right) => (right.sequence || 0) - (left.sequence || 0))
      .map(({ sequence: _sequence, ...entry }) => entry);
  }

  async getState(settings = {}, options = {}) {
    const normalizedSettings = normalizeHoshiProfileSettings(settings);
    const shouldInitialize =
      options.initializeStore === true || this.storeExists();
    let dictionaries = [];
    let storage = { activeBytes: 0, dictionaryCount: 0 };
    let storeError = null;

    if (shouldInitialize) {
      try {
        await this.#initializeStore();
        [dictionaries, storage] = await Promise.all([
          this.store.listDictionaries(),
          this.store.getStorageUsage(),
        ]);
      } catch (error) {
        storeError = stableError(error, "STORE_UNAVAILABLE");
      }
    }

    return {
      settings: normalizedSettings,
      host: this.#hostState(),
      store: {
        initialized: this.initialized,
        available: storeError === null,
        errorCode: storeError?.code || null,
      },
      dictionaries,
      storage,
      imports: this.#importsSnapshot(),
      reindexRequired: [...this.reindexRequired],
    };
  }

  async buildRuntime(settings = {}) {
    const normalizedSettings = normalizeHoshiProfileSettings(settings);
    await this.#initializeStore();
    const host = await this.#getHostMetadata();
    const catalog = await this.store.buildCatalog({
      order: normalizedSettings.hoshiDictionaryOrder,
      enabled: normalizedSettings.hoshiDictionaryEnabled,
      hostVersion: host.hostVersion,
      hoshidictsCommit: host.hoshidictsCommit,
    });
    const catalogSignature = JSON.stringify({
      manifestRevision: catalog.manifestRevision,
      dictionaries: catalog.dictionaries,
    });
    if (catalogSignature !== this.catalogSignature) {
      this.catalogGeneration = Math.max(
        this.catalogGeneration + 1,
        Number(catalog.manifestRevision) + 1 || 1,
      );
      this.catalogSignature = catalogSignature;
    }
    this.reindexRequired = [...catalog.reindexRequired];
    return {
      host: {
        available: true,
        status: "ready",
        hostVersion: host.hostVersion,
        hoshidictsCommit: host.hoshidictsCommit,
        capabilities: [...host.capabilities],
      },
      catalog: {
        generation: this.catalogGeneration,
        dictionaries: catalog.dictionaries,
      },
      reindexRequired: catalog.reindexRequired,
      settings: normalizedSettings,
    };
  }

  async importDictionary(sourcePath, options = {}) {
    await this.#initializeStore();
    const sequenceBefore = this.importSequence;
    try {
      const result = await this.importManager.importDictionary(sourcePath, {
        ...options,
        lowRam: options.lowRam !== false,
      });
      const pending = [...this.imports.values()]
        .filter(
          (entry) =>
            entry.sequence > sequenceBefore &&
            !["complete", "failed", "cancelled"].includes(entry.phase),
        )
        .sort((left, right) => right.sequence - left.sequence)[0];
      if (pending) {
        this.#recordImportProgress({
          jobId: pending.jobId,
          phase: "complete",
          completed: 1,
          total: 1,
          status: result.status || "imported",
        });
      }
      this.emit("state-changed", { reason: "import-complete" });
      return result;
    } catch (error) {
      if (error?.jobId) {
        this.#recordImportProgress({
          jobId: error.jobId,
          phase: error.code === "IMPORT_CANCELLED" ? "cancelled" : "failed",
          status: error.code === "IMPORT_CANCELLED" ? "cancelled" : "failed",
          code: error.code || "IMPORT_FAILED",
        });
      }
      throw error;
    }
  }

  async reimportDictionary(dictionaryId, sourcePath, options = {}) {
    return await this.importDictionary(sourcePath, {
      ...options,
      dictionaryId,
    });
  }

  cancelImport(jobId) {
    const cancelled = this.importManager.cancel(jobId);
    if (cancelled) {
      this.#recordImportProgress({
        jobId,
        phase: "cancelled",
        status: "cancelled",
      });
    }
    return cancelled;
  }

  async removeDictionary(dictionaryId) {
    await this.#initializeStore();
    const result = await this.store.removeDictionary(dictionaryId);
    this.emit("state-changed", {
      reason: "dictionary-removed",
      dictionaryId,
    });
    return result;
  }
}

module.exports = {
  HoshiDictsSettingsService,
  findHoshiDictionaryReferences,
  normalizeDictionaryBackend,
  normalizeHoshiProfileSettings,
  removeHoshiDictionaryReferences,
};
