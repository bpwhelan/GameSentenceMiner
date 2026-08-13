/*
 * Hoshidicts overlay constants.
 *
 * One Hoshidicts-owned copy of the reader defaults, bounds, themes and limits
 * shared by bootstrap.js, reader.js, audio.js and desktop_bridge.js. This is
 * deliberately independent of GSM's theme catalog and Electron settings types:
 * the overlay must keep working from environment variables alone.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.GSMHoshidictsConstants = api;
  }
}(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const LOOKUP_MODES = Object.freeze(["shift", "hover"]);
  const POPUP_TOOLBAR_POSITIONS = Object.freeze(["top", "bottom"]);
  const FREQUENCY_SORT_ORDERS = Object.freeze(["descending", "ascending"]);
  const DEFINITION_BLUR_REVEAL_MODES = Object.freeze(["timed", "hover"]);
  const FREQUENCY_MODES = Object.freeze(["rank-based", "occurrence-based"]);

  const DEFAULT_POPUP_BUTTONS = Object.freeze({
    addToAnki: true,
    audio: true,
    customDefinition: true,
    viewInAnki: false,
    customLinks: Object.freeze([]),
  });

  const DEFAULT_DEFINITION_BLUR = Object.freeze({
    enabled: false,
    lookupThreshold: 5,
    revealMode: "timed",
    revealDelayMs: 5 * 1000,
  });

  /** Every reader preference the overlay understands, with its default value. */
  const READER_DEFAULTS = Object.freeze({
    lookupMode: "shift",
    scanLength: 16,
    maxResults: 32,
    sortFrequencyDictionary: null,
    sortFrequencyDictionaryOrder: "descending",
    averageFrequency: false,
    showFrequencyDictionaryNames: true,
    activationKey: "Shift",
    sourceHighlightEnabled: false,
    onlyScanJapaneseText: true,
    popupHideDelayMs: 300,
    showLookupCounts: true,
    showCompactDefinitionSummary: false,
    compactDefinitionSummaryCount: 3,
    compactDefinitionSummaryDictionary: null,
    showPitchAccentFurigana: true,
    pitchAccentFuriganaDictionary: null,
    showPitchAccentBadge: false,
    hidePopupGrammarTags: true,
    definitionBlur: DEFAULT_DEFINITION_BLUR,
    popupNestingMaxDepth: 10,
    popupWidthPx: 560,
    popupHeightPx: 420,
    popupColumns: 1,
    popupOpacityPercent: 85,
    popupBackdropBlurPx: 16,
    popupToolbarPosition: "top",
    theme: "default",
    customPopupCss: "",
    dictionaryPresentation: Object.freeze([]),
    frequencyDictionaries: Object.freeze([]),
    dictionaryTabGroups: Object.freeze([]),
    popupButtons: DEFAULT_POPUP_BUTTONS,
  });

  /** Inclusive integer bounds; out-of-range live values are clamped, not rejected. */
  const BOUNDS = Object.freeze({
    scanLength: Object.freeze({ min: 1, max: 64 }),
    maxResults: Object.freeze({ min: 1, max: 256 }),
    compactDefinitionSummaryCount: Object.freeze({ min: 1, max: 6 }),
    popupHideDelayMs: Object.freeze({ min: 0, max: 5 * 1000 }),
    popupWidthPx: Object.freeze({ min: 280, max: 1200 }),
    popupHeightPx: Object.freeze({ min: 200, max: 900 }),
    popupColumns: Object.freeze({ min: 1, max: 4 }),
    popupOpacityPercent: Object.freeze({ min: 0, max: 100 }),
    popupBackdropBlurPx: Object.freeze({ min: 0, max: 32 }),
    popupNestingMaxDepth: Object.freeze({ min: 0, max: Number.MAX_SAFE_INTEGER }),
    definitionBlurLookupThreshold: Object.freeze({ min: 1, max: 1_000_000 }),
    definitionBlurRevealDelayMs: Object.freeze({
      min: 1000,
      max: 60 * 60 * 1000,
    }),
    audioVolume: Object.freeze({ min: 0, max: 100 }),
  });

  /** Bounded text, collection and URL sizes shared by the overlay modules. */
  const LIMITS = Object.freeze({
    dictionaryTitleLength: 4096,
    dictionaryPresentation: 256,
    dictionaryTabGroups: 256,
    tabGroupNameLength: 128,
    popupCustomLinks: 8,
    popupCustomLinkLabelLength: 64,
    popupCustomLinkUrlLength: 2048,
    customPopupCssLength: 32 * 1024,
    expandedExternalUrlLength: 2 * 1024 * 1024,
    audioSources: 32,
    audioCandidates: 32,
    audioSourceIdLength: 128,
    audioUrlLength: 4096,
    audioVoiceLength: 255,
    audioTextLength: 4096,
    customEntryTermBytes: 4 * 1024,
    customEntryReadingBytes: 4 * 1024,
    customEntryDefinitionBytes: 2 * 1024,
  });

  const THEMES = Object.freeze([
    "default",
    "catppuccin-mocha",
    "solarized-dark",
    "solarized-light",
    "high-contrast",
    "dark",
    "synthwave",
    "halloween",
    "forest",
    "aqua",
    "black",
    "luxury",
    "dracula",
    "business",
    "night",
    "coffee",
    "dim",
    "sunset",
    "abyss",
    "light",
    "cupcake",
    "bumblebee",
    "emerald",
    "corporate",
    "retro",
    "cyberpunk",
    "valentine",
    "garden",
    "lofi",
    "pastel",
    "fantasy",
    "wireframe",
    "cmyk",
    "autumn",
    "acid",
    "lemonade",
    "winter",
    "nord",
    "caramellatte",
    "silk",
    "girlypop",
  ]);
  const THEME_SET = new Set(THEMES);

  const DEFAULT_ACTIVATION_KEY = "Shift";
  /** Lower-cased alias -> canonical activation-key name accepted by the hotkey server. */
  const NAMED_ACTIVATION_KEYS = new Map([
    ["ctrl", "Ctrl"],
    ["alt", "Alt"],
    ["shift", "Shift"],
    ["cmd", "Cmd"],
    ["space", "Space"],
    ["return", "Return"],
    ["escape", "Escape"],
    ["backspace", "Backspace"],
    ["delete", "Delete"],
    ["tab", "Tab"],
    ["up", "Up"],
    ["down", "Down"],
    ["left", "Left"],
    ["right", "Right"],
    ["home", "Home"],
    ["end", "End"],
    ["pageup", "PageUp"],
    ["pagedown", "PageDown"],
    ["insert", "Insert"],
  ]);
  const PUNCTUATION_ACTIVATION_KEYS = new Set([
    "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/", "`",
  ]);

  const AUDIO_SOURCE_TYPES = Object.freeze([
    "jpod101",
    "language-pod-101",
    "jisho",
    "custom",
    "custom-json",
    "text-to-speech",
    "text-to-speech-reading",
  ]);
  const AUDIO_SOURCE_TYPE_SET = new Set(AUDIO_SOURCE_TYPES);
  const TTS_AUDIO_SOURCE_TYPES = new Set([
    "text-to-speech",
    "text-to-speech-reading",
  ]);
  const AUDIO_SOURCE_LABELS = Object.freeze({
    jpod101: "JapanesePod101",
    "language-pod-101": "LanguagePod101",
    jisho: "Jisho",
    custom: "Custom URL",
    "custom-json": "Custom JSON",
    "text-to-speech": "Text-to-speech (term)",
    "text-to-speech-reading": "Text-to-speech (reading)",
  });

  return {
    AUDIO_SOURCE_LABELS,
    AUDIO_SOURCE_TYPES,
    AUDIO_SOURCE_TYPE_SET,
    BOUNDS,
    DEFAULT_ACTIVATION_KEY,
    DEFAULT_DEFINITION_BLUR,
    DEFAULT_POPUP_BUTTONS,
    DEFINITION_BLUR_REVEAL_MODES,
    FREQUENCY_MODES,
    FREQUENCY_SORT_ORDERS,
    LIMITS,
    LOOKUP_MODES,
    NAMED_ACTIVATION_KEYS,
    POPUP_TOOLBAR_POSITIONS,
    PUNCTUATION_ACTIVATION_KEYS,
    READER_DEFAULTS,
    THEMES,
    THEME_SET,
    TTS_AUDIO_SOURCE_TYPES,
  };
}));
