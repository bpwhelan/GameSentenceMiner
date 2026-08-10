"use strict";

const { randomUUID } = require("node:crypto");
const WebSocket = require("ws");

const CONTROL_VERSION = 1;
const OPEN_SETTINGS_METHOD = "hoshidicts.openSettings";
const READER_PREFERENCES_METHOD = "hoshidicts.readerPreferences";
const AUDIO_PROFILE_METHOD = "hoshidicts.audioProfile";
const ADD_CUSTOM_ENTRY_METHOD = "hoshidicts.addCustomEntry";
const REQUEST_TIMEOUT_MS = 5000;
const DEFAULT_HOSHIDICTS_ACTIVATION_KEY = "Shift";
const HOSHIDICTS_ACTIVATION_HOTKEY_ID = "hoshidictsLookup";
const HOSHIDICTS_NAMED_ACTIVATION_KEYS = new Map([
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
const HOSHIDICTS_PUNCTUATION_ACTIVATION_KEYS = new Set([
  "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/", "`",
]);
const MAX_HOSHIDICTS_DICTIONARY_PRESENTATION = 256;
const MAX_HOSHIDICTS_DICTIONARY_TITLE_LENGTH = 4096;
const DEFAULT_HOSHIDICTS_SCAN_LENGTH = 16;
const MIN_HOSHIDICTS_SCAN_LENGTH = 1;
const MAX_HOSHIDICTS_SCAN_LENGTH = 64;
const DEFAULT_HOSHIDICTS_MAX_RESULTS = 32;
const MIN_HOSHIDICTS_MAX_RESULTS = 1;
const MAX_HOSHIDICTS_MAX_RESULTS = 256;
const MAX_HOSHIDICTS_DICTIONARY_TAB_GROUPS = 256;
const MAX_HOSHIDICTS_TAB_GROUP_NAME_LENGTH = 128;
const MAX_HOSHIDICTS_POPUP_CUSTOM_LINKS = 8;
const MAX_HOSHIDICTS_POPUP_CUSTOM_LINK_LABEL_LENGTH = 64;
const MAX_HOSHIDICTS_POPUP_CUSTOM_LINK_URL_LENGTH = 2048;
const MAX_HOSHIDICTS_EXPANDED_EXTERNAL_URL_LENGTH = 2 * 1024 * 1024;
const DEFAULT_HOSHIDICTS_POPUP_BUTTONS = Object.freeze({
  addToAnki: true,
  audio: true,
  customDefinition: true,
  viewInAnki: false,
  customLinks: Object.freeze([]),
});
const MIN_HOSHIDICTS_POPUP_WIDTH_PX = 280;
const MAX_HOSHIDICTS_POPUP_WIDTH_PX = 1200;
const MIN_HOSHIDICTS_POPUP_HEIGHT_PX = 200;
const MAX_HOSHIDICTS_POPUP_HEIGHT_PX = 900;
const MIN_HOSHIDICTS_POPUP_COLUMNS = 1;
const MAX_HOSHIDICTS_POPUP_COLUMNS = 4;
const MIN_HOSHIDICTS_POPUP_OPACITY_PERCENT = 0;
const MAX_HOSHIDICTS_POPUP_OPACITY_PERCENT = 100;
const HOSHIDICTS_THEMES = new Set([
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

function normalizeHoshidictsDictionaryPresentation(value) {
  if (value === undefined) {
    return [];
  }
  if (
    !Array.isArray(value) ||
    value.length > MAX_HOSHIDICTS_DICTIONARY_PRESENTATION
  ) {
    throw new Error("Hoshidicts reader preferences are invalid.");
  }
  const titles = new Set();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Hoshidicts reader preferences are invalid.");
    }
    const title = typeof entry.title === "string" ? entry.title : "";
    if (
      !title.trim() ||
      title.length > MAX_HOSHIDICTS_DICTIONARY_TITLE_LENGTH ||
      titles.has(title) ||
      typeof entry.favorite !== "boolean"
    ) {
      throw new Error("Hoshidicts reader preferences are invalid.");
    }
    const displayName = entry.displayName;
    if (
      displayName !== undefined &&
      (typeof displayName !== "string" ||
        !displayName.trim() ||
        displayName.length > MAX_HOSHIDICTS_DICTIONARY_TITLE_LENGTH)
    ) {
      throw new Error("Hoshidicts reader preferences are invalid.");
    }
    const frequencyMode = entry.frequencyMode;
    if (
      frequencyMode !== undefined &&
      frequencyMode !== "rank-based" &&
      frequencyMode !== "occurrence-based"
    ) {
      throw new Error("Hoshidicts reader preferences are invalid.");
    }
    titles.add(title);
    const normalized = {
      title,
      favorite: entry.favorite,
    };
    if (displayName !== undefined) {
      normalized.displayName = displayName.trim();
    }
    if (frequencyMode !== undefined) {
      normalized.frequencyMode = frequencyMode;
    }
    return normalized;
  });
}

function normalizeHoshidictsFrequencyDictionaries(value) {
  if (value === undefined) {
    return [];
  }
  if (
    !Array.isArray(value) ||
    value.length > MAX_HOSHIDICTS_DICTIONARY_PRESENTATION
  ) {
    throw new Error("Hoshidicts reader preferences are invalid.");
  }
  const titles = new Set();
  return value.map((entry) => {
    if (
      typeof entry !== "string" ||
      !entry.trim() ||
      entry.length > MAX_HOSHIDICTS_DICTIONARY_TITLE_LENGTH ||
      titles.has(entry)
    ) {
      throw new Error("Hoshidicts reader preferences are invalid.");
    }
    titles.add(entry);
    return entry;
  });
}

function normalizeHoshidictsDictionaryTabGroups(value) {
  if (value === undefined) {
    return [];
  }
  if (
    !Array.isArray(value) ||
    value.length > MAX_HOSHIDICTS_DICTIONARY_TAB_GROUPS
  ) {
    throw new Error("Hoshidicts reader preferences are invalid.");
  }
  const ids = new Set();
  const names = new Set();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Hoshidicts reader preferences are invalid.");
    }
    const id = typeof entry.id === "string" ? entry.id : "";
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (
      !id.trim() ||
      id.length > MAX_HOSHIDICTS_DICTIONARY_TITLE_LENGTH ||
      !name ||
      name.length > MAX_HOSHIDICTS_TAB_GROUP_NAME_LENGTH ||
      ids.has(id) ||
      names.has(name) ||
      !Array.isArray(entry.dictionaries) ||
      entry.dictionaries.length > MAX_HOSHIDICTS_DICTIONARY_PRESENTATION
    ) {
      throw new Error("Hoshidicts reader preferences are invalid.");
    }
    const dictionaries = [];
    const dictionaryTitles = new Set();
    for (const dictionary of entry.dictionaries) {
      if (
        typeof dictionary !== "string" ||
        !dictionary.trim() ||
        dictionary.length > MAX_HOSHIDICTS_DICTIONARY_TITLE_LENGTH ||
        dictionaryTitles.has(dictionary)
      ) {
        throw new Error("Hoshidicts reader preferences are invalid.");
      }
      dictionaries.push(dictionary);
      dictionaryTitles.add(dictionary);
    }
    ids.add(id);
    names.add(name);
    return { id, name, dictionaries };
  });
}

