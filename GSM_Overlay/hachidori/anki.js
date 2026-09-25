// SPDX-License-Identifier: GPL-3.0-or-later
import { ankiTemplateMarkerNames, resolveAnkiTemplates } from "./anki-templates.js";
import "./reader-options.js";

export class AnkiTransportError extends Error {
  constructor(message, { dispatched }) {
    super(message);
    Object.defineProperty(this, "name", { value: "AnkiTransportError", configurable: true });
    Object.defineProperty(this, "dispatched", { value: dispatched === true, enumerable: false });
  }
}

export function isUndispatchedAnkiTransportError(error) {
  return error instanceof AnkiTransportError && error.dispatched === false;
}

// Every AnkiConnect API-v6 reply, including each sub-action reply inside a
// `multi` batch, is exactly `{ result, error }` with a string or null error.
const isEnvelope = payload => payload !== null && typeof payload === "object" && !Array.isArray(payload)
  && Object.keys(payload).length === 2 && Object.hasOwn(payload, "result") && Object.hasOwn(payload, "error")
  && (payload.error === null || typeof payload.error === "string");
const invalidResponse = () => new Error("AnkiConnect returned an invalid response. Check the add-on and retry.");

// AnkiConnect's own error strings name the cause but not what to do about it.
// Each translation keeps the original text so it can still be searched for.
const ANKI_CONNECT_EXPLANATIONS = [
  [/api key/iu, () => "AnkiConnect requires a valid API key. Enter the key from its add-on configuration."],
  [/collection is not available/iu,
    () => "Anki has no open collection. Open your profile in Anki, then retry."],
  [/^deck was not found: (.+)$/iu,
    ([, deck]) => `Anki has no deck named “${deck}”. Choose an available deck in Anki Settings.`],
  [/^model was not found: (.+)$/iu,
    ([, model]) => `Anki has no note type named “${model}”. Choose an available note type in Anki Settings.`],
  [/^cannot create note because it is empty$/iu,
    () => "Anki refused the note because its first field is empty. Map the first field to content this result has."],
  [/^cannot create note because it is a duplicate$/iu,
    () => "Anki refused the note because a note with the same first field already exists."],
  [/^note was not found: (.+)$/iu,
    ([, id]) => `Anki no longer has note ${id}. It was deleted or moved to another collection; refresh and retry.`],
  [/unsupported action|unknown action/iu,
    () => "The installed AnkiConnect add-on is too old for this request. Update AnkiConnect in Anki."],
];

// Turns a raw AnkiConnect error string into the message shown to the reader.
export function describeAnkiConnectError(error) {
  for (const [pattern, explain] of ANKI_CONNECT_EXPLANATIONS) {
    const match = pattern.exec(error);
    if (match === null) continue;
    const explanation = explain(match);
    return pattern === ANKI_CONNECT_EXPLANATIONS[0][0] ? explanation : `${explanation} (AnkiConnect: ${error})`;
  }
  return `AnkiConnect: ${error}`;
}

function unwrap(reply) {
  if (reply.error !== null) throw new Error(describeAnkiConnectError(reply.error));
  return reply.result;
}

// Unwraps the sub-action replies of one `invoke("multi", …)` result, throwing
// the first sub-action failure the way a direct request would.
export function ankiMultiResults(replies) {
  return replies.map(unwrap);
}

function names(action, reply) {
  const result = unwrap(reply);
  if (!Array.isArray(result) || result.some(name => typeof name !== "string" || name.trim() === "")) {
    throw new Error(`AnkiConnect returned an invalid ${action} list.`);
  }
  // Exact names remain authoritative; model field order determines Anki's
  // required first field. Never sort the returned list or truncate it.
  return [...new Set(result)];
}

