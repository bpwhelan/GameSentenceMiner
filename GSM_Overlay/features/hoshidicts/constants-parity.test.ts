import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

import {
  createDefaultHoshidictsReaderPreferences,
  HOSHIDICTS_ACTIVATION_KEYS,
  HOSHIDICTS_AUDIO_SOURCE_TYPES,
  HOSHIDICTS_THEMES,
  MAX_HOSHIDICTS_COMPACT_DEFINITION_SUMMARY_COUNT,
  MAX_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD,
  MAX_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS,
  MAX_HOSHIDICTS_MAX_RESULTS,
  MAX_HOSHIDICTS_POPUP_COLUMNS,
  MAX_HOSHIDICTS_POPUP_HEIGHT_PX,
  MAX_HOSHIDICTS_POPUP_HIDE_DELAY_MS,
  MAX_HOSHIDICTS_POPUP_OPACITY_PERCENT,
  MAX_HOSHIDICTS_POPUP_WIDTH_PX,
  MAX_HOSHIDICTS_SCAN_LENGTH,
  MIN_HOSHIDICTS_COMPACT_DEFINITION_SUMMARY_COUNT,
  MIN_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD,
  MIN_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS,
  MIN_HOSHIDICTS_MAX_RESULTS,
  MIN_HOSHIDICTS_POPUP_COLUMNS,
  MIN_HOSHIDICTS_POPUP_HEIGHT_PX,
  MIN_HOSHIDICTS_POPUP_OPACITY_PERCENT,
  MIN_HOSHIDICTS_POPUP_WIDTH_PX,
  MIN_HOSHIDICTS_SCAN_LENGTH,
} from "../../../electron-src/shared/features/hoshidicts";

const require = createRequire(import.meta.url);
const constants = require("./constants.js") as {
  AUDIO_SOURCE_TYPES: readonly string[];
  BOUNDS: Record<string, { min: number; max: number }>;
  NAMED_ACTIVATION_KEYS: Map<string, string>;
  PUNCTUATION_ACTIVATION_KEYS: Set<string>;
  READER_DEFAULTS: Record<string, unknown>;
  THEMES: readonly string[];
};

/**
 * constants.js deliberately keeps its own copy of the reader spec so the overlay
 * can run from environment variables alone, with no import of GSM's settings
 * types. That independence is only safe while the two copies agree, and nothing
 * else compares them.
 */
describe("overlay constants parity with the shared reader spec", () => {
  it("uses the same inclusive bounds", () => {
    expect(constants.BOUNDS).toMatchObject({
      scanLength: {
        min: MIN_HOSHIDICTS_SCAN_LENGTH,
        max: MAX_HOSHIDICTS_SCAN_LENGTH,
      },
      maxResults: {
        min: MIN_HOSHIDICTS_MAX_RESULTS,
        max: MAX_HOSHIDICTS_MAX_RESULTS,
      },
      compactDefinitionSummaryCount: {
        min: MIN_HOSHIDICTS_COMPACT_DEFINITION_SUMMARY_COUNT,
        max: MAX_HOSHIDICTS_COMPACT_DEFINITION_SUMMARY_COUNT,
      },
      popupHideDelayMs: { min: 0, max: MAX_HOSHIDICTS_POPUP_HIDE_DELAY_MS },
      popupWidthPx: {
        min: MIN_HOSHIDICTS_POPUP_WIDTH_PX,
        max: MAX_HOSHIDICTS_POPUP_WIDTH_PX,
      },
      popupHeightPx: {
        min: MIN_HOSHIDICTS_POPUP_HEIGHT_PX,
        max: MAX_HOSHIDICTS_POPUP_HEIGHT_PX,
      },
      popupColumns: {
        min: MIN_HOSHIDICTS_POPUP_COLUMNS,
        max: MAX_HOSHIDICTS_POPUP_COLUMNS,
      },
      popupOpacityPercent: {
        min: MIN_HOSHIDICTS_POPUP_OPACITY_PERCENT,
        max: MAX_HOSHIDICTS_POPUP_OPACITY_PERCENT,
      },
      definitionBlurLookupThreshold: {
        min: MIN_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD,
        max: MAX_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD,
      },
      definitionBlurRevealDelayMs: {
        min: MIN_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS,
        max: MAX_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS,
      },
    });
  });

  it("defaults every stored reader preference to the shared value", () => {
    const shared = createDefaultHoshidictsReaderPreferences() as Record<
      string,
      unknown
    >;
    const overlayDefaults = Object.fromEntries(
      Object.keys(shared).map((key) => [key, constants.READER_DEFAULTS[key]])
    );

    expect(overlayDefaults).toStrictEqual(shared);
  });

  it("only adds the derived dictionary context to those defaults", () => {
    const extraKeys = Object.keys(constants.READER_DEFAULTS).filter(
      (key) => !(key in createDefaultHoshidictsReaderPreferences())
    );

    expect(extraKeys.sort()).toStrictEqual([
      "dictionaryPresentation",
      "dictionaryTabGroups",
      "frequencyDictionaries",
    ]);
  });

  it("offers the same themes and audio source types", () => {
    expect([...constants.THEMES].sort()).toStrictEqual(
      [...HOSHIDICTS_THEMES].sort()
    );
    expect([...constants.AUDIO_SOURCE_TYPES].sort()).toStrictEqual(
      [...HOSHIDICTS_AUDIO_SOURCE_TYPES].sort()
    );
  });

  it("accepts the same activation keys", () => {
    const overlayKeys = new Set([
      ...constants.NAMED_ACTIVATION_KEYS.values(),
      ...constants.PUNCTUATION_ACTIVATION_KEYS,
      // Letters and digits are matched by shape rather than enumerated.
      ...HOSHIDICTS_ACTIVATION_KEYS.filter((key) => /^[0-9A-Z]$/u.test(key)),
      // Function keys are likewise derived from the "F<number>" shape.
      ...HOSHIDICTS_ACTIVATION_KEYS.filter((key) => /^F\d+$/u.test(key)),
    ]);

    expect([...overlayKeys].sort()).toStrictEqual(
      [...HOSHIDICTS_ACTIVATION_KEYS].sort()
    );
  });
});
