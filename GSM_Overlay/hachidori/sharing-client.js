/*
 * Client side of sharing: this install uses another Hachidori, on this
 * computer or another one. Requests travel over one WebSocket to the relay
 * that host is connected to; the host's storage batches come back and the
 * caller mirrors them locally.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
  LINKED_ANKI_UNSUPPORTED, PROTOCOL_VERSION, SHARING_CAPABILITIES, assertLinkedAnkiFrame, parseHostFrame,
} from "./sharing-protocol.js";

export const SHARING_LOCAL_STATE_KEY = "sharingLocalState";
export const NOT_REACHABLE = "The linked Hachidori is not reachable.";
export const OUTCOME_UNKNOWN = "The linked Hachidori may have completed this change. Check its state before trying again.";
const CONNECT_WAIT_MS = 5000;

function describe(error) {
  return error instanceof Error ? error.message || String(error) : String(error);
}

function requestFailure(failure, entry) {
  if (!entry.sent || !entry.mutation) return failure;
  const unknown = new Error(OUTCOME_UNKNOWN);
  unknown.outcomeUnknown = true;
  return unknown;
}

// `applyBatch(changes, isCurrent, snapshot)` writes one host storage batch locally, checking
// isCurrent inside its storage queue; `version` and `name` introduce this install.
export function createSharingClient({ WebSocket, applyBatch, version, name, capabilities = SHARING_CAPABILITIES }) {
  const pending = new Map();
  const waiting = new Set();
  let address = null;
  let socket = null;
  let ready = false;
  let host = null;
  let error = null;
  let attempt = 0;
  let retryTimer = null;
  let nextId = 0;
  let linkGeneration = 0;

  function status() {
    return { linked: address !== null, address, connected: ready, host, error };
  }

  function sendHello(target) {
    target.send(JSON.stringify({ kind: "hello", protocol: PROTOCOL_VERSION, version, name, capabilities }));
  }

  function settleWaiting(failure = null) {
    for (const waiter of waiting) {
      if (failure === null && waiter.generation === linkGeneration) waiter.ready();
      else waiter.fail(failure ?? new Error(NOT_REACHABLE));
    }
    waiting.clear();
  }

  function rejectPending(failure) {
    for (const entry of pending.values()) entry.reject(requestFailure(failure, entry));
    pending.clear();
  }

  function scheduleRetry() {
    if (address === null || retryTimer !== null) return;
    const retryGeneration = linkGeneration;
    const delay = Math.min(10_000, 500 * 2 ** Math.min(attempt, 5));
    attempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (retryGeneration !== linkGeneration) return;
      connect();
    }, delay);
  }

  async function handleFrame(current, currentGeneration, text) {
    if (socket !== current || linkGeneration !== currentGeneration) return;
    let frame;
    try {
      frame = parseHostFrame(text);
    } catch (parseError) {
      console.warn("hachidori: dropped a sharing frame:", describe(parseError));
      return;
    }
    switch (frame.kind) {
      case "hello":
        host = { version: frame.version, name: frame.name, dictionaryCount: frame.dictionaryCount,
          capabilities: frame.capabilities };
        await applyBatch(frame.snapshot,
          () => socket === current && linkGeneration === currentGeneration, true);
        if (socket !== current || linkGeneration !== currentGeneration) return;
        ready = true;
        error = null;
        attempt = 0;
        settleWaiting();
        return;
      case "reply": {
        const entry = pending.get(frame.id);
        if (entry === undefined || entry.generation !== currentGeneration) return;
        pending.delete(frame.id);
        entry.resolve(frame.response);
        return;
      }
      case "storage":
        await applyBatch(frame.changes,
          () => socket === current && linkGeneration === currentGeneration);
        return;
      case "ping":
        current.send(JSON.stringify({ kind: "pong" }));
        return;
      case "bye":
        error = frame.reason || "The linked Hachidori refused the connection.";
        current.close();
        return;
      default:
    }
  }

  function connect() {
    if (address === null || socket !== null) return;
    const currentGeneration = linkGeneration;
    let next;
    try {
      next = new WebSocket(address);
    } catch (connectError) {
      error = describe(connectError);
      settleWaiting(new Error(NOT_REACHABLE));
      scheduleRetry();
      return;
    }
    socket = next;
    next.onopen = () => sendHello(next);
    next.onmessage = (event) => { void handleFrame(next, currentGeneration, String(event.data)); };
    next.onclose = () => {
      if (socket !== next || linkGeneration !== currentGeneration) return;
      socket = null;
      ready = false;
      host = null;
      const failure = new Error(NOT_REACHABLE);
      rejectPending(failure);
      settleWaiting(failure);
      if (address === null) return;
      if (error === null) error = NOT_REACHABLE;
      scheduleRetry();
    };
  }

  // A request made while disconnected waits for one connection attempt; a
  // request in flight has no deadline, because a forwarded install can take
  // minutes and the socket closing rejects it anyway.
  function forward(message, { capability = null, mutation = false, onSent = null } = {}) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const requestGeneration = linkGeneration;
      const send = () => {
        if (requestGeneration !== linkGeneration || !ready || socket === null) {
          reject(new Error(NOT_REACHABLE));
          return;
        }
        if (capability !== null && !host?.capabilities.includes(capability)) {
          reject(new Error(LINKED_ANKI_UNSUPPORTED));
          return;
        }
        const text = JSON.stringify({ kind: "request", id, message });
        if (message?.target === "hachidori-anki" && message.type === "hd_anki_submit") {
          try {
            assertLinkedAnkiFrame(text);
          } catch (error) {
            reject(error);
            return;
          }
        }
        const entry = {
          generation: requestGeneration, mutation, resolve, reject, sent: false,
        };
        pending.set(id, entry);
        try {
          socket.send(text);
          entry.sent = true;
          onSent?.();
        } catch (error) {
          pending.delete(id);
          reject(requestFailure(error, entry));
        }
      };
      if (ready) {
        send();
        return;
      }
      if (address === null) {
        reject(new Error(NOT_REACHABLE));
        return;
      }
      const waiter = {
        generation: requestGeneration,
        ready: () => { clearTimeout(timer); send(); },
        fail: (failure) => { clearTimeout(timer); reject(failure); },
      };
      const timer = setTimeout(() => {
        waiting.delete(waiter);
        reject(new Error(NOT_REACHABLE));
      }, CONNECT_WAIT_MS);
      waiting.add(waiter);
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      connect();
    });
  }

  // One short connection that reports what answers at an address.
  function probe(target) {
    return new Promise((resolve, reject) => {
      let probeSocket;
      try {
        probeSocket = new WebSocket(target);
      } catch (connectError) {
        reject(new Error(`No shared Hachidori answered at ${target}: ${describe(connectError)}`));
        return;
      }
      let settled = false;
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
        probeSocket.close();
      };
      const timer = setTimeout(() => finish(() => reject(new Error(`No shared Hachidori answered at ${target}.`))), CONNECT_WAIT_MS);
      probeSocket.onopen = () => sendHello(probeSocket);
      probeSocket.onmessage = (event) => {
        try {
          const frame = parseHostFrame(String(event.data));
          if (frame.kind === "hello") {
            finish(() => resolve({ version: frame.version, name: frame.name, dictionaryCount: frame.dictionaryCount,
              capabilities: frame.capabilities, snapshot: frame.snapshot }));
          } else if (frame.kind === "bye") {
            finish(() => reject(new Error(frame.reason || "The shared Hachidori refused the connection.")));
          }
        } catch (parseError) {
          finish(() => reject(parseError));
        }
      };
      probeSocket.onclose = () => finish(() => reject(new Error(`No shared Hachidori answered at ${target}.`)));
    });
  }

  return {
    status,
    probe,
    forward,
    link(next) {
      linkGeneration += 1;
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
      const failure = new Error(NOT_REACHABLE);
      rejectPending(failure);
      settleWaiting(failure);
      address = next;
      error = null;
      attempt = 0;
      const previous = socket;
      socket = null;
      ready = false;
      host = null;
      previous?.close();
      connect();
    },
    unlink() {
      linkGeneration += 1;
      address = null;
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
      const previous = socket;
      socket = null;
      ready = false;
      host = null;
      error = null;
      const failure = new Error(NOT_REACHABLE);
      rejectPending(failure);
      settleWaiting(failure);
      previous?.close();
    },
  };
}
