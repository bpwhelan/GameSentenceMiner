// Wire contract shared by the service worker and the relay the Anki add-on
// runs (https://github.com/bee-san/hachidori-anki, addon/server.py).
// SPDX-License-Identifier: GPL-3.0-or-later

export const PROTOCOL_VERSION = 1;
export const DEFAULT_SHARING_PORT = 8771;
const HOST_PATH = "/host";
const LINK_PATH = "/link";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const ADDRESS_HINT = "Enter the address shown under Sharing on the other computer, like 100.101.102.103.";

// Which runtime messages a linked client sends to the host instead of its own
// engine or worker. Everything else stays local: audio, Anki mining, capture,
// page zoom, external links, setup, local-file imports and backups.
export const FORWARDED_REQUESTS = {
  "hoshidicts-offscreen": new Set([
    "hd_lookup", "hd_lookup_dictionary", "hd_kanji", "hd_styles", "hd_media", "hd_status",
    "hd_custom_append", "hd_custom_save", "hd_apply_state", "hd_reload", "hd_remove", "hd_import",
  ]),
  "hoshidicts-worker": new Set([
    "hd_state_read", "hd_state_cas", "hd_custom_read", "hd_custom_cas", "hd_options_write",
    "hd_lookup_stats_read", "hd_lookup_stats_record",
  ]),
  "hachidori-updates": new Set(["hd_updates_schedule", "hd_updates_check", "hd_updates_install"]),
  "hachidori-anki": new Set(["hd_anki_maturity"]),
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
  return brands.find(brand => brand !== "Chromium") ?? brands[0] ?? "another browser";
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

// A frame a client sends to the host.
export function parseClientFrame(text) {
  const frame = parseJsonObject(text);
  switch (frame.kind) {
    case "hello":
      if (frame.protocol !== PROTOCOL_VERSION) throw new Error(`unsupported sharing protocol ${JSON.stringify(frame.protocol)}`);
      return { kind: "hello", version: String(frame.version ?? ""), name: String(frame.name ?? "") };
    case "request":
      if (!frame.message || typeof frame.message !== "object" || Array.isArray(frame.message)
          || typeof frame.message.target !== "string" || typeof frame.message.type !== "string"
          || (typeof frame.id !== "string" && typeof frame.id !== "number")) throw new Error("malformed sharing request");
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
        dictionaryCount: Number(frame.dictionaryCount) || 0, snapshot: frame.snapshot };
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
