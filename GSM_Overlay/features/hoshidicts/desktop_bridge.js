"use strict";

const { randomUUID } = require("node:crypto");
const WebSocket = require("ws");

const BUS_PROTOCOL_VERSION = 1;
const OPEN_SETTINGS_TOPIC = "hoshidicts.openSettings";
const READER_PREFERENCES_TOPIC = "hoshidicts.readerPreferences";
const AUDIO_PROFILE_TOPIC = "hoshidicts.audioProfile";
const READER_CLIENT_SUFFIX = ".hoshidicts-reader";
const SETTINGS_CLIENT_SEGMENT = ".hoshidicts-settings.";
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

function normalizeHoshidictsActivationKey(
  value,
  fallback = DEFAULT_HOSHIDICTS_ACTIVATION_KEY
) {
  if (typeof value !== "string") {
    return fallback;
  }
  const token = value.trim();
  if (HOSHIDICTS_PUNCTUATION_ACTIVATION_KEYS.has(token)) {
    return token;
  }
  if (/^[a-z]$/iu.test(token)) {
    return token.toUpperCase();
  }
  if (/^[0-9]$/u.test(token)) {
    return token;
  }
  const functionKeyMatch = /^f([1-9]|1[0-9]|2[0-4])$/iu.exec(token);
  if (functionKeyMatch) {
    return `F${functionKeyMatch[1]}`;
  }
  return HOSHIDICTS_NAMED_ACTIVATION_KEYS.get(token.toLowerCase()) ?? fallback;
}

function normalizeHoshidictsReaderPreferences(preferences) {
  const lookupMode = preferences && preferences.lookupMode;
  const requestedActivationKey = preferences && preferences.activationKey;
  const activationKey = requestedActivationKey === undefined
    ? DEFAULT_HOSHIDICTS_ACTIVATION_KEY
    : normalizeHoshidictsActivationKey(requestedActivationKey, null);
  const sourceHighlightEnabled =
    preferences && preferences.sourceHighlightEnabled;
  const popupHideDelayMs = preferences && preferences.popupHideDelayMs;
  if (
    (lookupMode !== "shift" && lookupMode !== "hover") ||
    activationKey === null ||
    typeof sourceHighlightEnabled !== "boolean" ||
    !Number.isInteger(popupHideDelayMs) ||
    popupHideDelayMs < 0 ||
    popupHideDelayMs > 5000
  ) {
    throw new Error("Hoshidicts reader preferences are invalid.");
  }
  return {
    lookupMode,
    activationKey,
    sourceHighlightEnabled,
    popupHideDelayMs,
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

function resolveDesktopBusConfig(env = process.env) {
  const port = Number.parseInt(env.GSM_BROKER_PORT || "", 10);
  const token = String(env.GSM_BROKER_TOKEN || "").trim();
  const clientId = String(env.GSM_CLIENT_ID || "overlay").trim();
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !token || !clientId) {
    return null;
  }
  return { port, token, clientId };
}

function envelope(clientId, kind, topic, data) {
  return {
    v: BUS_PROTOCOL_VERSION,
    id: randomUUID(),
    src: clientId,
    dst: "main",
    kind,
    topic,
    ...(data === undefined ? {} : { data }),
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
  const config = resolveDesktopBusConfig(options.env);
  if (!config) {
    return { destroy() {} };
  }
  const WebSocketImpl = options.WebSocketImpl || WebSocket;
  const requestHandlers = new Map([
    [
      READER_PREFERENCES_TOPIC,
      typeof options.onPreferences === "function"
        ? options.onPreferences
        : async () => undefined,
    ],
    [
      AUDIO_PROFILE_TOPIC,
      typeof options.onAudioPreferences === "function"
        ? options.onAudioPreferences
        : async () => undefined,
    ],
  ]);
  const readerClientId = `${config.clientId}${READER_CLIENT_SUFFIX}`;
  let socket = null;
  let reconnectTimer = null;
  let reconnectDelayMs = 750;
  let destroyed = false;

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

  function respond(message, ok, data, error) {
    send({
      v: BUS_PROTOCOL_VERSION,
      id: randomUUID(),
      src: readerClientId,
      dst: message.src,
      kind: "response",
      topic: message.topic,
      corr: message.id,
      ok,
      ...(data === undefined ? {} : { data }),
      ...(error ? { error } : {}),
    });
  }

  function connect() {
    if (destroyed || (socket && socket.readyState <= WebSocketImpl.OPEN)) return;
    const nextSocket = new WebSocketImpl(`ws://127.0.0.1:${config.port}`);
    socket = nextSocket;
    nextSocket.on("open", () => {
      send(envelope(readerClientId, "hello", "bus.hello", {
        token: config.token,
        pid: process.pid,
        version: "1",
      }));
    });
    nextSocket.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (message.kind === "ack" && message.topic === "bus.welcome") {
        reconnectDelayMs = 750;
        return;
      }
      const apply = requestHandlers.get(message.topic);
      if (message.kind !== "request" || !apply) {
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
      scheduleReconnect();
    });
  }

  connect();
  return {
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
    },
  };
}

function requestHoshidictsSettingsOpen(options = {}) {
  const config = resolveDesktopBusConfig(options.env);
  if (!config) {
    return Promise.reject(
      new Error("GameSentenceMiner desktop control channel is unavailable.")
    );
  }

  const WebSocketImpl = options.WebSocketImpl || WebSocket;
  return new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(`ws://127.0.0.1:${config.port}`);
    const requestClientId =
      `${config.clientId}${SETTINGS_CLIENT_SEGMENT}${process.pid}.${randomUUID()}`;
    let settled = false;
    let requestId = null;
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
      const hello = envelope(requestClientId, "hello", "bus.hello", {
        token: config.token,
        pid: process.pid,
        version: "1",
      });
      socket.send(JSON.stringify(hello));
    });

    socket.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        finish(new Error("Desktop control channel returned invalid JSON."));
        return;
      }

      if (message.kind === "ack" && message.topic === "bus.welcome") {
        const request = envelope(
          requestClientId,
          "request",
          OPEN_SETTINGS_TOPIC
        );
        requestId = request.id;
        socket.send(JSON.stringify(request));
        return;
      }

      if (
        requestId &&
        message.kind === "response" &&
        message.corr === requestId
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
  AUDIO_PROFILE_TOPIC,
  createHoshidictsActivationHotkeyController,
  createHoshidictsReaderPreferencesDelivery,
  createHoshidictsReaderPreferencesBridge,
  DEFAULT_HOSHIDICTS_ACTIVATION_KEY,
  dispatchAppHotkeyInputServerMessage,
  HOSHIDICTS_ACTIVATION_HOTKEY_ID,
  normalizeHoshidictsActivationKey,
  normalizeHoshidictsReaderPreferences,
  OPEN_SETTINGS_TOPIC,
  READER_CLIENT_SUFFIX,
  READER_PREFERENCES_TOPIC,
  SETTINGS_CLIENT_SEGMENT,
  requestHoshidictsSettingsOpen,
  resolveDesktopBusConfig,
};