function normalizeHoshidictsPopupButtons(value) {
  if (value === undefined) {
    return {
      ...DEFAULT_HOSHIDICTS_POPUP_BUTTONS,
      customLinks: [],
    };
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.addToAnki !== "boolean" ||
    typeof value.audio !== "boolean" ||
    typeof value.customDefinition !== "boolean" ||
    typeof value.viewInAnki !== "boolean" ||
    !Array.isArray(value.customLinks) ||
    value.customLinks.length > MAX_HOSHIDICTS_POPUP_CUSTOM_LINKS
  ) {
    throw new Error("Hoshidicts reader preferences are invalid.");
  }
  const customLinks = value.customLinks.map((rawLink) => {
    if (!rawLink || typeof rawLink !== "object" || Array.isArray(rawLink)) {
      throw new Error("Hoshidicts reader preferences are invalid.");
    }
    const label = typeof rawLink.label === "string" ? rawLink.label.trim() : "";
    const url = typeof rawLink.url === "string" ? rawLink.url.trim() : "";
    if (
      !label ||
      label.length > MAX_HOSHIDICTS_POPUP_CUSTOM_LINK_LABEL_LENGTH ||
      /[\u0000-\u001f\u007f]/u.test(label) ||
      !url ||
      url.length > MAX_HOSHIDICTS_POPUP_CUSTOM_LINK_URL_LENGTH ||
      /[\u0000-\u001f\u007f]/u.test(url)
    ) {
      throw new Error("Hoshidicts reader preferences are invalid.");
    }
    let parsed;
    try {
      parsed = new URL(
        url.replaceAll("%w", "word").replaceAll("%s", "sentence")
      );
    } catch {
      throw new Error("Hoshidicts reader preferences are invalid.");
    }
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password
    ) {
      throw new Error("Hoshidicts reader preferences are invalid.");
    }
    return { label, url };
  });
  return {
    addToAnki: value.addToAnki,
    audio: value.audio,
    customDefinition: value.customDefinition,
    viewInAnki: value.viewInAnki,
    customLinks,
  };
}

