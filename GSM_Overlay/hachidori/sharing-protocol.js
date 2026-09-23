// Wire contract shared by the service worker and the relay the Anki add-on
// runs (https://github.com/bee-san/hachidori-anki, addon/server.py).
// SPDX-License-Identifier: GPL-3.0-or-later

export const PROTOCOL_VERSION = 1;
export const DEFAULT_SHARING_PORT = 8771;
// Nearby discovery must not offer this installation's own host or replace a link.
export function canDiscoverSharingHost(sharing) {
  return sharing != null && sharing.client?.linked !== true
    && !(sharing.enabled === true && sharing.connected === true);
}

// v1 carries the singleton Anki configuration. v2 adds stable Template
// identity to every readiness, write and browse operation. Advertise both so
// older readers can still use the first Template without a mixed-version
// reader silently sending a custom button through the wrong destination.
export const LEGACY_LINKED_ANKI_CAPABILITY = "linked-anki-v1";
export const LINKED_ANKI_CAPABILITY = "linked-anki-v2";
export const SHARING_CAPABILITIES = Object.freeze([
  LEGACY_LINKED_ANKI_CAPABILITY,
  LINKED_ANKI_CAPABILITY,
]);
// The relay's own client for its Yomitan-compatible API (hachidori-anki
// docs/host-contract.md). Never a remote computer, never a linked browser.
export const API_CAPABILITY = "hoshidicts-api-v1";
export const API_CLIENT_ORIGIN = "relay://yomitan-api";
export const LINKED_ANKI_UNSUPPORTED = "The linked Hachidori does not support host-owned Anki mining. Update it and try again.";
export const MAX_LINKED_ANKI_FRAME_BYTES = 16 * 1024 * 1024;
const HOST_PATH = "/host";
const LINK_PATH = "/link";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const ADDRESS_HINT = "Enter the address shown under Sharing on the other computer, like 100.101.102.103.";

export const LINKED_ANKI_REQUESTS = new Set([
  "hd_anki_status", "hd_anki_view", "hd_anki_preflight", "hd_anki_submit", "hd_anki_browse", "hd_anki_maturity",
]);

// Which runtime messages a linked client sends to the host instead of its own
// engine or worker. Screenshot capture/discard and captured-media sessions stay
// in the reading browser; the host owns every Anki and generation decision.
export const FORWARDED_REQUESTS = {
  "hoshidicts-offscreen": new Set([
    "hd_lookup", "hd_lookup_dictionary", "hd_kanji", "hd_styles", "hd_media", "hd_status", "hd_memory",
    "hd_custom_append", "hd_custom_save", "hd_apply_state", "hd_reload", "hd_remove", "hd_import",
  ]),
  "hoshidicts-worker": new Set([
    "hd_state_read", "hd_state_cas", "hd_custom_read", "hd_custom_cas", "hd_options_write",
    "hd_lookup_stats_read", "hd_lookup_stats_record",
  ]),
  "hachidori-updates": new Set(["hd_updates_schedule", "hd_updates_check", "hd_updates_install"]),
  "hachidori-setup": new Set(["hd_setup_install"]),
  "hachidori-anki": LINKED_ANKI_REQUESTS,
};

const MUTATING_FORWARDED_REQUESTS = {
  "hoshidicts-offscreen": new Set([
    "hd_custom_append", "hd_custom_save", "hd_apply_state", "hd_reload", "hd_remove", "hd_import",
  ]),
  "hoshidicts-worker": new Set([
    "hd_state_cas", "hd_custom_cas", "hd_options_write", "hd_lookup_stats_record",
  ]),
  "hachidori-updates": new Set(["hd_updates_schedule", "hd_updates_check", "hd_updates_install"]),
  "hachidori-setup": new Set(["hd_setup_install"]),
  "hachidori-anki": new Set(["hd_anki_submit"]),
};

export function forwardableRequest(message) {
  if (!message || typeof message !== "object") return false;
  const types = FORWARDED_REQUESTS[message.target];
  if (!types?.has(message.type)) return false;
  // A blob: URL only resolves inside the browser that created it; the host can
  // download an archive itself.
  if (message.type === "hd_import") return typeof message.archiveUrl === "string" && message.blobUrl === undefined;
  return true;
}

export function mutatingForwardedRequest(message) {
  return forwardableRequest(message) && MUTATING_FORWARDED_REQUESTS[message.target]?.has(message.type) === true;
}

