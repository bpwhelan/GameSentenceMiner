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
      if (!payload || Object.keys(payload).length !== 2 || !Object.hasOwn(payload, "result")
          || !Object.hasOwn(payload, "error") || (payload.error !== null && typeof payload.error !== "string")) {
        throw new Error("AnkiConnect returned an invalid response. Check the add-on and retry.");
      }
      if (payload.error !== null) throw new Error(/api key/iu.test(payload.error)
        ? "AnkiConnect requires a valid API key. Enter the key from its add-on configuration."
        : `AnkiConnect: ${payload.error}`);
      return payload.result;
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

  async function invoke(action, params, apiKey, requestTimeoutMs = timeoutMs,
    endpoint = globalThis.HDReaderOptions.DEFAULT_OPTIONS.anki.url) {
    const url = globalThis.HDReaderOptions.normaliseAnkiConnectUrl(endpoint);
    if (url === null) throw new Error("Enter a valid HTTP or HTTPS AnkiConnect URL in Settings, without a username or password.");
    const body = JSON.stringify({ action, version: 6, params, ...(apiKey ? { key: apiKey } : {}) });
    return enqueue({ url, body, requestTimeoutMs });
  }

  async function names(action, params, apiKey, url) {
    const result = await invoke(action, params, apiKey, undefined, url);
    if (!Array.isArray(result) || result.some(name => typeof name !== "string" || name.trim() === "")) {
      throw new Error(`AnkiConnect returned an invalid ${action} list.`);
    }
    // Exact names remain authoritative; model field order determines Anki's
    // required first field. Never sort the returned list or truncate it.
    return [...new Set(result)];
  }

  async function discover({ model, apiKey = "", url }) {
    const errors = [];
    let connected = false;
    async function read(action, params = {}) {
      try {
        const result = await names(action, params, apiKey, url);
        connected = true;
        return result;
      } catch (error) {
        if (!errors.includes(error.message)) errors.push(error.message);
        return [];
      }
    }
    const [decks, models] = await Promise.all([read("deckNames"), read("modelNames")]);
    const fields = models.includes(model) ? await read("modelFieldNames", { modelName: model }) : [];
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
  if (!discovery.decks.includes(config.deck)) errors.push("Choose an available deck.");
  if (!discovery.models.includes(config.model)) errors.push("Choose an available note type.");
  if (config.model !== discovery.model) return [...errors, "Refresh fields for the selected note type."];
  const resolved = resolvedTemplates ?? resolveAnkiTemplates(config, discovery.fields);
  errors.push(...resolved.errors);
  if (discovery.fields.length > 0 && !resolved.templates[discovery.fields[0]].value.trim()) {
    errors.push(`Map the first field, “${discovery.fields[0]}”, before adding notes.`);
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