function normalizeHoshidictsExternalUrl(value) {
  const url = typeof value === "string" ? value.trim() : "";
  if (
    !url ||
    url.length > MAX_HOSHIDICTS_EXPANDED_EXTERNAL_URL_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(url)
  ) {
    throw new Error("External link URL is invalid.");
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("External link URL is invalid.");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error("External link URL is invalid.");
  }
  return parsed.toString();
}

function normalizeHoshidictsActivationKey(
  value,
  fallback = DEFAULT_HOSHIDICTS_ACTIVATION_KEY
) {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalizedKey = value.trim();
  if (HOSHIDICTS_PUNCTUATION_ACTIVATION_KEYS.has(normalizedKey)) {
    return normalizedKey;
  }
  if (/^[a-z]$/iu.test(normalizedKey)) {
    return normalizedKey.toUpperCase();
  }
  if (/^[0-9]$/u.test(normalizedKey)) {
    return normalizedKey;
  }
  const functionKeyMatch = /^f([1-9]|1[0-9]|2[0-4])$/iu.exec(normalizedKey);
  if (functionKeyMatch) {
    return `F${functionKeyMatch[1]}`;
  }
  return (
    HOSHIDICTS_NAMED_ACTIVATION_KEYS.get(normalizedKey.toLowerCase()) ?? fallback
  );
}

