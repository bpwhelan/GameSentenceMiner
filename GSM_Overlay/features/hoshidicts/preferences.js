/*
 * Hoshidicts overlay reader-preference normalisation.
 *
 * One schema for the whole overlay: the desktop bridge validates whatever the
 * GSM app sends, and bootstrap.js hands the reader a single already-normalised
 * object instead of re-validating every field again in the renderer.
 *
 * This is intentionally separate from the Electron TypeScript normaliser: the
 * overlay must be able to run from environment variables alone.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

(function (root, factory) {
  const constants = (root && root.GSMHoshidictsConstants) ||
    (typeof require === "function" ? require("./constants") : null);
  const api = factory(constants);
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.GSMHoshidictsPreferences = api;
  }
}(typeof window !== "undefined" ? window : globalThis, function (constants) {
  "use strict";

  if (!constants || !constants.READER_DEFAULTS) {
    throw new Error("Hoshidicts constants must load before preferences.");
  }

  const {
    BOUNDS,
    DEFAULT_ACTIVATION_KEY,
    DEFINITION_BLUR_REVEAL_MODES,
    FREQUENCY_MODES,
    FREQUENCY_SORT_ORDERS,
    LIMITS,
    LOOKUP_MODES,
    NAMED_ACTIVATION_KEYS,
    POPUP_TOOLBAR_POSITIONS,
    PUNCTUATION_ACTIVATION_KEYS,
    READER_DEFAULTS,
    THEME_SET,
  } = constants;

  const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

  function isPlainObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function boundedTitle(value, maxLength = LIMITS.dictionaryTitleLength) {
    return typeof value === "string" && value.trim() && value.length <= maxLength;
  }

  function boundedInteger(value, bound) {
    return Number.isInteger(value) && value >= bound.min && value <= bound.max;
  }

  /**
   * Field validators keyed by preference name. `optional` fields fall back to
   * the shared default when the sender omits them; everything else must be
   * present and valid.
   */
  const FIELD_SPECS = {
    lookupMode: { check: (value) => LOOKUP_MODES.includes(value) },
    scanLength: { optional: true, check: (value) => boundedInteger(value, BOUNDS.scanLength) },
    maxResults: { optional: true, check: (value) => boundedInteger(value, BOUNDS.maxResults) },
    sortFrequencyDictionary: {
      optional: true,
      check: (value) => value === null || boundedTitle(value)
    },
    sortFrequencyDictionaryOrder: {
      optional: true,
      check: (value) => FREQUENCY_SORT_ORDERS.includes(value)
    },
    averageFrequency: { optional: true, check: isBoolean },
    showFrequencyDictionaryNames: { optional: true, check: isBoolean },
    activationKey: {
      optional: true,
      normalize: (value) => normalizeActivationKey(value, null),
      check: (value) => typeof value === "string"
    },
    sourceHighlightEnabled: { check: isBoolean },
    onlyScanJapaneseText: { optional: true, check: isBoolean },
    popupHideDelayMs: { check: (value) => boundedInteger(value, BOUNDS.popupHideDelayMs) },
    showLookupCounts: { check: isBoolean },
    showCompactDefinitionSummary: { check: isBoolean },
    compactDefinitionSummaryCount: {
      optional: true,
      check: (value) => boundedInteger(value, BOUNDS.compactDefinitionSummaryCount)
    },
    compactDefinitionSummaryDictionary: {
      check: (value) => value === null || boundedTitle(value)
    },
    showPitchAccentFurigana: { check: isBoolean },
    pitchAccentFuriganaDictionary: {
      check: (value) => value === null || boundedTitle(value)
    },
    showPitchAccentBadge: { check: isBoolean },
    hidePopupGrammarTags: { check: isBoolean },
    definitionBlur: { normalize: normalizeDefinitionBlur, check: isPlainObject },
    popupNestingMaxDepth: {
      check: (value) => Number.isSafeInteger(value) && value >= 0
    },
    popupWidthPx: { check: (value) => boundedInteger(value, BOUNDS.popupWidthPx) },
    popupHeightPx: { check: (value) => boundedInteger(value, BOUNDS.popupHeightPx) },
    popupColumns: {
      optional: true,
      check: (value) => boundedInteger(value, BOUNDS.popupColumns)
    },
    popupOpacityPercent: {
      check: (value) => boundedInteger(value, BOUNDS.popupOpacityPercent)
    },
    popupBackdropBlurPx: {
      optional: true,
      check: (value) => boundedInteger(value, BOUNDS.popupBackdropBlurPx)
    },
    popupToolbarPosition: {
      check: (value) => POPUP_TOOLBAR_POSITIONS.includes(value)
    },
    theme: { check: (value) => THEME_SET.has(value) },
    customPopupCss: {
      optional: true,
      check: (value) =>
        typeof value === "string" && value.length <= LIMITS.customPopupCssLength
    },
    dictionaryPresentation: {
      optional: true,
      normalize: normalizeDictionaryPresentation,
      check: Array.isArray
    },
    frequencyDictionaries: {
      optional: true,
      normalize: normalizeFrequencyDictionaries,
      check: Array.isArray
    },
    dictionaryTabGroups: {
      optional: true,
      normalize: normalizeDictionaryTabGroups,
      check: Array.isArray
    },
    popupButtons: {
      optional: true,
      normalize: (value) => normalizePopupButtons(value),
      check: isPlainObject
    }
  };

  function isBoolean(value) {
    return typeof value === "boolean";
  }

  function normalizeActivationKey(value, fallback = DEFAULT_ACTIVATION_KEY) {
    if (typeof value !== "string") {
      return fallback;
    }
    const key = value.trim();
    if (PUNCTUATION_ACTIVATION_KEYS.has(key)) {
      return key;
    }
    if (/^[a-z]$/iu.test(key)) {
      return key.toUpperCase();
    }
    if (/^[0-9]$/u.test(key)) {
      return key;
    }
    const functionKey = /^f([1-9]|1[0-9]|2[0-4])$/iu.exec(key);
    if (functionKey) {
      return `F${functionKey[1]}`;
    }
    return NAMED_ACTIVATION_KEYS.get(key.toLowerCase()) ?? fallback;
  }

  function normalizeDefinitionBlur(value) {
    if (
      !isPlainObject(value) ||
      typeof value.enabled !== "boolean" ||
      !boundedInteger(value.lookupThreshold, BOUNDS.definitionBlurLookupThreshold) ||
      !DEFINITION_BLUR_REVEAL_MODES.includes(value.revealMode) ||
      !boundedInteger(value.revealDelayMs, BOUNDS.definitionBlurRevealDelayMs)
    ) {
      return null;
    }
    return {
      enabled: value.enabled,
      lookupThreshold: value.lookupThreshold,
      revealMode: value.revealMode,
      revealDelayMs: value.revealDelayMs
    };
  }

  function normalizeDictionaryPresentation(value) {
    if (value === undefined) {
      return [];
    }
    if (!Array.isArray(value) || value.length > LIMITS.dictionaryPresentation) {
      return null;
    }
    const titles = new Set();
    const normalized = [];
    for (const entry of value) {
      if (
        !isPlainObject(entry) ||
        !boundedTitle(entry.title) ||
        titles.has(entry.title) ||
        typeof entry.favorite !== "boolean" ||
        (entry.displayName !== undefined && !boundedTitle(entry.displayName)) ||
        (entry.frequencyMode !== undefined &&
          !FREQUENCY_MODES.includes(entry.frequencyMode))
      ) {
        return null;
      }
      titles.add(entry.title);
      const normalizedEntry = { title: entry.title, favorite: entry.favorite };
      if (entry.displayName !== undefined) {
        normalizedEntry.displayName = entry.displayName.trim();
      }
      if (entry.frequencyMode !== undefined) {
        normalizedEntry.frequencyMode = entry.frequencyMode;
      }
      normalized.push(normalizedEntry);
    }
    return normalized;
  }

  function normalizeFrequencyDictionaries(value) {
    if (value === undefined) {
      return [];
    }
    if (!Array.isArray(value) || value.length > LIMITS.dictionaryPresentation) {
      return null;
    }
    const titles = new Set();
    for (const entry of value) {
      if (!boundedTitle(entry) || titles.has(entry)) {
        return null;
      }
      titles.add(entry);
    }
    return [...value];
  }

  function normalizeDictionaryTabGroups(value) {
    if (value === undefined) {
      return [];
    }
    if (!Array.isArray(value) || value.length > LIMITS.dictionaryTabGroups) {
      return null;
    }
    const ids = new Set();
    const names = new Set();
    const normalized = [];
    for (const entry of value) {
      if (!isPlainObject(entry)) {
        return null;
      }
      const id = typeof entry.id === "string" ? entry.id : "";
      const name = typeof entry.name === "string" ? entry.name.trim() : "";
      if (
        !boundedTitle(id) ||
        !name ||
        name.length > LIMITS.tabGroupNameLength ||
        ids.has(id) ||
        names.has(name) ||
        !Array.isArray(entry.dictionaries) ||
        entry.dictionaries.length > LIMITS.dictionaryPresentation
      ) {
        return null;
      }
      const dictionaries = new Set();
      for (const dictionary of entry.dictionaries) {
        if (!boundedTitle(dictionary) || dictionaries.has(dictionary)) {
          return null;
        }
        dictionaries.add(dictionary);
      }
      ids.add(id);
      names.add(name);
      normalized.push({ id, name, dictionaries: [...dictionaries] });
    }
    return normalized;
  }

  /**
   * Parses a bounded http(s) URL, optionally expanding the %w / %s popup-link
   * markers first so a template can be validated without being rewritten.
   */
  function parseSafeHttpUrl(value, options = {}) {
    const maxLength = options.maxLength ?? LIMITS.expandedExternalUrlLength;
    const url = typeof value === "string" ? value.trim() : "";
    if (!url || url.length > maxLength || CONTROL_CHARACTERS.test(url)) {
      return null;
    }
    const probe = options.expandMarkers
      ? url.replaceAll("%w", "word").replaceAll("%s", "sentence")
      : url;
    let parsed;
    try {
      parsed = new URL(probe);
    } catch {
      return null;
    }
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password
    ) {
      return null;
    }
    return parsed;
  }

  /** Normalized absolute http(s) URL string, or null when it is unusable. */
  function normalizeExternalUrl(value) {
    return parseSafeHttpUrl(value)?.toString() ?? null;
  }

  function normalizePopupButtons(value) {
    if (value === undefined) {
      return { ...READER_DEFAULTS.popupButtons, customLinks: [] };
    }
    if (
      !isPlainObject(value) ||
      typeof value.addToAnki !== "boolean" ||
      typeof value.audio !== "boolean" ||
      typeof value.customDefinition !== "boolean" ||
      typeof value.viewInAnki !== "boolean" ||
      !Array.isArray(value.customLinks) ||
      value.customLinks.length > LIMITS.popupCustomLinks
    ) {
      return null;
    }
    const customLinks = [];
    for (const rawLink of value.customLinks) {
      if (!isPlainObject(rawLink)) {
        return null;
      }
      const label = typeof rawLink.label === "string" ? rawLink.label.trim() : "";
      const url = typeof rawLink.url === "string" ? rawLink.url.trim() : "";
      if (
        !label ||
        label.length > LIMITS.popupCustomLinkLabelLength ||
        CONTROL_CHARACTERS.test(label) ||
        !parseSafeHttpUrl(url, {
          maxLength: LIMITS.popupCustomLinkUrlLength,
          expandMarkers: true
        })
      ) {
        return null;
      }
      customLinks.push({ label, url });
    }
    return {
      addToAnki: value.addToAnki,
      audio: value.audio,
      customDefinition: value.customDefinition,
      viewInAnki: value.viewInAnki,
      customLinks
    };
  }

  /**
   * Returns the complete reader preference object, or null when any field is
   * missing or out of range. Callers decide whether that is fatal.
   */
  function normalizeReaderPreferences(preferences) {
    if (preferences !== undefined && !isPlainObject(preferences)) {
      return null;
    }
    const source = preferences ?? {};
    const normalized = {};
    for (const [key, spec] of Object.entries(FIELD_SPECS)) {
      const raw = source[key];
      const value = spec.normalize ? spec.normalize(raw) : raw;
      const valid = spec.normalize
        ? value !== null && value !== undefined && spec.check(value)
        : raw !== undefined && spec.check(raw);
      if (!valid) {
        if (raw === undefined && spec.optional) {
          normalized[key] = READER_DEFAULTS[key];
          continue;
        }
        return null;
      }
      normalized[key] = value;
    }
    return normalized;
  }

  // The per-field normalizers are reached through FIELD_SPECS; only these three
  // are called from outside the module.
  return {
    normalizeActivationKey,
    normalizeExternalUrl,
    normalizeReaderPreferences
  };
}));
