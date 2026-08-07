"use strict";

const { randomUUID } = require("node:crypto");
const WebSocket = require("ws");

const BUS_PROTOCOL_VERSION = 1;
const OPEN_SETTINGS_TOPIC = "hoshidicts.openSettings";
const READER_PREFERENCES_TOPIC = "hoshidicts.readerPreferences";
const READER_CLIENT_SUFFIX = ".hoshidicts-reader";
const SETTINGS_CLIENT_SEGMENT = ".hoshidicts-settings.";
const REQUEST_TIMEOUT_MS = 5000;

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
  let pending = null;

  return {
    enqueue(preferences) {
      if (!ready) {
        pending = preferences;
        return false;
      }
      deliver(preferences);
      return true;
    },
    markReady() {
      ready = true;
      if (pending === null) return false;
      const preferences = pending;
      deliver(preferences);
      pending = null;
      return true;
    },
    markNotReady() {
      ready = false;
    },
    clear() {
      ready = false;
      pending = null;
    },
  };
}

function createHoshidictsReaderPreferencesBridge(options = {}) {
  const config = resolveDesktopBusConfig(options.env);
  if (!config) {
    return { destroy() {} };
  }
  const WebSocketImpl = options.WebSocketImpl || WebSocket;
  const onPreferences =
    typeof options.onPreferences === "function"
      ? options.onPreferences
      : async () => undefined;
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
      send({
        ...envelope(readerClientId, "hello", "bus.hello", {
          token: config.token,
          pid: process.pid,
          version: "1",
        }),
        src: readerClientId,
      });
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
      if (
        message.kind !== "request" ||
        message.topic !== READER_PREFERENCES_TOPIC
      ) {
        return;
      }
      Promise.resolve(onPreferences(message.data)).then(
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
  createHoshidictsReaderPreferencesDelivery,
  createHoshidictsReaderPreferencesBridge,
  OPEN_SETTINGS_TOPIC,
  READER_CLIENT_SUFFIX,
  READER_PREFERENCES_TOPIC,
  SETTINGS_CLIENT_SEGMENT,
  requestHoshidictsSettingsOpen,
  resolveDesktopBusConfig,
};