function normalizeHoshidictsReaderPreferences(preferences) {
  const lookupMode = preferences && preferences.lookupMode;
  const scanLength = preferences?.scanLength === undefined
    ? DEFAULT_HOSHIDICTS_SCAN_LENGTH
    : preferences.scanLength;
  const maxResults = preferences?.maxResults === undefined
    ? DEFAULT_HOSHIDICTS_MAX_RESULTS
    : preferences.maxResults;
  const sortFrequencyDictionary = preferences?.sortFrequencyDictionary === undefined
    ? null
    : preferences.sortFrequencyDictionary;
  const sortFrequencyDictionaryOrder =
    preferences?.sortFrequencyDictionaryOrder === undefined
      ? "descending"
      : preferences.sortFrequencyDictionaryOrder;
  const requestedActivationKey = preferences && preferences.activationKey;
  const activationKey = requestedActivationKey === undefined
    ? DEFAULT_HOSHIDICTS_ACTIVATION_KEY
    : normalizeHoshidictsActivationKey(requestedActivationKey, null);
  const sourceHighlightEnabled =
    preferences && preferences.sourceHighlightEnabled;
  const onlyScanJapaneseText =
    preferences && preferences.onlyScanJapaneseText;
  const popupHideDelayMs = preferences && preferences.popupHideDelayMs;
  const popupNestingMaxDepth =
    preferences && preferences.popupNestingMaxDepth;
  const popupWidthPx = preferences && preferences.popupWidthPx;
  const popupHeightPx = preferences && preferences.popupHeightPx;
  const popupColumns = preferences?.popupColumns === undefined
    ? 1
    : preferences.popupColumns;
  const popupOpacityPercent = preferences && preferences.popupOpacityPercent;
  const popupToolbarPosition = preferences && preferences.popupToolbarPosition;
  const theme = preferences && preferences.theme;
  const dictionaryPresentation = normalizeHoshidictsDictionaryPresentation(
    preferences && preferences.dictionaryPresentation
  );
  const frequencyDictionaries = normalizeHoshidictsFrequencyDictionaries(
    preferences && preferences.frequencyDictionaries
  );
  const dictionaryTabGroups = normalizeHoshidictsDictionaryTabGroups(
    preferences && preferences.dictionaryTabGroups
  );
  const popupButtons = normalizeHoshidictsPopupButtons(
    preferences && preferences.popupButtons
  );
  if (
    (lookupMode !== "shift" && lookupMode !== "hover") ||
    !Number.isInteger(scanLength) ||
    scanLength < MIN_HOSHIDICTS_SCAN_LENGTH ||
    scanLength > MAX_HOSHIDICTS_SCAN_LENGTH ||
    !Number.isInteger(maxResults) ||
    maxResults < MIN_HOSHIDICTS_MAX_RESULTS ||
    maxResults > MAX_HOSHIDICTS_MAX_RESULTS ||
    (
      sortFrequencyDictionary !== null &&
      (
        typeof sortFrequencyDictionary !== "string" ||
        !sortFrequencyDictionary.trim() ||
        sortFrequencyDictionary.length > MAX_HOSHIDICTS_DICTIONARY_TITLE_LENGTH
      )
    ) ||
    (
      sortFrequencyDictionaryOrder !== "ascending" &&
      sortFrequencyDictionaryOrder !== "descending"
    ) ||
    activationKey === null ||
    typeof sourceHighlightEnabled !== "boolean" ||
    (
      onlyScanJapaneseText !== undefined &&
      typeof onlyScanJapaneseText !== "boolean"
    ) ||
    !Number.isInteger(popupHideDelayMs) ||
    popupHideDelayMs < 0 ||
    popupHideDelayMs > 5000 ||
    !Number.isSafeInteger(popupNestingMaxDepth) ||
    popupNestingMaxDepth < 0 ||
    !Number.isInteger(popupWidthPx) ||
    popupWidthPx < MIN_HOSHIDICTS_POPUP_WIDTH_PX ||
    popupWidthPx > MAX_HOSHIDICTS_POPUP_WIDTH_PX ||
    !Number.isInteger(popupHeightPx) ||
    popupHeightPx < MIN_HOSHIDICTS_POPUP_HEIGHT_PX ||
    popupHeightPx > MAX_HOSHIDICTS_POPUP_HEIGHT_PX ||
    !Number.isInteger(popupColumns) ||
    popupColumns < MIN_HOSHIDICTS_POPUP_COLUMNS ||
    popupColumns > MAX_HOSHIDICTS_POPUP_COLUMNS ||
    !Number.isInteger(popupOpacityPercent) ||
    popupOpacityPercent < MIN_HOSHIDICTS_POPUP_OPACITY_PERCENT ||
    popupOpacityPercent > MAX_HOSHIDICTS_POPUP_OPACITY_PERCENT ||
    (popupToolbarPosition !== "top" && popupToolbarPosition !== "bottom") ||
    !HOSHIDICTS_THEMES.has(theme)
  ) {
    throw new Error("Hoshidicts reader preferences are invalid.");
  }
  return {
    lookupMode,
    scanLength,
    maxResults,
    sortFrequencyDictionary,
    sortFrequencyDictionaryOrder,
    activationKey,
    sourceHighlightEnabled,
    onlyScanJapaneseText: onlyScanJapaneseText !== false,
    popupHideDelayMs,
    popupNestingMaxDepth,
    popupWidthPx,
    popupHeightPx,
    popupColumns,
    popupOpacityPercent,
    popupToolbarPosition,
    theme,
    dictionaryPresentation,
    frequencyDictionaries,
    dictionaryTabGroups,
    popupButtons,
  };
}

