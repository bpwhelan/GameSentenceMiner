/*
 * Host side of sharing: one outbound WebSocket to the relay the Anki add-on
 * runs, the browsers linked through it, and the storage batches pushed to
 * them. Requests arrive as ordinary runtime messages and are answered by the
 * service worker's own handlers.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describeError } from "./error-text.js";
import {
  DEFAULT_SHARING_PORT, PROTOCOL_VERSION, SHARING_CAPABILITIES, formatHostAddress, parseClientFrame,
} from "./sharing-protocol.js";

export const SHARING_KEY = "sharing";
export const SHARING_HOST_ALARM = "hachidori-sharing-host";

const LOOPBACK_PEERS = new Set(["127.0.0.1", "::1"]);

function relayAddresses(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.map(entry => ({ address: String(entry?.address ?? ""), kind: entry?.kind === "tailscale" ? "tailscale" : "local" }))
    .filter(entry => entry.address !== "");
}

// `dispatch(message, clientId, capabilities)` answers a forwarded request
// with the same reply object a runtime sender would receive. `readSnapshot()`
// returns the shared storage keys as stored. `sharedKey(key)` says whether a
// storage change belongs to the mirror. `name` is what linked browsers call
// this one. `clientClosed(clientId)` hears every client the relay or this host
// drops.
//
// `languages`, when given, decides what each connection receives once the
// records have profiles (docs/languages.md 17.3): `hello(snapshot, connection)`
// returns `{ snapshot, capabilities }` for its hello, or null for today's;
// `request(message, connection)` returns `{ message }` to dispatch or
// `{ response }` to answer, with `optIn: true` when the connection's held
// change frames go out after it; `reply(response, message, connection)`
// returns what the connection receives; `storageChanged(changes,
// connections)` returns null for today's broadcast, or
// `frame(connection, values)`, which gives the changes one connection
// receives, null for none. A connection is `{ id, client, running, closing,
// queue }` plus what the hooks keep on it; one that the hooks mark `closing`
// gets no change frames and is closed once its running requests have been
// answered.
export function createSharingHost({
  WebSocket, alarms, dispatch, readSnapshot, sharedKey, version, name, capabilities = SHARING_CAPABILITIES,
  clientClosed = () => {}, languages = null,
}) {
  const clients = new Map();
  // Per client: its requests running, whether it must reconnect, the change
  // frames held for it while its opt-in is answered, and the hooks' state.
  // Kept apart from `clients`, whose entries the status reports.
  const connections = new Map();
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
      console.warn("hachidori: could not reach the sharing relay:", describeError(sendError));
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

  // A connection marked closing goes once nothing it asked is still running.
  function closeIfDone(connection) {
    if (!connection.closing || connection.closed || connection.running > 0 || socket === null) return;
    connection.closed = true;
    postTo(socket, { kind: "close", clientId: connection.id });
  }

  function flushHeld(target, connection) {
    const held = connection.queue;
    connection.queue = null;
    for (const frame of held ?? []) {
      if (connection.closing) break;
      sendTo(target, connection.id, connection.client, frame);
    }
  }

  async function answerRequest(target, clientId, client, connection, frame) {
    connection.running += 1;
    let response;
    let optIn = false;
    try {
      const handled = languages === null ? { message: frame.message } : await languages.request(frame.message, connection);
      if (Object.hasOwn(handled, "response")) {
        response = handled.response;
        optIn = handled.optIn === true;
      } else {
        response = await dispatch(handled.message, clientId, [...client.capabilities]);
        if (languages !== null) response = languages.reply(response, handled.message, connection);
      }
    } catch (requestError) {
      response = { type: `${frame.message.type}_result`, requestId: frame.message.requestId ?? null, ok: false,
        error: describeError(requestError) };
    } finally {
      connection.running -= 1;
    }
    sendTo(target, clientId, client, { kind: "reply", id: frame.id, response });
    if (optIn) flushHeld(target, connection);
    closeIfDone(connection);
  }

  async function handleClientText(target, clientId, text) {
    const client = clients.get(clientId);
    if (socket !== target || client === undefined) return;
    let frame;
    try {
      frame = parseClientFrame(text);
    } catch (parseError) {
      if (sendTo(target, clientId, client, { kind: "bye", reason: describeError(parseError) })) {
        postTo(target, { kind: "close", clientId });
      }
      return;
    }
    const connection = connections.get(clientId);
    if (frame.kind === "hello") {
      Object.assign(client, { name: frame.name, version: frame.version, capabilities: frame.capabilities });
      const stored = await readSnapshot();
      const offered = languages?.hello(stored, connection) ?? null;
      const snapshot = offered === null ? stored : offered.snapshot;
      const dictionaryCount = Array.isArray(snapshot.dictionaryState?.dictionaries) ? snapshot.dictionaryState.dictionaries.length : 0;
      sendTo(target, clientId, client, { kind: "hello", protocol: PROTOCOL_VERSION, version, name, dictionaryCount,
        capabilities: offered === null ? capabilities : offered.capabilities, snapshot });
      return;
    }
    if (frame.kind === "request") await answerRequest(target, clientId, client, connection, frame);
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
        const client = { id: message.clientId, origin: String(message.origin ?? ""), address, local: LOOPBACK_PEERS.has(address),
          name: "", version: "", capabilities: [], connectedAt: Date.now() };
        clients.set(message.clientId, client);
        connections.set(message.clientId, { id: message.clientId, client, running: 0, closing: false, closed: false, queue: null });
        return;
      }
      case "client-close":
        connections.delete(message.clientId);
        if (clients.delete(message.clientId)) clientClosed(message.clientId);
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
      error = describeError(connectError);
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
      clearClients();
      if (enabled) scheduleRetry();
    };
  }

  function clearClients() {
    const closed = [...clients.keys()];
    clients.clear();
    connections.clear();
    for (const clientId of closed) clientClosed(clientId);
  }

  function dropSocket() {
    const previous = socket;
    socket = null;
    listeningPort = null;
    networkState = { active: false, addresses: [], error: null };
    clearClients();
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
      if (area !== "local") return;
      const shared = Object.entries(changes).filter(([key]) => sharedKey(key));
      if (shared.length === 0) return;
      // The hooks follow every commit, connected or not.
      const plan = languages?.storageChanged(Object.fromEntries(shared), [...connections.values()]) ?? null;
      if (socket === null || clients.size === 0) return;
      const values = Object.fromEntries(shared.map(([key, change]) => [key, change.newValue ?? null]));
      if (plan === null) {
        post({ kind: "broadcast", text: JSON.stringify({ kind: "storage", changes: values }) });
        return;
      }
      // With profiles each connection gets its own frame (docs/languages.md 17.3).
      for (const connection of connections.values()) {
        if (connection.closing) {
          closeIfDone(connection);
          continue;
        }
        const projected = plan.frame(connection, values);
        if (projected === null) continue;
        const frame = { kind: "storage", changes: projected };
        if (connection.queue !== null) connection.queue.push(frame);
        else sendTo(socket, connection.id, connection.client, frame);
      }
    },
    // The Anki duplicate index is derived state the host owns and never mirrors.
    // Its row revision, or null after a Template source change, still travels
    // to linked browsers so their pages can re-read word status (#520).
    wordStatusChanged(revision) {
      if (socket === null || clients.size === 0) return;
      post({ kind: "broadcast", text: JSON.stringify({ kind: "word-status", revision }) });
    },
  };
}
