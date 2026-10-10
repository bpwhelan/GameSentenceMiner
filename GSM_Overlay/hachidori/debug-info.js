// Settings → Advanced → Troubleshooting → Get debug info. One JSON report of
// what a maintainer needs to reproduce a problem: the version, install and
// browser; the engine's status, memory and recent log from every extension
// context; the installed dictionaries, Anki and sharing state; every setting;
// and what is stored where (storage areas, IndexedDB, OPFS files, caches).
// Each probe is recorded on its own, so one that fails or is missing in this
// host leaves `{ error }` in its place instead of losing the report.
//
// Credentials are redacted. Reader-authored content is reduced to counts: the
// personal dictionary text, lookup history rows, Anki duplicate-index rows, the
// words marked as known or ignored and automatic backup payloads never leave
// the browser through this file.
// SPDX-License-Identifier: GPL-3.0-or-later
import { CUSTOM_DICTIONARY_SOURCE_KEY } from "./custom-dictionary.js";
import { LOOKUP_STATS_ROW_PREFIX } from "./lookup-stats.js";
import { ANKI_INDEX_KEY } from "./anki-index-cache.js";
import { AUTOMATIC_BACKUPS_KEY } from "./backup-automatic.js";
import { readDebugLog } from "./debug-log.js";
import "./word-status-overrides.js";

export const DEBUG_INFO_SCHEMA_VERSION = 1;
export const REDACTED = "[redacted]";

const SECRET_KEY = /api.?key|token|secret|password/iu;

// A probe that never settles (an engine or Anki that stopped answering) must
// not hold the report: broken setups are when it is needed most. The extension
// memory total waits for the browser's next garbage collection, which Chrome
// forces within 20 seconds, so the bound leaves room for it.
export const DEBUG_PROBE_TIMEOUT_MS = 30_000;

// The text a failed probe leaves in the report: an Error's message as it is,
// even when empty, unlike error-text.js's describeError.
function probeFailureText(error) {
  return error instanceof Error ? error.message : String(error);
}

