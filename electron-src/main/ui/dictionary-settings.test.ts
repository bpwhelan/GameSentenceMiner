import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

const MAIN_PATH = path.resolve(process.cwd(), "GSM_Overlay/main.js");
const mainSource = fs.readFileSync(MAIN_PATH, "utf8");

function sourceBetween(source: string, startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) {
    throw new Error(`Unable to find source block: ${startMarker}`);
  }
  return source.slice(start, end);
}

function loadProfileSnapshotHelpers() {
  const cloneSource = sourceBetween(
    mainSource,
    "function cloneOverlaySettingValue",
    "\nfunction seedOverlayProfileSettings",
  );
  const module = { exports: {} as any };
  const context = { module, JSON, Object, Array };

  vm.runInNewContext(
    `
      const DEFAULT_USER_SETTINGS = {
        focusOverlayOnYomitanLookup: false,
        dictionaryBackend: "yomitan",
        hoshiDictionaryOrder: [],
        hoshiDictionaryEnabled: {},
        gamepadTokenizerBackend: "sudachi",
        nestedDisplayPreference: { enabled: true },
        weburl1: "ws://127.0.0.1",
      };
      const OVERLAY_NON_PROFILE_SETTING_KEYS = new Set(["weburl1"]);
      const userSettings = { ...DEFAULT_USER_SETTINGS };
      ${cloneSource}
      module.exports = {
        isOverlayProfileScopedSetting,
        buildOverlayProfileSnapshot,
      };
    `,
    context,
    { filename: "GSM_Overlay/main.js#overlay-profile-snapshot" },
  );

  return module.exports as {
    isOverlayProfileScopedSetting: (key: string) => boolean;
    buildOverlayProfileSnapshot: (settings?: Record<string, unknown>) => Record<string, unknown>;
  };
}

function loadTokenizerNormalizer() {
  const normalizerSource = sourceBetween(
    mainSource,
    "function normalizeGamepadTokenizerBackend",
    "\nfunction normalizeLocalTokenizerFallbackBackend",
  );
  const module = { exports: {} as any };

  vm.runInNewContext(
    `
      const VALID_GAMEPAD_TOKENIZER_BACKENDS = new Set([
        "mecab",
        "sudachi",
        "yomitan-bridge",
        "yomitan-api",
        "jiten-api",
        "jpdb-api",
      ]);
      ${normalizerSource}
      module.exports = { normalizeGamepadTokenizerBackend };
    `,
    { module },
    { filename: "GSM_Overlay/main.js#tokenizer-normalizer" },
  );

  return module.exports.normalizeGamepadTokenizerBackend as (value: unknown) => string;
}

function loadHoshiCommitHelpers() {
  const commitSource = sourceBetween(
    mainSource,
    "async function commitHoshiProfileSettings",
    "\nfunction reconcileConfiguredDictionaryBackend",
  );
  const module = { exports: {} as any };

  vm.runInNewContext(
    `
      const events = [];
      const userSettings = {
        dictionaryBackend: "yomitan",
        hoshiDictionaryOrder: [],
        hoshiDictionaryEnabled: {},
        hoshiScanLength: 16,
        hoshiMaxResults: 16,
        hoshiRecursiveLookupEnabled: true,
        hoshiLowRamImport: true,
      };
      let hoshiLastOperationError = null;
      let failingBackend = null;
      let failRollback = false;

      function normalizeHoshiProfileSettings(settings = {}) {
        return {
          dictionaryBackend:
            settings.dictionaryBackend === "hoshidicts"
              ? "hoshidicts"
              : "yomitan",
          hoshiDictionaryOrder: Array.isArray(settings.hoshiDictionaryOrder)
            ? [...settings.hoshiDictionaryOrder]
            : [],
          hoshiDictionaryEnabled:
            settings.hoshiDictionaryEnabled &&
            typeof settings.hoshiDictionaryEnabled === "object"
              ? { ...settings.hoshiDictionaryEnabled }
              : {},
          hoshiScanLength: Number(settings.hoshiScanLength) || 16,
          hoshiMaxResults: Number(settings.hoshiMaxResults) || 16,
          hoshiRecursiveLookupEnabled:
            settings.hoshiRecursiveLookupEnabled !== false,
          hoshiLowRamImport: settings.hoshiLowRamImport !== false,
        };
      }
      function serializeDictionaryBackendTransition(operation) {
        return Promise.resolve().then(operation);
      }
      async function transitionDictionaryBackend(settings, reason) {
        events.push({
          type: "transition",
          backend: settings.dictionaryBackend,
          reason,
        });
        const isRollback = String(reason).endsWith(":rollback");
        if (
          (isRollback && failRollback) ||
          (!isRollback && settings.dictionaryBackend === failingBackend)
        ) {
          const error = new Error(
            isRollback ? "Rollback failed" : "Renderer rejected transition",
          );
          error.code = isRollback
            ? "BACKEND_ROLLBACK_FAILED"
            : "BACKEND_SWITCH_REJECTED";
          throw error;
        }
      }
      function applyCommittedHoshiSettings(settings) {
        const normalized = normalizeHoshiProfileSettings(settings);
        Object.assign(userSettings, normalized);
        events.push({
          type: "commit",
          backend: normalized.dictionaryBackend,
        });
        return normalized;
      }
      function normalizeHoshiError(error, fallback) {
        return {
          code: error && error.code ? error.code : fallback,
          message: error && error.message ? error.message : "failed",
        };
      }
      function saveSettings() {
        events.push({ type: "save" });
      }
      function publishOverlaySettingsSnapshot(reason) {
        events.push({ type: "publish", reason });
      }
      async function publishHoshiSettingsState() {
        events.push({ type: "state" });
        return { settings: normalizeHoshiProfileSettings(userSettings) };
      }
      function scheduleHoshiSettingsStatePublish() {
        events.push({ type: "schedule-state" });
      }

      ${commitSource}

      module.exports = {
        commitHoshiProfileSettings,
        events,
        userSettings,
        getLastError: () => hoshiLastOperationError,
        setFailingBackend: (backend) => {
          failingBackend = backend;
        },
        setFailRollback: (value) => {
          failRollback = value === true;
        },
      };
    `,
    { module, Error, Object, Array, Number, String, Promise },
    { filename: "GSM_Overlay/main.js#hoshidicts-commit" },
  );

  return module.exports as {
    commitHoshiProfileSettings: (
      patch: Record<string, unknown>,
      reason?: string,
    ) => Promise<any>;
    events: Array<Record<string, unknown>>;
    userSettings: Record<string, unknown>;
    getLastError: () => { code: string; message: string } | null;
    setFailingBackend: (backend: string | null) => void;
    setFailRollback: (value: boolean) => void;
  };
}

