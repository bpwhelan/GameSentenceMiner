/*
 * Client side of sharing: this install uses another Hachidori, on this
 * computer or another one. Requests travel over one WebSocket to the relay
 * that host is connected to; the host's storage batches come back and the
 * caller mirrors them locally.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describeError } from "./error-text.js";
import {
  LANGUAGE_PROFILES_CAPABILITY, LANGUAGE_PROFILES_OPT_IN, LINKED_ANKI_UNSUPPORTED, PROTOCOL_VERSION, SHARING_CAPABILITIES,
  assertLinkedAnkiFrame, parseHostFrame,
} from "./sharing-protocol.js";

export const SHARING_LOCAL_STATE_KEY = "sharingLocalState";
export const NOT_REACHABLE = "The linked Hachidori is not reachable.";
export const OUTCOME_UNKNOWN = "The linked Hachidori may have completed this change. Check its state before trying again.";
const CONNECT_WAIT_MS = 5000;
const OPT_IN_FAILED = "The linked Hachidori did not answer the language opt-in.";

function requestFailure(failure, entry) {
  if (!entry.sent || !entry.mutation) return failure;
  const unknown = new Error(OUTCOME_UNKNOWN);
  unknown.outcomeUnknown = true;
  return unknown;
}

// The opt-in request a profile-aware client sends a host whose hello has the
// capability, with its pack codes (docs/languages.md 17.3 item 2).
function optInFrame(id, languages) {
  return JSON.stringify({ kind: "request", id, message: {
    target: "hoshidicts-worker", type: LANGUAGE_PROFILES_OPT_IN, requestId: `language-profiles-${id}`, languages } });
}

// What the opt-in reply says, or null when it says nothing usable.
function optInOutcome(response) {
  const snapshot = response?.snapshot;
  if (response?.ok !== true || !["accepted", "refused"].includes(response.optIn)
      || !snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const codes = value => (Array.isArray(value) ? value.filter(code => typeof code === "string") : []);
  return { snapshot, languageProfiles: { capability: true, optIn: response.optIn,
    missingLanguages: codes(response.missingLanguages), hostLanguages: codes(response.hostLanguages) } };
}

// `applyBatch(changes, isCurrent, snapshot)` writes one host storage batch locally, checking
// isCurrent inside its storage queue; `version` and `name` introduce this install.
// `onWordStatus(revision)` hears the host's Anki index revision, and null
// whenever the host's index starts or stops answering this browser.
// `languages()` gives this build's pack codes, or null for a client that
// does not opt in to a host's profiles.
export function createSharingClient({
  WebSocket, applyBatch, version, name, capabilities = SHARING_CAPABILITIES, onWordStatus = () => {}, languages = () => null,
}) {
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
  // The opt-in of the current connection while unanswered, and what the host
  // said about its profiles; null for a host whose hello lacks the capability.
  let optIn = null;
  let languageProfiles = null;

  function status() {
    return { linked: address !== null, address, connected: ready, host, error,
      ...(languageProfiles === null ? {} : { languageProfiles }) };
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

  // The connection is ready once its snapshot is stored: the hello's, or for a
  // client that opted in, the opt-in reply's.
  async function adoptSnapshot(current, currentGeneration, snapshot) {
    await applyBatch(snapshot, () => socket === current && linkGeneration === currentGeneration, true);
    if (socket !== current || linkGeneration !== currentGeneration) return;
    ready = true;
    error = null;
    attempt = 0;
    settleWaiting();
    // Word-status frames sent while this browser was away are lost, and
    // this host's revisions do not continue the index that answered before.
    onWordStatus(null);
  }

  // A host with profiles: opt in before storing anything, so this
  // browser's pages never adopt the Japanese view first.
  async function handleHello(current, currentGeneration, frame) {
    host = { version: frame.version, name: frame.name, dictionaryCount: frame.dictionaryCount,
      capabilities: frame.capabilities };
    const codes = frame.capabilities.includes(LANGUAGE_PROFILES_CAPABILITY) ? languages() : null;
    if (codes !== null) {
      languageProfiles = { capability: true, optIn: null, missingLanguages: [], hostLanguages: [] };
      optIn = { id: ++nextId };
      current.send(optInFrame(optIn.id, codes));
      return;
    }
    languageProfiles = null;
    await adoptSnapshot(current, currentGeneration, frame.snapshot);
  }

  // The opt-in's reply, or a request's.
  async function handleReply(current, currentGeneration, frame) {
    if (optIn !== null && frame.id === optIn.id) {
      optIn = null;
      const outcome = optInOutcome(frame.response);
      if (outcome === null) {
        // Nothing is stored; the connection starts over.
        error = frame.response?.error || OPT_IN_FAILED;
        current.close();
        return;
      }
      languageProfiles = outcome.languageProfiles;
      await adoptSnapshot(current, currentGeneration, outcome.snapshot);
      return;
    }
    const entry = pending.get(frame.id);
    if (entry === undefined || entry.generation !== currentGeneration) return;
    pending.delete(frame.id);
    entry.resolve(frame.response);
  }

  async function handleFrame(current, currentGeneration, text) {
    if (socket !== current || linkGeneration !== currentGeneration) return;
    let frame;
    try {
      frame = parseHostFrame(text);
    } catch (parseError) {
      console.warn("hachidori: dropped a sharing frame:", describeError(parseError));
      return;
    }
    switch (frame.kind) {
      case "hello":
        await handleHello(current, currentGeneration, frame);
        return;
      case "reply":
        await handleReply(current, currentGeneration, frame);
        return;
      case "storage":
        // Changes sent before the host answered the opt-in are no newer than
        // its reply.
        if (optIn !== null) return;
        await applyBatch(frame.changes,
          () => socket === current && linkGeneration === currentGeneration);
        return;
      case "word-status":
        onWordStatus(frame.revision);
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
      error = describeError(connectError);
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
      optIn = null;
      languageProfiles = null;
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
  function forward(message, {
    capability = null, unsupported = LINKED_ANKI_UNSUPPORTED, mutation = false, onSent = null,
  } = {}) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const requestGeneration = linkGeneration;
      const send = () => {
        if (requestGeneration !== linkGeneration || !ready || socket === null) {
          reject(new Error(NOT_REACHABLE));
          return;
        }
        if (capability !== null && !host?.capabilities.includes(capability)) {
          reject(new Error(unsupported));
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

  // One short connection that reports what answers at an address. With
  // `optIn`, a host with profiles is asked for them as the link's own
  // connection asks, and the snapshot is the opt-in reply's: a new link stores
  // that, never the hello's (docs/languages.md 17.3 item 2).
  function probe(target, { optIn: askProfiles = false } = {}) {
    return new Promise((resolve, reject) => {
      let probeSocket;
      try {
        probeSocket = new WebSocket(target);
      } catch (connectError) {
        reject(new Error(`No shared Hachidori answered at ${target}: ${describeError(connectError)}`));
        return;
      }
      let settled = false;
      let hello = null;
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
        probeSocket.close();
      };
      const timer = setTimeout(() => finish(() => reject(new Error(`No shared Hachidori answered at ${target}.`))), CONNECT_WAIT_MS);
      const found = frame => ({ version: frame.version, name: frame.name, dictionaryCount: frame.dictionaryCount,
        capabilities: frame.capabilities, snapshot: frame.snapshot });
      probeSocket.onopen = () => sendHello(probeSocket);
      probeSocket.onmessage = (event) => {
        try {
          const frame = parseHostFrame(String(event.data));
          if (frame.kind === "hello") {
            const codes = askProfiles && frame.capabilities.includes(LANGUAGE_PROFILES_CAPABILITY) ? languages() : null;
            if (codes === null) {
              finish(() => resolve(found(frame)));
              return;
            }
            hello = frame;
            probeSocket.send(optInFrame("probe-language-profiles", codes));
          } else if (frame.kind === "reply" && hello !== null && frame.id === "probe-language-profiles") {
            const outcome = optInOutcome(frame.response);
            if (outcome === null) {
              finish(() => reject(new Error(frame.response?.error || OPT_IN_FAILED)));
              return;
            }
            finish(() => resolve({ ...found(hello), snapshot: outcome.snapshot, languageProfiles: outcome.languageProfiles }));
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
      optIn = null;
      languageProfiles = null;
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
      optIn = null;
      languageProfiles = null;
      const failure = new Error(NOT_REACHABLE);
      rejectPending(failure);
      settleWaiting(failure);
      previous?.close();
      onWordStatus(null);
    },
  };
}
