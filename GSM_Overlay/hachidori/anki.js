// SPDX-License-Identifier: GPL-3.0-or-later
import { ankiTemplateMarkerNames, resolveAnkiTemplates } from "./anki-templates.js";
import "./reader-options.js";

// GSM PR #549's API-v6 discovery, adapted to the MV3 worker. No engine or
// storage queue is involved. The private worker's feature handlers select
// actions and bind every conversation to its configured endpoint and API key.
export function createAnkiGateway({ fetch = globalThis.fetch, timeoutMs = 1250 } = {}) {
  async function invoke(action, params, apiKey, requestTimeoutMs = timeoutMs,
    endpoint = globalThis.HDReaderOptions.DEFAULT_OPTIONS.anki.url) {
    const url = globalThis.HDReaderOptions.normaliseAnkiConnectUrl(endpoint);
    if (url === null) throw new Error("Enter a valid HTTP or HTTPS AnkiConnect URL in Settings, without a username or password.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    const unavailable = () => new Error(controller.signal.aborted ? "AnkiConnect timed out. Check its URL in Settings, open Anki and retry."
      : "Open Anki with the AnkiConnect add-on installed, check its URL in Settings, then retry.");
    try {
      let response;
      try {
        response = await fetch(url, { method: "POST", credentials: "omit", redirect: "error",
          headers: { "Content-Type": "application/json" }, signal: controller.signal,
          body: JSON.stringify({ action, version: 6, params, ...(apiKey ? { key: apiKey } : {}) }) });
      } catch {
        throw unavailable();
      }
      if (!response.ok) throw new Error(response.status === 403
        ? "AnkiConnect denied permission. Allow this extension in AnkiConnect’s webCorsOriginList, then retry."
        : `AnkiConnect returned HTTP ${response.status}.`);
      const payload = await response.json().catch(() => null);
      if (controller.signal.aborted) throw unavailable();
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
    }
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