export function formatLinkAddress({ host = "127.0.0.1", port = DEFAULT_SHARING_PORT } = {}) {
  return `ws://${host}:${port}${LINK_PATH}`;
}

export function formatHostAddress({ port = DEFAULT_SHARING_PORT } = {}) {
  return `ws://127.0.0.1:${port}${HOST_PATH}`;
}

// What a person types or is shown: a host, `host:port` when the port is not
// the default, or the full ws:// address. Empty means this computer.
export function parseLinkAddress(text) {
  const trimmed = String(text ?? "").trim();
  let withScheme = trimmed;
  if (trimmed === "") withScheme = formatLinkAddress();
  else if (!trimmed.includes("://")) withScheme = `ws://${trimmed}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(ADDRESS_HINT);
  }
  if (url.protocol !== "ws:" || url.hostname === "" || !["", "/", LINK_PATH].includes(url.pathname)) {
    throw new Error(ADDRESS_HINT);
  }
  const port = url.port === "" ? DEFAULT_SHARING_PORT : Number(url.port);
  const host = LOOPBACK_HOSTS.has(url.hostname) ? "127.0.0.1" : url.hostname;
  let display = `${host}:${port}`;
  if (host === "127.0.0.1") display = "this computer";
  else if (port === DEFAULT_SHARING_PORT) display = host;
  return { host, port, address: formatLinkAddress({ host, port }), display };
}

// The brand a Chromium browser reports about itself, for "the Hachidori in
// Chrome": the first brand that is not the placeholder and not plain Chromium.
export function browserName(navigator) {
  const brands = (navigator?.userAgentData?.brands ?? []).map(entry => String(entry?.brand ?? "")).filter(brand => brand !== "" && !/not.?a.?brand/iu.test(brand));
  const brand = brands.find(name => name !== "Chromium") ?? brands[0];
  if (brand) return brand;
  if (/\bFirefox\//u.test(String(navigator?.userAgent ?? ""))) return "Firefox";
  return "another browser";
}

function parseJsonObject(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("malformed sharing frame");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("malformed sharing frame");
  return value;
}

function parseCapabilities(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32
      || value.some(item => typeof item !== "string" || item === "" || item.length > 100)) {
    throw new Error("malformed sharing capabilities");
  }
  return [...new Set(value)];
}

function linkedAnkiSubmission(message) {
  return message?.target === "hachidori-anki" && message.type === "hd_anki_submit";
}

export function assertLinkedAnkiFrame(text) {
  if (new TextEncoder().encode(text).byteLength > MAX_LINKED_ANKI_FRAME_BYTES) {
    throw new Error("The linked Anki submission exceeds the 16 MiB frame limit.");
  }
}

const MINING_REQUEST_FIELDS = [
  "term", "trace", "generation", "sentence", "matchOffset", "matched", "popupSelectionText",
  "searchQuery", "documentTitle", "audioSelection", "capturePin", "dictionaryAliases", "dictionaryIds",
  "frequencyDictionaries", "configKey", "screenshot", "captureJobId", "captureUnavailable",
  "clientSpeech", "templateId",
];

function selectedFields(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("malformed linked Anki request");
  return Object.fromEntries(fields.filter(field => Object.hasOwn(value, field)).map(field => [field, value[field]]));
}

function selectedTemplateId(value) {
  if (!Object.hasOwn(value ?? {}, "templateId")) return {};
  if (typeof value.templateId !== "string" || value.templateId === "" || value.templateId.length > 256
      || /[\u0000-\u001f\u007f]/u.test(value.templateId)) {
    throw new Error("malformed linked Anki Template");
  }
  return { templateId: value.templateId };
}

// A linked browser is untrusted at the host boundary. Rebuild only the request
// shape each operation needs; endpoint credentials and local-only operations
// never enter the host's ordinary Anki handler.
export function allowLinkedAnkiRequest(message) {
  if (!message || typeof message !== "object" || message.target !== "hachidori-anki"
      || !LINKED_ANKI_REQUESTS.has(message.type)) {
    throw new Error("unsupported linked Anki request");
  }
  const requestId = typeof message.requestId === "string" || Number.isFinite(message.requestId)
    ? message.requestId : null;
  const base = { target: "hachidori-anki", type: message.type, requestId };
  if (message.type === "hd_anki_status") return { ...base, ...selectedTemplateId(message) };
  if (message.type === "hd_anki_view") {
    const request = selectedFields(message.request, ["term", "templateId"]);
    Object.assign(request, selectedTemplateId(request));
    request.term = selectedFields(request.term, ["expression", "reading"]);
    return { ...base, request };
  }
  if (message.type === "hd_anki_maturity") {
    const request = selectedFields(message.request, ["term"]);
    request.term = selectedFields(request.term, ["expression", "reading"]);
    return { ...base, request };
  }
  if (message.type === "hd_anki_browse") {
    const request = selectedFields(message.request, ["noteIds", "expression", "configKey", "templateId"]);
    Object.assign(request, selectedTemplateId(request));
    return { ...base, request };
  }
  const request = selectedFields(message.request, MINING_REQUEST_FIELDS);
  Object.assign(request, selectedTemplateId(request));
  return message.type === "hd_anki_submit"
    ? { ...base, request, clientMedia: message.clientMedia }
    : { ...base, request };
}

// Settings discovery is a worker request rather than a mining request. The
// linked browser may choose a prospective note type, but its endpoint and API
// key never cross the host boundary.
export function allowLinkedAnkiDiscoveryRequest(message) {
  if (!message || typeof message !== "object" || message.target !== "hoshidicts-worker"
      || message.type !== "hd_anki_discover" || typeof message.model !== "string"
      || message.model.length > 4096) {
    throw new Error("unsupported linked Anki discovery request");
  }
  const requestId = typeof message.requestId === "string" || Number.isFinite(message.requestId)
    ? message.requestId : null;
  return {
    target: "hoshidicts-worker",
    type: "hd_anki_discover",
    requestId,
    model: message.model,
  };
}

// Full setup detection reads the selected host Template as well as its shared
// endpoint. The client supplies only that stable identity, never its endpoint,
// key or mapping.
export function allowLinkedAnkiSetupRequest(message) {
  if (!message || typeof message !== "object" || message.target !== "hoshidicts-worker"
      || message.type !== "hd_anki_setup") {
    throw new Error("unsupported linked Anki setup request");
  }
  const requestId = typeof message.requestId === "string" || Number.isFinite(message.requestId)
    ? message.requestId : null;
  return {
    target: "hoshidicts-worker",
    type: "hd_anki_setup",
    requestId,
    ...selectedTemplateId(message),
  };
}

// A frame a client sends to the host.
export function parseClientFrame(text) {
  const frame = parseJsonObject(text);
  switch (frame.kind) {
    case "hello":
      if (frame.protocol !== PROTOCOL_VERSION) throw new Error(`unsupported sharing protocol ${JSON.stringify(frame.protocol)}`);
      return { kind: "hello", version: String(frame.version ?? ""), name: String(frame.name ?? ""),
        capabilities: parseCapabilities(frame.capabilities) };
    case "request":
      if (!frame.message || typeof frame.message !== "object" || Array.isArray(frame.message)
          || typeof frame.message.target !== "string" || typeof frame.message.type !== "string"
          || (typeof frame.id !== "string" && typeof frame.id !== "number")) throw new Error("malformed sharing request");
      if (linkedAnkiSubmission(frame.message)) assertLinkedAnkiFrame(text);
      return { kind: "request", id: frame.id, message: frame.message };
    case "pong":
      return { kind: "pong" };
    default:
      throw new Error(`unknown sharing frame ${JSON.stringify(frame.kind)}`);
  }
}

// A frame the host or the relay sends to a client.
export function parseHostFrame(text) {
  const frame = parseJsonObject(text);
  switch (frame.kind) {
    case "hello":
      if (frame.protocol !== PROTOCOL_VERSION) throw new Error(`unsupported sharing protocol ${JSON.stringify(frame.protocol)}`);
      if (!frame.snapshot || typeof frame.snapshot !== "object") throw new Error("malformed sharing hello");
      return { kind: "hello", version: String(frame.version ?? ""), name: String(frame.name ?? ""),
        dictionaryCount: Number(frame.dictionaryCount) || 0, capabilities: parseCapabilities(frame.capabilities),
        snapshot: frame.snapshot };
    case "reply":
      if (typeof frame.id !== "string" && typeof frame.id !== "number") throw new Error("malformed sharing reply");
      return { kind: "reply", id: frame.id, response: frame.response };
    case "storage":
      if (!frame.changes || typeof frame.changes !== "object" || Array.isArray(frame.changes)) throw new Error("malformed sharing storage frame");
      return { kind: "storage", changes: frame.changes };
    case "ping":
      return { kind: "ping" };
    case "bye":
      return { kind: "bye", reason: String(frame.reason ?? "") };
    default:
      throw new Error(`unknown sharing frame ${JSON.stringify(frame.kind)}`);
  }
}