async function probe(read, timeoutMs = DEBUG_PROBE_TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(read),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs / 1000} seconds`)), timeoutMs);
      }),
    ]);
  } catch (error) {
    return { error: probeFailureText(error) };
  } finally {
    clearTimeout(timer);
  }
}

// Run every named probe at once; the result has the same keys.
async function probeAll(probes, timeoutMs) {
  const entries = Object.entries(probes);
  const values = await Promise.all(entries.map(([, read]) => probe(read, timeoutMs)));
  return Object.fromEntries(entries.map(([key], index) => [key, values[index]]));
}

// Replace every non-empty string under a credential-like key, at any depth.
// An empty value stays empty so the report still shows it was never set.
export function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
    SECRET_KEY.test(key) && typeof entry === "string" && entry !== "" ? REDACTED : redactSecrets(entry)]));
}

const jsonBytes = value => new TextEncoder().encode(JSON.stringify(value) ?? "").length;

function summariseCustomDictionary(value) {
  const { text, ...rest } = value ?? {};
  return typeof text === "string"
    ? { ...rest, text: { omitted: true, characters: text.length, lines: text === "" ? 0 : text.split(/\r?\n/u).length } }
    : value;
}

function summariseAnkiIndex(value) {
  const rows = value?.snapshot?.rows;
  if (!Array.isArray(rows)) return value;
  return { ...value, snapshot: { ...value.snapshot, rows: { omitted: true, count: rows.length } } };
}

function summariseWordStatusOverrides(value) {
  const record = globalThis.HDWordStatusOverrides.normaliseWordStatusOverrides(value);
  return { revision: record.revision, ...Object.fromEntries(globalThis.HDWordStatusOverrides.OVERRIDE_STATUSES
    .map(status => [status, { omitted: true, count: record[status].length }])) };
}

function summariseAutomaticBackups(value) {
  if (!Array.isArray(value?.backups)) return value;
  return { schemaVersion: value.schemaVersion, backups: value.backups.map(record => ({
    id: record?.id, createdAt: record?.createdAt, bytes: jsonBytes(record),
  })) };
}

const SUMMARISERS = {
  [CUSTOM_DICTIONARY_SOURCE_KEY]: summariseCustomDictionary,
  [ANKI_INDEX_KEY]: summariseAnkiIndex,
  [AUTOMATIC_BACKUPS_KEY]: summariseAutomaticBackups,
  [globalThis.HDWordStatusOverrides.WORD_STATUS_OVERRIDES_KEY]: summariseWordStatusOverrides,
};

// Every chrome.storage.local key with its stored size, the value redacted and
// reader content summarised. Lookup rows (one key per word) collapse to a count.
export function summariseStorage(items) {
  const keys = {};
  const lookupRows = { count: 0, bytes: 0 };
  for (const key of Object.keys(items).sort((left, right) => left.localeCompare(right))) {
    const value = items[key];
    if (key.startsWith(LOOKUP_STATS_ROW_PREFIX)) {
      lookupRows.count += 1;
      lookupRows.bytes += jsonBytes(value);
      continue;
    }
    const summarise = SUMMARISERS[key];
    keys[key] = { bytes: jsonBytes(value), value: redactSecrets(summarise ? summarise(value) : value) };
  }
  return { keys, lookupStatsRows: lookupRows };
}

const HIGH_ENTROPY_HINTS = ["architecture", "bitness", "formFactors", "fullVersionList", "model", "platformVersion", "wow64"];
const MEDIA_PREFERENCES = {
  colorScheme: ["dark", "light"].map(value => `(prefers-color-scheme: ${value})`),
  reducedMotion: ["(prefers-reduced-motion: reduce)"],
  reducedTransparency: ["(prefers-reduced-transparency: reduce)"],
  contrast: ["more", "less", "custom"].map(value => `(prefers-contrast: ${value})`),
  forcedColors: ["(forced-colors: active)"],
  invertedColors: ["(inverted-colors: inverted)"],
  pointer: ["fine", "coarse", "none"].map(value => `(pointer: ${value})`),
  hover: ["(hover: hover)"],
};

function browserFacts(navigator, window) {
  const data = navigator.userAgentData;
  const connection = navigator.connection;
  const media = query => window.matchMedia?.(query).matches ?? null;
  return {
    userAgent: navigator.userAgent,
    brands: data?.brands ?? null,
    mobile: data?.mobile ?? null,
    platform: data?.platform ?? navigator.platform ?? null,
    vendor: navigator.vendor ?? null,
    languages: [...(navigator.languages ?? [navigator.language])],
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    timeZoneOffsetMinutes: new Date().getTimezoneOffset(),
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    deviceMemoryGb: navigator.deviceMemory ?? null,
    onLine: navigator.onLine ?? null,
    connection: connection ? { effectiveType: connection.effectiveType, downlinkMbps: connection.downlink, rttMs: connection.rtt, saveData: connection.saveData } : null,
    webdriver: navigator.webdriver ?? null,
    features: {
      crossOriginIsolated: window.crossOriginIsolated === true,
      sharedArrayBuffer: typeof window.SharedArrayBuffer === "function",
      webAssembly: typeof window.WebAssembly === "object",
      opfs: typeof navigator.storage?.getDirectory === "function",
      measureUserAgentSpecificMemory: typeof window.performance?.measureUserAgentSpecificMemory === "function",
      speechSynthesis: typeof window.speechSynthesis === "object",
      webGpu: typeof navigator.gpu === "object",
    },
    media: Object.fromEntries(Object.entries(MEDIA_PREFERENCES).map(([key, queries]) =>
      [key, Object.fromEntries(queries.map(query => [query, media(query)]))])),
    screen: window.screen ? { width: window.screen.width, height: window.screen.height, availWidth: window.screen.availWidth,
      availHeight: window.screen.availHeight, colorDepth: window.screen.colorDepth, devicePixelRatio: window.devicePixelRatio } : null,
    viewport: { width: window.innerWidth ?? null, height: window.innerHeight ?? null },
  };
}

function pageMemory(window) {
  const memory = window.performance?.memory;
  return memory ? { usedJSHeapSize: memory.usedJSHeapSize, totalJSHeapSize: memory.totalJSHeapSize, jsHeapSizeLimit: memory.jsHeapSizeLimit } : null;
}

// Every file and directory in the origin private file system with its size.
// Names are dictionary IDs and generation paths, not reader content.
export async function listOpfs(directory, path = "") {
  const entries = [];
  let bytes = 0;
  for await (const [name, handle] of directory.entries()) {
    const child = `${path}/${name}`;
    if (handle.kind === "directory") {
      const listed = await listOpfs(handle, child);
      bytes += listed.bytes;
      entries.push({ path: child, kind: "directory", bytes: listed.bytes }, ...listed.entries);
    } else {
      try {
        const file = await handle.getFile();
        bytes += file.size;
        entries.push({ path: child, kind: "file", bytes: file.size, lastModified: new Date(file.lastModified).toISOString() });
      } catch (error) {
        entries.push({ path: child, kind: "file", error: probeFailureText(error) });
      }
    }
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return { bytes, entries };
}

async function listCaches(caches) {
  const names = await caches.keys();
  return Promise.all(names.map(async name => ({ name, entries: (await (await caches.open(name)).keys()).length })));
}

// Registered scripts by identity and match patterns; a custom script's code
// is already in the options.
const scriptSummary = scripts => scripts.map(({ id, matches, excludeMatches, allFrames, runAt, world }) =>
  ({ id, matches, excludeMatches, allFrames, runAt, world }));

// `send(type, fields, target)` is Settings' runtime message helper; `targets`
// names the worker, sharing and Anki message targets; `context` is what only
// the page knows (its host capabilities and the visible state).
export async function collectDebugInfo({ chrome, window, send, targets, context = {}, now = () => new Date(),
  timeoutMs = DEBUG_PROBE_TIMEOUT_MS }) {
  const { navigator } = window;
  const startedAt = now();
  const manifest = chrome.runtime.getManifest();
  const results = await probeAll({
    os: () => chrome.runtime.getPlatformInfo(),
    userAgentHints: () => navigator.userAgentData.getHighEntropyValues(HIGH_ENTROPY_HINTS),
    self: () => chrome.management.getSelf(),
    fileSchemeAccess: () => chrome.extension.isAllowedFileSchemeAccess(),
    incognitoAccess: () => chrome.extension.isAllowedIncognitoAccess(),
    permissions: () => chrome.permissions.getAll(),
    commands: () => chrome.commands.getAll(),
    contexts: async () => (await chrome.runtime.getContexts({})).map(({ contextType, documentUrl, documentOrigin, incognito, frameId, tabId }) =>
      ({ contextType, documentUrl, documentOrigin, incognito, frameId, tabId })),
    alarms: async () => (await chrome.alarms.getAll()).map(alarm => ({ ...alarm, scheduledAt: new Date(alarm.scheduledTime).toISOString() })),
    // Chrome exposes the API only while the extension's Allow User Scripts is on.
    userScripts: async () => chrome.userScripts
      ? { available: true, scripts: scriptSummary(await chrome.userScripts.getScripts()) } : { available: false },
    contentScripts: async () => scriptSummary(await chrome.scripting.getRegisteredContentScripts()),
    storageEstimate: () => navigator.storage.estimate(),
    storagePersisted: () => navigator.storage.persisted(),
    localBytesInUse: () => chrome.storage.local.getBytesInUse(null),
    sessionBytesInUse: () => chrome.storage.session.getBytesInUse(null),
    syncBytesInUse: () => chrome.storage.sync.getBytesInUse(null),
    local: async () => summariseStorage(await chrome.storage.local.get(null)),
    indexedDb: () => window.indexedDB.databases(),
    opfs: async () => listOpfs(await navigator.storage.getDirectory()),
    caches: () => listCaches(window.caches),
    engineStatus: () => send("hd_status"),
    engineMemory: () => send("hd_memory"),
    extensionMemory: () => send("hd_memory_total"),
    engineLogs: () => send("hd_debug_log"),
    workerLog: () => send("hd_debug_log", {}, targets.worker),
    dictionaryState: () => send("hd_state_read", {}, targets.worker),
    automaticBackups: () => send("hd_backup_auto_list", {}, targets.worker),
    sharing: () => send("hd_sharing_status", {}, targets.sharing),
    anki: () => send("hd_anki_status", {}, targets.anki),
    settingsLog: () => readDebugLog(window),
  }, timeoutMs);
  return {
    schemaVersion: DEBUG_INFO_SCHEMA_VERSION,
    generatedAt: startedAt.toISOString(),
    collectionMs: now() - startedAt,
    extension: {
      id: chrome.runtime.id,
      name: manifest.name,
      version: manifest.version,
      versionName: manifest.version_name ?? null,
      self: results.self,
      fileSchemeAccess: results.fileSchemeAccess,
      incognitoAccess: results.incognitoAccess,
      permissions: results.permissions,
      commands: results.commands,
      contexts: results.contexts,
      alarms: results.alarms,
      userScripts: results.userScripts,
      contentScripts: results.contentScripts,
      manifest,
    },
    browser: { ...browserFacts(navigator, window), userAgentHints: results.userAgentHints, os: results.os },
    settingsPage: {
      url: window.location.href, visibilityState: window.document?.visibilityState ?? null,
      uptimeMs: Math.round(window.performance?.now() ?? 0), memory: pageMemory(window), ...redactSecrets(context),
    },
    engine: { status: results.engineStatus, memory: results.engineMemory, extensionMemory: results.extensionMemory },
    dictionaries: redactSecrets(results.dictionaryState),
    services: {
      anki: results.anki,
      sharing: redactSecrets(results.sharing),
      automaticBackups: results.automaticBackups,
    },
    logs: { serviceWorker: results.workerLog, engine: results.engineLogs, settings: results.settingsLog },
    storage: {
      estimate: results.storageEstimate, persisted: results.storagePersisted,
      bytesInUse: { local: results.localBytesInUse, session: results.sessionBytesInUse, sync: results.syncBytesInUse },
      local: results.local, indexedDb: results.indexedDb, opfs: results.opfs, caches: results.caches,
    },
  };
}

export function debugInfoFilename(date) {
  const stamp = date.toISOString().replace(/\.\d+Z$/u, "Z").replaceAll(":", "-");
  return `hachidori-debug-${stamp}.json`;
}

export function debugInfoBlob(report) {
  return new Blob([`${JSON.stringify(report, null, 2)}\n`], { type: "application/json" });
}
