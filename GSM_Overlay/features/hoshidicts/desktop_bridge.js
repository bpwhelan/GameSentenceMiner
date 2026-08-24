"use strict";

const { randomUUID } = require("node:crypto");
const WebSocket = require("ws");

const constants = require("./constants");
const preferences = require("./preferences");

const { BOUNDS, LIMITS } = constants;
const CONTROL_VERSION = 1;
const OPEN_SETTINGS_METHOD = "hoshidicts.openSettings";
const READER_PREFERENCES_METHOD = "hoshidicts.readerPreferences";
const AUDIO_PROFILE_METHOD = "hoshidicts.audioProfile";
const ADD_CUSTOM_ENTRY_METHOD = "hoshidicts.addCustomEntry";
const REQUEST_TIMEOUT_MS = 5000;
const DEFAULT_HOSHIDICTS_ACTIVATION_KEY = constants.DEFAULT_ACTIVATION_KEY;
const HOSHIDICTS_ACTIVATION_HOTKEY_ID = "hoshidictsLookup";

function invalidPreferences() {
  return new Error("Hoshidicts reader preferences are invalid.");
}

function normalizeHoshidictsActivationKey(
  value,
  fallback = DEFAULT_HOSHIDICTS_ACTIVATION_KEY
) {
  return preferences.normalizeActivationKey(value, fallback);
}

function normalizeHoshidictsExternalUrl(value) {
  const url = preferences.normalizeExternalUrl(value);
  if (!url) {
    throw new Error("External link URL is invalid.");
  }
  return url;
}

/** The complete reader-preference schema, shared with the overlay renderer. */
function normalizeHoshidictsReaderPreferences(value) {
  const normalized = preferences.normalizeReaderPreferences(value);
  if (!normalized) {
    throw invalidPreferences();
  }
  return normalized;
}

function normalizeHoshidictsAudioProfile(profile) {
  const source = profile && typeof profile === "object"
    ? (profile.audioProfile || profile)
    : null;
  if (
    !source ||
    source.version !== 1 ||
    typeof source.autoPlay !== "boolean" ||
    !Array.isArray(source.sources) ||
    source.sources.length > LIMITS.audioSources ||
    !source.sources.every((entry) =>
      entry &&
      typeof entry.id === "string" &&
      entry.id.length > 0 &&
      entry.id.length <= LIMITS.audioSourceIdLength &&
      constants.AUDIO_SOURCE_TYPE_SET.has(entry.type) &&
      typeof entry.url === "string" &&
      entry.url.length <= LIMITS.audioUrlLength &&
      typeof entry.voice === "string" &&
      entry.voice.length <= LIMITS.audioVoiceLength
    )
  ) {
    throw new Error("Hoshidicts audio preferences are invalid.");
  }
  return {
    version: 1,
    autoPlay: source.autoPlay,
    sources: source.sources.map((entry) => ({
      id: entry.id,
      type: entry.type,
      url: entry.url,
      voice: entry.voice,
    })),
  };
}

function isWithinUtf8JsonLimit(value, maxBytes) {
  return Buffer.byteLength(JSON.stringify(value), "utf8") <= maxBytes + 2;
}

/** Trims and bounds one renderer-submitted custom dictionary entry. */
function normalizeHoshidictsCustomEntry(payload) {
  const text = (key) =>
    payload && typeof payload[key] === "string" ? payload[key].trim() : "";
  const entry = {
    term: text("term"),
    reading: text("reading"),
    definition: text("definition"),
  };
  if (!entry.term || !entry.reading || !entry.definition) {
    throw new Error("Term, reading, and definition are required.");
  }
  if (entry.term.startsWith("#")) {
    throw new Error("Custom dictionary terms cannot begin with #.");
  }
  if (
    !isWithinUtf8JsonLimit(entry.term, LIMITS.customEntryTermBytes) ||
    !isWithinUtf8JsonLimit(entry.reading, LIMITS.customEntryReadingBytes) ||
    !isWithinUtf8JsonLimit(entry.definition, LIMITS.customEntryDefinitionBytes)
  ) {
    throw new Error("Custom dictionary entry is too large.");
  }
  return entry;
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

/**
 * Connects the desktop control channel to one overlay window: validates every
 * incoming reader/audio preference once and queues it until the renderer is
 * ready to receive it.
 */
function createHoshidictsWindowBridge(options = {}) {
  const getWebContents = options.getWebContents;
  const requireWebContents = () => {
    const webContents = getWebContents();
    if (!webContents) {
      throw new Error("Hoshidicts reader window is unavailable.");
    }
    return webContents;
  };
  const deliveryFor = (channel) =>
    createHoshidictsReaderPreferencesDelivery((payload) => {
      requireWebContents().send(channel, payload);
    });
  const readerDelivery = deliveryFor("hoshidicts-reader-preferences");
  const audioDelivery = deliveryFor("hoshidicts-audio-preferences");
  const bridge = createHoshidictsReaderPreferencesBridge({
    env: options.env,
    onPreferences(value) {
      const normalized = normalizeHoshidictsReaderPreferences(value);
      requireWebContents();
      options.onReaderPreferences?.(normalized);
      readerDelivery.enqueue(normalized);
    },
    onAudioPreferences(value) {
      const profile = normalizeHoshidictsAudioProfile(value);
      requireWebContents();
      audioDelivery.enqueue(profile);
    },
  });

  return {
    destroy() {
      bridge.destroy();
      readerDelivery.clear();
      audioDelivery.clear();
    },
    markNotReady() {
      readerDelivery.markNotReady();
      audioDelivery.markNotReady();
    },
    markReady() {
      readerDelivery.markReady();
      audioDelivery.markReady();
    },
    requestAddCustomEntry(payload) {
      return bridge.requestAddCustomEntry(normalizeHoshidictsCustomEntry(payload));
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
  createHoshidictsActivationHotkeyController,
  createHoshidictsReaderPreferencesDelivery,
  createHoshidictsReaderPreferencesBridge,
  createHoshidictsWindowBridge,
  DEFAULT_HOSHIDICTS_ACTIVATION_KEY,
  dispatchAppHotkeyInputServerMessage,
  HOSHIDICTS_ACTIVATION_HOTKEY_ID,
  normalizeHoshidictsActivationKey,
  normalizeHoshidictsExternalUrl,
  normalizeHoshidictsReaderPreferences,
  requestHoshidictsSettingsOpen,
  resolveHoshidictsControlConfig,
};
