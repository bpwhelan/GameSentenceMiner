/*
 * Client side of sharing: this install uses another Hachidori, on this
 * computer or another one. Requests travel over one WebSocket to the relay
 * that host is connected to; the host's storage batches come back and the
 * caller mirrors them locally.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PROTOCOL_VERSION, parseHostFrame } from "./sharing-protocol.js";

export const SHARING_LOCAL_STATE_KEY = "sharingLocalState";
export const NOT_REACHABLE = "The linked Hachidori is not reachable.";
const CONNECT_WAIT_MS = 5000;

function describe(error) {
  return error instanceof Error ? error.message || String(error) : String(error);
}

// `applyBatch(changes)` writes one host storage batch locally; `version` and
// `name` introduce this install to the host.
export function createSharingClient({ WebSocket, applyBatch, version, name }) {
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

  function status() {
    return { linked: address !== null, address, connected: ready, host, error };
  }

  function sendHello(target) {
    target.send(JSON.stringify({ kind: "hello", protocol: PROTOCOL_VERSION, version, name }));
  }

  function settleWaiting(failure = null) {
    for (const waiter of waiting) {
      if (failure === null) waiter.ready();
      else waiter.fail(failure);
    }
    waiting.clear();
  }

  function rejectPending(failure) {
    for (const entry of pending.values()) entry.reject(failure);
    pending.clear();
  }

  function scheduleRetry() {
    if (address === null || retryTimer !== null) return;
    const delay = Math.min(10_000, 500 * 2 ** Math.min(attempt, 5));
    attempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, delay);
  }

  async function handleFrame(current, text) {
    let frame;
    try {
      frame = parseHostFrame(text);
    } catch (parseError) {
      console.warn("hachidori: dropped a sharing frame:", describe(parseError));
      return;
    }
    switch (frame.kind) {
      case "hello":
        host = { version: frame.version, name: frame.name, dictionaryCount: frame.dictionaryCount };
        await applyBatch(frame.snapshot);
        if (socket !== current) return;
        ready = true;
        error = null;
        attempt = 0;
        settleWaiting();
        return;
      case "reply": {
        const entry = pending.get(frame.id);
        if (entry === undefined) return;
        pending.delete(frame.id);
        entry.resolve(frame.response);
        return;
      }
      case "storage":
        await applyBatch(frame.changes);
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
    next.onmessage = (event) => { void handleFrame(next, String(event.data)); };
    next.onclose = () => {
      if (socket !== next) return;
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
  function forward(message) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const send = () => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ kind: "request", id, message }));
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
            finish(() => resolve({ version: frame.version, name: frame.name, dictionaryCount: frame.dictionaryCount, snapshot: frame.snapshot }));
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
