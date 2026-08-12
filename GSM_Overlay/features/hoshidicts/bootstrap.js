/*
 * Hoshidicts overlay bootstrap.
 *
 * Owns everything the core overlay used to carry inline: reading the launch
 * environment, applying the popup presentation variables, creating the reader
 * with its GSM API clients, and relaying live desktop preferences. The overlay
 * only needs the script includes plus one attach/initialize call.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

(function (root, factory) {
  const api = factory(
    root,
    root && root.GSMHoshidictsConstants,
    root && root.GSMHoshidictsPreferences
  );
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.GSMHoshidictsBootstrap = api;
  }
}(typeof window !== "undefined" ? window : globalThis, function (
  globalWindow,
  constants,
  preferencesApi
) {
  "use strict";

  if (!constants || !preferencesApi) {
    throw new Error("Hoshidicts constants and preferences must load first.");
  }

  const { BOUNDS, LIMITS, LOOKUP_MODES, READER_DEFAULTS, THEMES } = constants;
  const {
    normalizeActivationKey,
    normalizeReaderPreferences,
  } = preferencesApi;
  const DEFAULT_GAMEPAD_SERVER_PORT = 7276;

  const state = {
    activationKeyPressed: false,
    attached: null,
    audioProfile: null,
    enabled: false,
    preferences: null,
    reader: null,
  };

  /** Reads the launch environment into one complete preference object. */
  function readLaunchPreferences(env = {}) {
    const raw = (key) => {
      const value = env[`GSM_HOSHIDICTS_${key}`];
      return typeof value === "string" ? value : "";
    };
    const flag = (key, fallback) => {
      const value = raw(key);
      return value === "1" || (value === "0" ? false : fallback);
    };
    const integer = (key, bound, fallback) => {
      const text = raw(key).trim();
      const value = text === "" ? Number.NaN : Number(text);
      return Number.isInteger(value) && value >= bound.min && value <= bound.max
        ? value
        : fallback;
    };
    const choice = (key, allowed, fallback) => {
      const value = raw(key);
      return allowed.includes(value) ? value : fallback;
    };
    const title = (key) => {
      const value = raw(key);
      return value.trim() && value.length <= LIMITS.dictionaryTitleLength
        ? value
        : null;
    };

    return {
      ...READER_DEFAULTS,
      lookupMode: choice("LOOKUP_MODE", LOOKUP_MODES, READER_DEFAULTS.lookupMode),
      scanLength: integer("SCAN_LENGTH", BOUNDS.scanLength, READER_DEFAULTS.scanLength),
      maxResults: integer("MAX_RESULTS", BOUNDS.maxResults, READER_DEFAULTS.maxResults),
      sortFrequencyDictionary: title("SORT_FREQUENCY_DICTIONARY"),
      sortFrequencyDictionaryOrder: choice(
        "SORT_FREQUENCY_DICTIONARY_ORDER",
        constants.FREQUENCY_SORT_ORDERS,
        READER_DEFAULTS.sortFrequencyDictionaryOrder
      ),
      averageFrequency: flag("AVERAGE_FREQUENCY", READER_DEFAULTS.averageFrequency),
      showFrequencyDictionaryNames: flag(
        "SHOW_FREQUENCY_DICTIONARY_NAMES",
        READER_DEFAULTS.showFrequencyDictionaryNames
      ),
      activationKey: normalizeActivationKey(raw("ACTIVATION_KEY")),
      sourceHighlightEnabled: flag(
        "SOURCE_HIGHLIGHT_ENABLED",
        READER_DEFAULTS.sourceHighlightEnabled
      ),
      onlyScanJapaneseText: flag(
        "ONLY_SCAN_JAPANESE_TEXT",
        READER_DEFAULTS.onlyScanJapaneseText
      ),
      popupHideDelayMs: integer(
        "POPUP_HIDE_DELAY_MS",
        BOUNDS.popupHideDelayMs,
        READER_DEFAULTS.popupHideDelayMs
      ),
      showLookupCounts: flag("SHOW_LOOKUP_COUNTS", READER_DEFAULTS.showLookupCounts),
      showCompactDefinitionSummary: flag(
        "SHOW_COMPACT_DEFINITION_SUMMARY",
        READER_DEFAULTS.showCompactDefinitionSummary
      ),
      compactDefinitionSummaryCount: integer(
        "COMPACT_DEFINITION_SUMMARY_COUNT",
        BOUNDS.compactDefinitionSummaryCount,
        READER_DEFAULTS.compactDefinitionSummaryCount
      ),
      compactDefinitionSummaryDictionary: title(
        "COMPACT_DEFINITION_SUMMARY_DICTIONARY"
      ),
      showPitchAccentFurigana: flag(
        "SHOW_PITCH_ACCENT_FURIGANA",
        READER_DEFAULTS.showPitchAccentFurigana
      ),
      pitchAccentFuriganaDictionary: title("PITCH_ACCENT_FURIGANA_DICTIONARY"),
      showPitchAccentBadge: flag(
        "SHOW_PITCH_ACCENT_BADGE",
        READER_DEFAULTS.showPitchAccentBadge
      ),
      hidePopupGrammarTags: flag(
        "HIDE_POPUP_GRAMMAR_TAGS",
        READER_DEFAULTS.hidePopupGrammarTags
      ),
      definitionBlur: {
        enabled: flag("DEFINITION_BLUR_ENABLED", false),
        lookupThreshold: integer(
          "DEFINITION_BLUR_LOOKUP_THRESHOLD",
          BOUNDS.definitionBlurLookupThreshold,
          READER_DEFAULTS.definitionBlur.lookupThreshold
        ),
        revealMode: choice(
          "DEFINITION_BLUR_REVEAL_MODE",
          constants.DEFINITION_BLUR_REVEAL_MODES,
          READER_DEFAULTS.definitionBlur.revealMode
        ),
        revealDelayMs: integer(
          "DEFINITION_BLUR_REVEAL_DELAY_MS",
          BOUNDS.definitionBlurRevealDelayMs,
          READER_DEFAULTS.definitionBlur.revealDelayMs
        ),
      },
      popupNestingMaxDepth: integer(
        "POPUP_NESTING_MAX_DEPTH",
        BOUNDS.popupNestingMaxDepth,
        READER_DEFAULTS.popupNestingMaxDepth
      ),
      popupWidthPx: integer("POPUP_WIDTH_PX", BOUNDS.popupWidthPx, READER_DEFAULTS.popupWidthPx),
      popupHeightPx: integer(
        "POPUP_HEIGHT_PX",
        BOUNDS.popupHeightPx,
        READER_DEFAULTS.popupHeightPx
      ),
      popupColumns: integer("POPUP_COLUMNS", BOUNDS.popupColumns, READER_DEFAULTS.popupColumns),
      popupOpacityPercent: integer(
        "POPUP_OPACITY_PERCENT",
        BOUNDS.popupOpacityPercent,
        READER_DEFAULTS.popupOpacityPercent
      ),
      popupBackdropBlurPx: integer(
        "POPUP_BACKDROP_BLUR_PX",
        BOUNDS.popupBackdropBlurPx,
        READER_DEFAULTS.popupBackdropBlurPx
      ),
      popupToolbarPosition: choice(
        "POPUP_TOOLBAR_POSITION",
        constants.POPUP_TOOLBAR_POSITIONS,
        READER_DEFAULTS.popupToolbarPosition
      ),
      theme: choice("THEME", THEMES, READER_DEFAULTS.theme),
      customPopupCss: "",
      dictionaryPresentation: [],
      frequencyDictionaries: [],
      dictionaryTabGroups: [],
      popupButtons: { ...READER_DEFAULTS.popupButtons, customLinks: [] },
    };
  }

  /** Mirrors the popup theme and translucency onto the overlay document. */
  function applyDocumentPresentation(documentRef, preferences) {
    const element = documentRef && documentRef.documentElement;
    if (!element) {
      return;
    }
    element.dataset.hoshidictsTheme = preferences.theme;
    element.style.setProperty(
      "--gsm-hoshidicts-popup-opacity",
      `${preferences.popupOpacityPercent}%`
    );
    element.style.setProperty(
      "--gsm-hoshidicts-popup-backdrop-filter",
      preferences.popupBackdropBlurPx === 0
        ? "none"
        : `blur(${preferences.popupBackdropBlurPx}px) saturate(1.08)`
    );
  }

  /**
   * Runs before the rest of the overlay loads so the scanner-suppression marker
   * and popup presentation are in place for the first frame.
   */
  function applyLaunchEnvironment(options = {}) {
    const env = options.env || (typeof process !== "undefined" && process.env) || {};
    const documentRef = options.document ||
      (globalWindow && globalWindow.document) ||
      null;
    state.enabled = env.GSM_HOSHIDICTS_ENABLED === "1";
    state.preferences = readLaunchPreferences(env);
    state.activationKeyPressed = false;
    if (globalWindow) {
      globalWindow.gsmHoshidictsReaderEnabled = state.enabled;
    }
    applyDocumentPresentation(documentRef, state.preferences);
    const element = documentRef && documentRef.documentElement;
    if (state.enabled && element) {
      element.classList.add("gsm-hoshidicts-enabled");
      element.dataset.gsmHoshidictsEnabled = "true";
    }
    return state.preferences;
  }

  /** Relays live desktop preferences; safe to call once per overlay window. */
  function attachDesktopBridge(options = {}) {
    const ipcRenderer = options.ipcRenderer;
    if (!ipcRenderer || state.attached) {
      return;
    }
    state.attached = options;
    const documentRef = options.document ||
      (globalWindow && globalWindow.document) ||
      null;

    ipcRenderer.on("hoshidicts-reader-preferences", (_event, payload) => {
      const preferences = normalizeReaderPreferences(payload);
      if (!preferences) {
        return;
      }
      state.preferences = preferences;
      applyDocumentPresentation(documentRef, preferences);
      state.reader?.updatePreferences?.(preferences);
    });

    ipcRenderer.on("hoshidicts-activation-key-state", (_event, pressed) => {
      state.activationKeyPressed = pressed === true;
      state.reader?.setActivationKeyPressed?.(state.activationKeyPressed);
    });

    ipcRenderer.on("hoshidicts-audio-preferences", (_event, payload) => {
      const profile = payload && typeof payload === "object"
        ? (payload.audioProfile || payload)
        : null;
      if (!profile) {
        return;
      }
      state.audioProfile = profile;
      state.reader?.updateAudioPreferences?.(profile);
    });
  }

  /**
   * Creates the reader once the overlay knows its GSM API and gamepad ports.
   * Repeat calls (one per settings push) are ignored.
   */
  function initialize(settings = {}) {
    const readerApi = globalWindow && globalWindow.GSMHoshidictsReader;
    if (!state.enabled || state.reader || !readerApi) {
      return null;
    }
    const port = Number.parseInt(settings && settings.gamepadServerPort, 10);
    const serverPort = Number.isFinite(port) && port > 0 && port <= 65535
      ? port
      : DEFAULT_GAMEPAD_SERVER_PORT;
    const baseUrl = readerApi.resolveGsmApiBaseUrl(settings);
    const miningClient = readerApi.createHoshidictsMiningClient({ baseUrl });
    const lookupStatsClient = readerApi.createHoshidictsLookupStatsClient({ baseUrl });
    const audioClient = readerApi.createHoshidictsAudioClient({ baseUrl });
    const ipcRenderer = state.attached?.ipcRenderer;
    const invoke = (channel, payload) => (ipcRenderer
      ? ipcRenderer.invoke(channel, payload)
      : Promise.reject(new Error("Hoshidicts desktop channel is unavailable.")));

    state.reader = readerApi.createHoshidictsReader({
      ...state.preferences,
      serverUrl: `ws://127.0.0.1:${serverPort}`,
      activationKeyPressed: state.activationKeyPressed === true,
      audioClient,
      audioPreferences: state.audioProfile,
      onPopupStateChange: state.attached?.onPopupStateChange,
      getMiningStatus: () => miningClient.getStatus(),
      checkMiningNotes: (payload) => miningClient.check(payload),
      onMine: (payload) => miningClient.mine(payload),
      onBrowse: (payload) => miningClient.browse(payload),
      onLookup: (payload) => lookupStatsClient.record(payload),
      onOpenExternalLink: (url) => invoke("hoshidicts-open-external", { url }),
      onAddCustomEntry: (entry) => invoke("hoshidicts-add-custom-entry", entry),
    });
    if (globalWindow) {
      globalWindow.gsmHoshidictsReader = state.reader;
    }

    // Hoshidicts replaces the Yomitan popup, so close anything Yomitan showed.
    const bridge = globalWindow && globalWindow.gsmYomitanBridge;
    if (bridge && typeof bridge.closePopups === "function") {
      void bridge.closePopups({ timeoutMs: 1500 }).catch(() => {});
    }
    return state.reader;
  }

  function destroy() {
    state.reader?.destroy?.();
    state.reader = null;
    state.attached = null;
    state.audioProfile = null;
    state.activationKeyPressed = false;
    if (globalWindow) {
      globalWindow.gsmHoshidictsReader = null;
    }
  }

  if (globalWindow && globalWindow.document) {
    applyLaunchEnvironment();
  }

  return {
    applyDocumentPresentation,
    applyLaunchEnvironment,
    attachDesktopBridge,
    destroy,
    getAudioProfile: () => state.audioProfile,
    getPreferences: () => state.preferences,
    getReader: () => state.reader,
    initialize,
    isEnabled: () => state.enabled,
    readLaunchPreferences,
  };
}));