function createHoshidictsActivationHotkeyController(options = {}) {
  const registry = options.registry;
  if (!(registry instanceof Map)) {
    throw new TypeError("Hoshidicts activation hotkey controller requires a registry.");
  }
  const onStateChange = typeof options.onStateChange === "function"
    ? options.onStateChange
    : () => {};
  const id = String(options.id || HOSHIDICTS_ACTIVATION_HOTKEY_ID);
  let activationKey = null;
  let pressed = false;

  function setPressed(nextState) {
    const nextPressed = nextState === true || nextState === "pressed";
    if (pressed === nextPressed) {
      return false;
    }
    pressed = nextPressed;
    onStateChange(pressed);
    return true;
  }

  function configure(preferences = {}) {
    const normalizedActivationKey = normalizeHoshidictsActivationKey(
      preferences.activationKey
    );
    const enabled = preferences.enabled === true && preferences.lookupMode !== "hover";
    const nextActivationKey = enabled ? normalizedActivationKey : null;
    const currentEntry = registry.get(id);
    if (
      activationKey === nextActivationKey &&
      (nextActivationKey === null || (
        currentEntry &&
        currentEntry.accelerator === nextActivationKey &&
        currentEntry.onStateChange === setPressed
      ))
    ) {
      return {
        activationKey: normalizedActivationKey,
        changed: false,
        enabled,
      };
    }

    setPressed(false);
    registry.delete(id);
    activationKey = nextActivationKey;
    if (activationKey !== null) {
      registry.set(id, {
        accelerator: activationKey,
        onStateChange: setPressed,
      });
    }
    return {
      activationKey: normalizedActivationKey,
      changed: true,
      enabled,
    };
  }

  function clear() {
    return configure({ enabled: false });
  }

  return {
    clear,
    configure,
    getActivationKey: () => activationKey,
    isEnabled: () => activationKey !== null,
    isPressed: () => pressed,
    release: () => setPressed(false),
  };
}

function dispatchAppHotkeyInputServerMessage(message, registry) {
  if (
    !message ||
    message.type !== "app_hotkey_event" ||
    (message.state !== "pressed" && message.state !== "released") ||
    !(registry instanceof Map)
  ) {
    return false;
  }
  const entry = registry.get(message.id);
  if (!entry) {
    return false;
  }
  if (typeof entry.onStateChange === "function") {
    entry.onStateChange(message.state);
    return true;
  }
  if (message.state === "pressed" && typeof entry.handler === "function") {
    entry.handler();
    return true;
  }
  return false;
}

function resolveHoshidictsControlConfig(env = process.env) {
  const configuredPort = String(env.GSM_HOSHIDICTS_CONTROL_PORT || "").trim();
  if (!/^\d{1,5}$/u.test(configuredPort)) {
    return null;
  }
  const port = Number(configuredPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }
  return { port };
}

function controlFrame(kind, fields = {}) {
  return {
    version: CONTROL_VERSION,
    kind,
    ...fields,
  };
}