// GSM PR #549's API-v6 discovery, adapted to the MV3 worker. AnkiConnect
// handles requests through Anki's UI loop, so each endpoint gets a small,
// bounded set of transport lanes. Four lanes let a replacement Settings check
// pass one delayed stale reply without allowing an unbounded server-side queue.
// The private worker's feature handlers still select actions and bind every
// conversation to its configured endpoint and API key.
export function createAnkiGateway({ fetch = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  const maximumActive = 4;
  const queues = new Map();

  async function dispatch({ url, body, requestTimeoutMs }, queue) {
    const controller = new AbortController();
    queue.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    const unavailable = () => new AnkiTransportError(
      controller.signal.aborted ? "AnkiConnect timed out. Check its URL in Settings, open Anki and retry."
        : "Open Anki with the AnkiConnect add-on installed, check its URL in Settings, then retry.",
      { dispatched: true },
    );
    const interrupted = () => controller.signal.reason instanceof AnkiTransportError
      ? controller.signal.reason : unavailable();
    try {
      let response;
      try {
        response = await fetch(url, { method: "POST", credentials: "omit", redirect: "error",
          headers: { "Content-Type": "application/json" }, signal: controller.signal,
          body });
      } catch {
        throw interrupted();
      }
      if (!response.ok) throw new Error(response.status === 403
        ? "AnkiConnect denied permission. Allow this extension in AnkiConnect’s webCorsOriginList, then retry."
        : `AnkiConnect returned HTTP ${response.status}.`);
      const payload = await response.json().catch(() => null);
      if (controller.signal.aborted) throw interrupted();
      if (!isEnvelope(payload)) throw invalidResponse();
      return unwrap(payload);
    } finally {
      clearTimeout(timer);
      queue.controllers.delete(controller);
    }
  }

  function failQueue(url, queue, error) {
    if (queue.failure !== null) return;
    queue.failure = error;
    if (queues.get(url) === queue) queues.delete(url);
    for (const pending of queue.pending.splice(0)) {
      pending.reject(new AnkiTransportError(error.message, { dispatched: false }));
    }
    // Every active entry has entered fetch, so aborting one cannot prove that
    // its Anki mutation did not run. Mark active siblings dispatched and keep
    // their outcomes conservative while ending a failed endpoint generation
    // within one transport deadline.
    for (const controller of queue.controllers) {
      controller.abort(new AnkiTransportError(error.message, { dispatched: true }));
    }
  }

  async function runEntry(url, queue, entry) {
    try {
      entry.resolve(await dispatch(entry.request, queue));
    } catch (error) {
      entry.reject(error);
      if (error instanceof AnkiTransportError) failQueue(url, queue, error);
    } finally {
      queue.active -= 1;
      pump(url, queue);
    }
  }

  function pump(url, queue) {
    if (queue.failure === null) {
      while (queue.active < maximumActive && queue.pending.length > 0) {
        const entry = queue.pending.shift();
        queue.active += 1;
        void runEntry(url, queue, entry);
      }
    }
    if (queue.active === 0 && queue.pending.length === 0 && queues.get(url) === queue) {
      queues.delete(url);
    }
  }

  function enqueue(request) {
    let queue = queues.get(request.url);
    if (!queue) {
      queue = { pending: [], active: 0, controllers: new Set(), failure: null };
      queues.set(request.url, queue);
    }
    return new Promise((resolve, reject) => {
      queue.pending.push({ request, resolve, reject });
      pump(request.url, queue);
    });
  }

  // AnkiConnect's socket is polled on a timer, so every request costs one poll
  // interval regardless of content and parallel requests serialise. A `multi`
  // batch pays that once. AnkiConnect runs each sub-action through its ordinary
  // handler, which checks the API key and picks the reply shape per sub-action,
  // so every sub-action is bound to this conversation's key and API v6 here and
  // the reply is an array of `{ result, error }` envelopes in request order.
  async function invoke(action, params, apiKey, requestTimeoutMs = timeoutMs,
    endpoint = globalThis.HDReaderOptions.DEFAULT_OPTIONS.anki.url) {
    const url = globalThis.HDReaderOptions.normaliseAnkiConnectUrl(endpoint);
    if (url === null) throw new Error("Enter a valid HTTP or HTTPS AnkiConnect URL in Settings, without a username or password.");
    const key = apiKey ? { key: apiKey } : {};
    // Sub-actions are rebuilt from their action and params so nothing else a
    // caller passes reaches the wire.
    const actions = action === "multi"
      ? params.actions.map(entry => ({ action: entry.action, params: entry.params, version: 6, ...key })) : null;
    const body = JSON.stringify({ action, version: 6, params: actions ? { actions } : params, ...key });
    const result = await enqueue({ url, body, requestTimeoutMs });
    if (actions && (!Array.isArray(result) || result.length !== actions.length || !result.every(isEnvelope))) {
      throw invalidResponse();
    }
    return result;
  }

  // One round trip: decks, note types and, speculatively, the configured note
  // type's fields. The field reply is ignored when that note type is absent.
  async function discover({ model, apiKey = "", url }) {
    const errors = [];
    let connected = false;
    let replies;
    try {
      replies = await invoke("multi", { actions: [
        { action: "deckNames", params: {} },
        { action: "modelNames", params: {} },
        { action: "modelFieldNames", params: { modelName: model } },
      ] }, apiKey, undefined, url);
    } catch (error) {
      return { connected, model, decks: [], models: [], fields: [], errors: [error.message] };
    }
    function read(action, reply) {
      try {
        const result = names(action, reply);
        connected = true;
        return result;
      } catch (error) {
        if (!errors.includes(error.message)) errors.push(error.message);
        return [];
      }
    }
    const decks = read("deckNames", replies[0]);
    const models = read("modelNames", replies[1]);
    const fields = models.includes(model) ? read("modelFieldNames", replies[2]) : [];
    return { connected, model, decks, models, fields, errors };
  }
  return { discover, invoke };
}

// Shared by Settings and authoritative mining readiness checks. Validation
// reports missing choices instead of changing a saved or in-progress mapping.
export function ankiAvailability(config, discovery, resolvedTemplates) {
  if (!discovery) return ["Refresh Anki to check this configuration."];
  if (!discovery.connected) return discovery.errors;
  const errors = [...discovery.errors];
  if (!discovery.decks.includes(config.deck)) {
    errors.push(config.deck
      ? `Anki has no deck named “${config.deck}”. Choose an available deck.`
      : "Choose an available deck.");
  }
  if (!discovery.models.includes(config.model)) {
    errors.push(config.model
      ? `Anki has no note type named “${config.model}”. Choose an available note type.`
      : "Choose an available note type.");
  }
  if (config.model !== discovery.model) {
    return [...errors, `Refresh fields for the selected note type, “${config.model}”.`];
  }
  const resolved = resolvedTemplates ?? resolveAnkiTemplates(config, discovery.fields);
  errors.push(...resolved.errors);
  if (discovery.fields.length > 0 && !resolved.templates[discovery.fields[0]].value.trim()) {
    errors.push(`Map the first field, “${discovery.fields[0]}”, of note type “${config.model}” before adding notes. Anki requires it.`);
  }
  if (discovery.fields.length > 0) {
    const markers = ankiTemplateMarkerNames(resolved.templates[discovery.fields[0]].value);
    if (markers.includes("capture-animation") || markers.includes("capture-audio") || markers.includes("screenshot")) {
      errors.push(`Captured media cannot be mapped to the first field, “${discovery.fields[0]}”.`);
    }
  }
  if (config.model && discovery.fields.length === 0 && errors.length === 0) errors.push("The selected note type has no fields.");
  return errors;
}
