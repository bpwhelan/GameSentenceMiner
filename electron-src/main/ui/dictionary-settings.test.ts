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

describe("current dictionary-adjacent settings behavior", () => {
  it("keeps popup focus opt-in and the tokenizer default on Sudachi", () => {
    expect(mainSource).toMatch(/"focusOverlayOnYomitanLookup": false/);
    expect(mainSource).toMatch(/"gamepadTokenizerBackend": "sudachi"/);
  });

  it("profile snapshots include interaction and tokenizer settings but not global transport", () => {
    const helpers = loadProfileSnapshotHelpers();
    const snapshot = helpers.buildOverlayProfileSnapshot({
      focusOverlayOnYomitanLookup: true,
      gamepadTokenizerBackend: "yomitan-bridge",
      nestedDisplayPreference: { enabled: false },
      weburl1: "ws://example.invalid",
    });

    expect(snapshot).toEqual({
      focusOverlayOnYomitanLookup: true,
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
});