function createHoshidictsReaderPreferencesDelivery(deliver) {
  if (typeof deliver !== "function") {
    throw new TypeError("Hoshidicts reader preference delivery requires a callback.");
  }
  let ready = false;
  let latest = null;

  return {
    enqueue(preferences) {
      latest = preferences;
      if (!ready) {
        return false;
      }
      deliver(preferences);
      return true;
    },
    markReady() {
      if (ready) return false;
      ready = true;
      if (latest === null) return false;
      deliver(latest);
      return true;
    },
    markNotReady() {
      ready = false;
    },
    clear() {
      ready = false;
      latest = null;
    },
  };
}

function createHoshidictsReaderPreferencesBridge(options = {}) {
  const config = resolveHoshidictsControlConfig(options.env);
  if (!config) {
    return {
      requestAddCustomEntry() {
        return Promise.reject(
          new Error("Hoshidicts desktop control channel is unavailable.")
        );
      },
      destroy() {},
    };
  }
  const WebSocketImpl = options.WebSocketImpl || WebSocket;
  const requestHandlers = new Map([
    [
      READER_PREFERENCES_METHOD,
      typeof options.onPreferences === "function"
        ? options.onPreferences
        : async () => undefined,
    ],
    [
      AUDIO_PROFILE_METHOD,
      typeof options.onAudioPreferences === "function"
        ? options.onAudioPreferences
        : async () => undefined,
    ],
  ]);
  let socket = null;
  let reconnectTimer = null;
  let reconnectDelayMs = 750;
  let destroyed = false;
  let ready = false;
  const pendingRequests = new Map();

  function send(message) {
    if (socket && socket.readyState === WebSocketImpl.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  function scheduleReconnect() {
    if (destroyed || reconnectTimer !== null) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelayMs);
    reconnectDelayMs = Math.min(10_000, reconnectDelayMs * 2);
  }

  function rejectPending(error) {
    for (const pending of pendingRequests.values()) {
      pending.reject(error);
    }
    pendingRequests.clear();
  }

  function request(method, data) {
    if (destroyed) {
      return Promise.reject(new Error("Hoshidicts desktop bridge is closed."));
    }
    if (
      !ready ||
      !socket ||
      socket.readyState !== WebSocketImpl.OPEN
    ) {
      return Promise.reject(
        new Error("Hoshidicts desktop control channel is unavailable.")
      );
    }
    const message = controlFrame("request", {
      id: randomUUID(),
      method,
      data,
    });

    return new Promise((resolve, reject) => {
      pendingRequests.set(message.id, { resolve, reject });
      try {
        socket.send(JSON.stringify(message));
      } catch (error) {
        pendingRequests.delete(message.id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  function respond(message, ok, data, error) {
    send(
      controlFrame("response", {
        id: message.id,
        ok,
        ...(data === undefined ? {} : { data }),
        ...(error ? { error } : {}),
      })
    );
  }

  function connect() {
    if (destroyed || (socket && socket.readyState <= WebSocketImpl.OPEN)) return;
    const nextSocket = new WebSocketImpl(`ws://127.0.0.1:${config.port}`);
    socket = nextSocket;
    nextSocket.on("open", () => {
      send(controlFrame("reader-ready"));
    });
    nextSocket.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (
        message.version === CONTROL_VERSION &&
        message.kind === "reader-ready"
      ) {
        ready = true;
        reconnectDelayMs = 750;
        return;
      }
      if (
        message.version === CONTROL_VERSION &&
        message.kind === "response" &&
        typeof message.id === "string" &&
        pendingRequests.has(message.id)
      ) {
        const pending = pendingRequests.get(message.id);
        pendingRequests.delete(message.id);
        if (message.ok === false) {
          pending.reject(new Error(
            typeof message.error === "string"
              ? message.error
              : `Desktop rejected ${message.method || "the request"}.`
          ));
        } else {
          pending.resolve(message.data);
        }
        return;
      }
      const apply = requestHandlers.get(message.method);
      if (
        message.version !== CONTROL_VERSION ||
        message.kind !== "request" ||
        typeof message.id !== "string" ||
        !apply
      ) {
        return;
      }
      Promise.resolve().then(() => apply(message.data)).then(
        () => respond(message, true, { applied: true }),
        (error) => respond(
          message,
          false,
          undefined,
          error instanceof Error ? error.message : String(error)
        )
      );
    });
    nextSocket.on("error", () => {});
    nextSocket.on("close", () => {
      if (socket === nextSocket) socket = null;
      ready = false;
      rejectPending(
        new Error("Hoshidicts desktop control channel closed unexpectedly.")
      );
      scheduleReconnect();
    });
  }

  connect();
  return {
    requestAddCustomEntry(entry) {
      return request(ADD_CUSTOM_ENTRY_METHOD, entry);
    },
    destroy() {
      destroyed = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (socket) {
        socket.close();
        socket = null;
      }
      ready = false;
      rejectPending(new Error("Hoshidicts desktop bridge is closed."));
    },
  };
}

function requestHoshidictsSettingsOpen(options = {}) {
  const config = resolveHoshidictsControlConfig(options.env);
  if (!config) {
    return Promise.reject(
      new Error("GameSentenceMiner desktop control channel is unavailable.")
    );
  }

  const WebSocketImpl = options.WebSocketImpl || WebSocket;
  return new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(`ws://127.0.0.1:${config.port}`);
    let settled = false;
    const requestId = randomUUID();
    const timeout = setTimeout(() => {
      finish(new Error("Timed out opening Hoshidicts settings."));
    }, options.timeoutMs || REQUEST_TIMEOUT_MS);

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        socket.close();
      } catch {
        // Best effort after the request has completed.
      }
      if (error) reject(error);
      else resolve(value);
    }

    socket.on("open", () => {
      socket.send(
        JSON.stringify(
          controlFrame("request", {
            id: requestId,
            method: OPEN_SETTINGS_METHOD,
          })
        )
      );
    });

    socket.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        finish(new Error("Desktop control channel returned invalid JSON."));
        return;
      }

      if (
        message.version === CONTROL_VERSION &&
        message.kind === "response" &&
        message.id === requestId
      ) {
        if (message.ok === false) {
          finish(
            new Error(
              typeof message.error === "string"
                ? message.error
                : "Desktop rejected the settings request."
            )
          );
          return;
        }
        finish(null, message.data);
      }
    });

    socket.on("error", (error) => {
      finish(
        error instanceof Error
          ? error
          : new Error("Desktop control channel failed.")
      );
    });
    socket.on("close", () => {
      if (!settled) {
        finish(new Error("Desktop control channel closed unexpectedly."));
      }
    });
  });
}

module.exports = {
  ADD_CUSTOM_ENTRY_METHOD,
  AUDIO_PROFILE_METHOD,
  createHoshidictsActivationHotkeyController,
  createHoshidictsReaderPreferencesDelivery,
  createHoshidictsReaderPreferencesBridge,
  DEFAULT_HOSHIDICTS_ACTIVATION_KEY,
  dispatchAppHotkeyInputServerMessage,
  HOSHIDICTS_ACTIVATION_HOTKEY_ID,
  normalizeHoshidictsActivationKey,
  normalizeHoshidictsDictionaryPresentation,
  normalizeHoshidictsDictionaryTabGroups,
  normalizeHoshidictsExternalUrl,
  normalizeHoshidictsPopupButtons,
  normalizeHoshidictsReaderPreferences,
  OPEN_SETTINGS_METHOD,
  READER_PREFERENCES_METHOD,
  requestHoshidictsSettingsOpen,
  resolveHoshidictsControlConfig,
};
