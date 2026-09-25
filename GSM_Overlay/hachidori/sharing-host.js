/*
 * Host side of sharing: one outbound WebSocket to the relay the Anki add-on
 * runs, the browsers linked through it, and the storage batches pushed to
 * them. Requests arrive as ordinary runtime messages and are answered by the
 * service worker's own handlers.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
  DEFAULT_SHARING_PORT, PROTOCOL_VERSION, SHARING_CAPABILITIES, formatHostAddress, parseClientFrame,
} from "./sharing-protocol.js";

export const SHARING_KEY = "sharing";
export const SHARING_HOST_ALARM = "hachidori-sharing-host";

const LOOPBACK_PEERS = new Set(["127.0.0.1", "::1"]);

function describe(error) {
  return error instanceof Error ? error.message || String(error) : String(error);
}

function relayAddresses(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.map(entry => ({ address: String(entry?.address ?? ""), kind: entry?.kind === "tailscale" ? "tailscale" : "local" }))
    .filter(entry => entry.address !== "");
}

// `dispatch(message, clientId, capabilities)` answers a forwarded request
// with the same reply object a runtime sender would receive. `readSnapshot()`
// returns the shared storage keys as stored. `sharedKey(key)` says whether a
// storage change belongs to the mirror. `name` is what linked browsers call
// this one.
export function createSharingHost({
  WebSocket, alarms, dispatch, readSnapshot, sharedKey, version, name, capabilities = SHARING_CAPABILITIES,
}) {
  const clients = new Map();
  let enabled = false;
  let configuredPort = DEFAULT_SHARING_PORT;
  // The preference, and what the relay last confirmed.
  let network = false;
  let networkState = { active: false, addresses: [], error: null };
  let dictionaries = 0;
  let socket = null;
  let listeningPort = null;
  let error = null;
  let attempt = 0;
  let retryTimer = null;

  function status() {
    const connected = socket !== null && listeningPort !== null;
    return {
      enabled,
      connected,
      port: listeningPort ?? configuredPort,
      dictionaries,
      error,
      network: { enabled: network, active: connected && networkState.active, addresses: connected ? networkState.addresses : [], error: networkState.error },
      clients: [...clients.values()],
    };
  }

  function postTo(target, frame) {
    if (socket !== target || target.readyState !== 1) return false;
    try {
      target.send(JSON.stringify(frame));
      return true;
    } catch (sendError) {
      console.warn("hachidori: could not reach the sharing relay:", describe(sendError));
      return false;
    }
  }

  function post(frame) {
    if (socket !== null) postTo(socket, frame);
  }

  function sendTo(target, clientId, client, frame) {
    if (clients.get(clientId) !== client) return false;
    return postTo(target, { kind: "send", clientId, text: JSON.stringify(frame) });
  }

  async function handleClientText(target, clientId, text) {
    const client = clients.get(clientId);
    if (socket !== target || client === undefined) return;
    let frame;
    try {
      frame = parseClientFrame(text);
    } catch (parseError) {
      if (sendTo(target, clientId, client, { kind: "bye", reason: describe(parseError) })) {
        postTo(target, { kind: "close", clientId });
      }
      return;
    }
    if (frame.kind === "hello") {
      Object.assign(client, { name: frame.name, version: frame.version, capabilities: frame.capabilities });
      const snapshot = await readSnapshot();
      const dictionaryCount = Array.isArray(snapshot.dictionaryState?.dictionaries) ? snapshot.dictionaryState.dictionaries.length : 0;
      sendTo(target, clientId, client,
        { kind: "hello", protocol: PROTOCOL_VERSION, version, name, dictionaryCount, capabilities, snapshot });
      return;
    }
    if (frame.kind === "request") {
      const response = await dispatch(frame.message, clientId, [...client.capabilities]);
      sendTo(target, clientId, client, { kind: "reply", id: frame.id, response });
    }
  }

  function onRelayMessage(target, text) {
    if (socket !== target) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      console.warn("hachidori: dropped an unreadable relay message");
      return;
    }
    switch (message?.kind) {
      case "listening":
        listeningPort = Number(message.port) || configuredPort;
        error = null;
        attempt = 0;
        alarms.clear(SHARING_HOST_ALARM);
        if (network) post({ kind: "network", enabled: true });
        return;
      case "listen-failed":
        error = String(message.error ?? "The relay refused this Hachidori.");
        return;
      case "network":
        networkState = { active: message.enabled === true, addresses: relayAddresses(message.addresses),
          error: typeof message.error === "string" ? message.error : null };
        return;
      case "client-open": {
        const address = String(message.address ?? "");
        clients.set(message.clientId, { id: message.clientId, origin: String(message.origin ?? ""), address, local: LOOPBACK_PEERS.has(address),
          name: "", version: "", capabilities: [], connectedAt: Date.now() });
        return;
      }
      case "client-close":
        clients.delete(message.clientId);
        return;
      case "client-text":
        void handleClientText(target, message.clientId, String(message.text));
        return;
      case "ping":
        return;
      default:
        console.warn("hachidori: unknown sharing relay message", message?.kind);
    }
  }

  // While the relay is away, retry quickly for as long as this worker lives and
  // once a minute through the alarm after Chrome has put it to sleep.
  function scheduleRetry() {
    if (!enabled || retryTimer !== null) return;
    const delay = Math.min(10_000, 500 * 2 ** Math.min(attempt, 5));
    attempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, delay);
    alarms.create(SHARING_HOST_ALARM, { delayInMinutes: 1 });
  }

  // Sharing waits for something to share: an empty install must not take the
  // host slot ahead of the browser that has the dictionaries.
  function connect() {
    if (!enabled || socket !== null || dictionaries === 0) return;
    let next;
    try {
      next = new WebSocket(formatHostAddress({ port: configuredPort }));
    } catch (connectError) {
      error = describe(connectError);
      scheduleRetry();
      return;
    }
    socket = next;
    listeningPort = null;
    next.onmessage = (event) => onRelayMessage(next, String(event.data));
    next.onclose = () => {
      if (socket !== next) return;
      socket = null;
      listeningPort = null;
      networkState = { active: false, addresses: [], error: null };
      clients.clear();
      if (enabled) scheduleRetry();
    };
  }

  function dropSocket() {
    const previous = socket;
    socket = null;
    listeningPort = null;
    networkState = { active: false, addresses: [], error: null };
    clients.clear();
    previous?.close();
  }

  return {
    status,
    // A changed port reconnects; a changed network preference alone is told to
    // the relay over the open socket.
    enable({ port = DEFAULT_SHARING_PORT, network: wantNetwork = false, dictionaries: count = dictionaries } = {}) {
      const nextPort = Number(port) || DEFAULT_SHARING_PORT;
      const reconnect = !enabled || socket === null || nextPort !== configuredPort;
      enabled = true;
      configuredPort = nextPort;
      dictionaries = Number(count) || 0;
      network = wantNetwork === true;
      if (reconnect) {
        error = null;
        attempt = 0;
        dropSocket();
        connect();
      } else if (listeningPort !== null) {
        post({ kind: "network", enabled: network });
      }
    },
    setDictionaries(count) {
      dictionaries = Number(count) || 0;
      if (enabled && socket === null && retryTimer === null) connect();
    },
    disable() {
      enabled = false;
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
      alarms.clear(SHARING_HOST_ALARM);
      dropSocket();
      error = null;
    },
    // The alarm and worker restarts land here.
    reconnect() {
      if (enabled && socket === null && retryTimer === null) connect();
    },
    storageChanged(changes, area) {
      if (area !== "local" || socket === null || clients.size === 0) return;
      const shared = Object.entries(changes).filter(([key]) => sharedKey(key));
      if (shared.length === 0) return;
      post({ kind: "broadcast", text: JSON.stringify({
        kind: "storage", changes: Object.fromEntries(shared.map(([key, change]) => [key, change.newValue ?? null])),
      }) });
    },
  };
}