describe("current dictionary-adjacent settings behavior", () => {
  it("keeps popup focus opt-in and the tokenizer default on Sudachi", () => {
    expect(mainSource).toMatch(/"focusOverlayOnYomitanLookup": false/);
    expect(mainSource).toMatch(/"gamepadTokenizerBackend": "sudachi"/);
  });

  it("profile snapshots include interaction and tokenizer settings but not global transport", () => {
    const helpers = loadProfileSnapshotHelpers();
    const snapshot = helpers.buildOverlayProfileSnapshot({
      focusOverlayOnYomitanLookup: true,
      dictionaryBackend: "hoshidicts",
      hoshiDictionaryOrder: ["terms"],
      hoshiDictionaryEnabled: { terms: true },
      gamepadTokenizerBackend: "yomitan-bridge",
      nestedDisplayPreference: { enabled: false },
      weburl1: "ws://example.invalid",
    });

    expect(snapshot).toEqual({
      focusOverlayOnYomitanLookup: true,
      dictionaryBackend: "hoshidicts",
      hoshiDictionaryOrder: ["terms"],
      hoshiDictionaryEnabled: { terms: true },
      gamepadTokenizerBackend: "yomitan-bridge",
      nestedDisplayPreference: { enabled: false },
    });
    expect(helpers.isOverlayProfileScopedSetting("weburl1")).toBe(false);
  });

  it("falls back unknown tokenizer values without coupling popup behavior", () => {
    const normalize = loadTokenizerNormalizer();

    expect(normalize("yomitan-bridge")).toBe("yomitan-bridge");
    expect(normalize("unknown-backend")).toBe("sudachi");
    expect(normalize(null)).toBe("sudachi");
  });

  it("keeps Yomitan as the popup backend default independently of tokenization", () => {
    expect(mainSource).toMatch(/"dictionaryBackend": "yomitan"/);
    expect(mainSource).toMatch(/"hoshiDictionaryOrder": \[\]/);
    expect(mainSource).toMatch(/"hoshiDictionaryEnabled": \{\}/);
    expect(mainSource).toMatch(/"gamepadTokenizerBackend": "sudachi"/);
  });

  it("persists Hoshi settings only after the renderer validates the transition", async () => {
    const helpers = loadHoshiCommitHelpers();

    const result = await helpers.commitHoshiProfileSettings(
      {
        dictionaryBackend: "hoshidicts",
        hoshiDictionaryOrder: ["terms"],
        hoshiDictionaryEnabled: { terms: true },
      },
      "test",
    );

    expect(result.ok).toBe(true);
    expect(helpers.userSettings.dictionaryBackend).toBe("hoshidicts");
    expect(helpers.events.map((event) => event.type)).toEqual([
      "transition",
      "commit",
      "save",
      "publish",
      "state",
    ]);
  });

  it("re-activates the committed backend when a transition fails", async () => {
    const helpers = loadHoshiCommitHelpers();
    helpers.setFailingBackend("hoshidicts");

    const result = await helpers.commitHoshiProfileSettings(
      { dictionaryBackend: "hoshidicts" },
      "test",
    );

    expect(result).toMatchObject({
      ok: false,
      backend: "yomitan",
      error: { code: "BACKEND_SWITCH_REJECTED" },
    });
    expect(helpers.userSettings.dictionaryBackend).toBe("yomitan");
    expect(
      helpers.events
        .filter((event) => event.type === "transition")
        .map((event) => [event.backend, event.reason]),
    ).toEqual([
      ["hoshidicts", "test"],
      ["yomitan", "test:rollback"],
    ]);
    expect(
      helpers.events.some((event) => event.type === "save"),
    ).toBe(false);
  });

  it("surfaces an explicit rollback error when the prior backend cannot restart", async () => {
    const helpers = loadHoshiCommitHelpers();
    helpers.setFailingBackend("hoshidicts");
    helpers.setFailRollback(true);

    const result = await helpers.commitHoshiProfileSettings(
      { dictionaryBackend: "hoshidicts" },
      "test",
    );

    expect(result.error).toEqual({
      code: "BACKEND_ROLLBACK_FAILED",
      message: "Rollback failed",
    });
    expect(helpers.getLastError()).toEqual(result.error);
    expect(helpers.userSettings.dictionaryBackend).toBe("yomitan");
  });
});
