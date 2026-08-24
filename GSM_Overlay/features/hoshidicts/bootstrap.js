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

  const { READER_DEFAULTS } = constants;
  const { normalizeReaderPreferences } = preferencesApi;
  const DEFAULT_GAMEPAD_SERVER_PORT = 7276;

  const state = {
    activationKeyPressed: false,
    attached: null,
    audioProfile: null,
    enabled: false,
    preferences: null,
    reader: null,
  };

  /**
   * Reads the launch environment into one complete preference object. GSM
   * serialises the whole set as JSON, so this is the same normalizer the
   * control channel uses; anything malformed falls back to the defaults.
   */
  function readLaunchPreferences(env = {}) {
    const encoded = env.GSM_HOSHIDICTS_READER_PREFERENCES;
    if (typeof encoded !== "string" || encoded === "") {
      return { ...READER_DEFAULTS };
    }
    let parsed;
    try {
      parsed = JSON.parse(encoded);
    } catch {
      return { ...READER_DEFAULTS };
    }
    return normalizeReaderPreferences(parsed) ?? { ...READER_DEFAULTS };
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
    if (!state.enabled || !readerApi) {
      return null;
    }
    const localeSetting = settings && typeof settings.locale === "string"
      ? settings.locale
      : null;
    if (state.reader) {
      if (localeSetting !== null) {
        state.reader.updateLocale?.(localeSetting);
      }
      return state.reader;
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
      locale: localeSetting,
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
