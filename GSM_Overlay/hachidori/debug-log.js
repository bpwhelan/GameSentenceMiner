// The debug log behind Settings → Advanced → Troubleshooting → Get debug info.
//
// Each extension context (service worker, offscreen document, engine worker,
// Settings, the startup page, the toolbar) installs one capture on its global
// as it starts. console.warn/error, uncaught errors, unhandled rejections and
// fetches that fail without a response are recorded as they happen; answered
// request failures are added with recordDebugFailure(), the errors a page shows
// the reader with recordUserError(), and what the reader did on a page (the
// control pressed or changed, the section opened: names, never values) by
// captureDocumentActions(). Content scripts on web pages are not captured.
//
// Every context keeps its newest DEBUG_LOG_LIMIT entries in memory and appends
// them to one IndexedDB ring the extension's contexts share, in one
// transaction for what each task recorded (and whatever arrived while the
// previous write ran). The ring keeps the newest DEBUG_LOG_MAX_ENTRIES entries
// within DEBUG_LOG_MAX_BYTES, so an error from before Settings was opened,
// reloaded or the browser restarted is still in the report. Identical entries
// in a row are kept once, with a count and the time of the last one.
//
// Nothing is sent anywhere: the report reads the ring and each live context's
// entries on request. Every entry is redacted before it is kept
// (redactDebugText): credentials, the sign-in, query and fragment of web
// addresses, data: URL payloads, and any Japanese text, which is how
// looked-up text and dictionary content would appear in a message, as well
// as text in the other profiles' languages (setDebugLogLanguages).
// SPDX-License-Identifier: GPL-3.0-or-later

export const DEBUG_LOG = Symbol.for("hachidori.debugLog");
export const DEBUG_LOG_LIMIT = 200;
export const DEBUG_LOG_MESSAGE_LIMIT = 4000;
export const DEBUG_LOG_DATABASE = "hachidori-debug-log";
export const DEBUG_LOG_MAX_ENTRIES = 5000;
export const DEBUG_LOG_MAX_BYTES = 2 * 1024 * 1024;
export const REDACTED = "[redacted]";
export const REDACTED_JAPANESE = "[ja]";

// Settings keys and message fields that hold a credential.
const SECRET_KEY = /api.?key|token|secret|password/iu;
const SECRET_FIELD = new RegExp(String.raw`(["']?[\w-]*(?:${SECRET_KEY.source})[\w-]*["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s"',;&}]+)`, "giu");
const AUTHORIZATION = /\b(Bearer|Basic)\s+[\w.~+/=-]+/gu;
const WEB_ADDRESS = /\b(?:https?|wss?|ftp|file):\/\/[^\s"'<>`]+/giu;
const DATA_URL = /\bdata:([^,\s"'<>`]*),[^\s"'<>`)]*/giu;
// Percent-encoded non-ASCII text in an address path.
const ENCODED_TEXT = /(?:%[89a-f][\da-f])+/giu;
const JAPANESE_TEXT = /[\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Han}]+/gu;

// Text in the languages of the installation's other profiles (docs/languages.md
// 8.5): each pack's expanded text.pattern, less the Latin letters the log's own
// English is written in, replaced by "[code]" after the Japanese pattern. Packs
// written only in Latin add nothing.
let debugLanguageCodes = "";
let debugLanguageText = [];

// The languages of the profiles in the options record this context adopted.
// An empty list, or Japanese alone, keeps today's redaction.
export function setDebugLogLanguages(codes) {
  const others = [...new Set(codes)].filter(code => code !== "ja");
  if (others.join() === debugLanguageCodes) return;
  debugLanguageCodes = others.join();
  debugLanguageText = others.flatMap(code => {
    const pack = globalThis.HDLanguages?.get?.(code);
    if (typeof pack?.text?.pattern !== "string" || !pack.scripts?.some(script => script !== "Latn")) return [];
    return [[new RegExp(String.raw`(?:(?!\p{Script=Latin})${pack.text.pattern})+`, "gu"), `[${code}]`]];
  });
}

// Replace every non-empty string under a credential-like key, at any depth.
// An empty value stays empty so the report still shows it was never set.
export function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
    SECRET_KEY.test(key) && typeof entry === "string" && entry !== "" ? REDACTED : redactSecrets(entry)]));
}

// A web address keeps its scheme, host and path; sign-in details, query and
// fragment are removed, and a local file keeps none of its path.
function redactWebAddress(match) {
  // Punctuation that ends a sentence or a stack frame is not part of it.
  let end = match.length;
  while (end > 0 && ").,;:".includes(match[end - 1])) end -= 1;
  const trailing = match.slice(end);
  let url;
  try {
    url = new URL(match.slice(0, end));
  } catch {
    return REDACTED + trailing;
  }
  if (url.protocol === "file:") return `file:///${REDACTED}${trailing}`;
  const signIn = url.username || url.password ? REDACTED + "@" : "";
  const query = url.search ? "?" + REDACTED : "";
  const fragment = url.hash ? "#" + REDACTED : "";
  return `${url.protocol}//${signIn}${url.host}${url.pathname.replace(ENCODED_TEXT, REDACTED)}${query}${fragment}${trailing}`;
}

// A quoted credential stays quoted.
function redactSecretField(_match, name, value) {
  return name + (/^["']/u.test(value) ? `"${REDACTED}"` : REDACTED);
}

export function redactDebugText(value) {
  let text = String(value).slice(0, 2 * DEBUG_LOG_MESSAGE_LIMIT)
    .replace(DATA_URL, (_match, type) => `data:${type},${REDACTED}`)
    .replace(WEB_ADDRESS, redactWebAddress)
    .replace(AUTHORIZATION, `$1 ${REDACTED}`)
    .replace(SECRET_FIELD, redactSecretField)
    .replace(JAPANESE_TEXT, REDACTED_JAPANESE);
  for (const [pattern, label] of debugLanguageText) text = text.replace(pattern, label);
  return text.length > DEBUG_LOG_MESSAGE_LIMIT ? `${text.slice(0, DEBUG_LOG_MESSAGE_LIMIT)}…` : text;
}

// An Error, a DOMException, or an error from another realm.
function errorLike(value) {
  return value instanceof Error
    || (value !== null && typeof value === "object" && typeof value.message === "string" && typeof value.stack === "string");
}

function formatPart(value) {
  if (errorLike(value)) return `${value.name || "Error"}: ${value.message}`;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(redactSecrets(value)) ?? String(value);
  } catch {
    return String(value);
  }
}

function describeCause(cause, depth = 0) {
  if (cause === undefined || cause === null || depth === 3) return "";
  if (!errorLike(cause)) return formatPart(cause);
  const deeper = describeCause(cause.cause, depth + 1);
  const described = cause.stack || formatPart(cause);
  return deeper ? `${described}\nCaused by: ${deeper}` : described;
}

// The stack, cause chain and error code of `error`, unredacted.
function errorDetails(error) {
  if (!errorLike(error)) return {};
  const code = error.code ?? error.errorCode;
  return { stack: error.stack, cause: describeCause(error.cause),
    code: typeof code === "string" || typeof code === "number" ? code : null };
}

// One kept entry. `where` names the page element that showed it; the stack,
// cause and code come from `error`. Each text field is redacted, and only the
// fields that are set are kept.
function debugLogEntry({ at, session, n, context, version, level, message, where = null, detail = null,
  error = null }) {
  const entry = { at, session, n, context, version, level, message: redactDebugText(message) };
  const fields = { where, detail, ...errorDetails(error) };
  for (const [field, value] of Object.entries(fields)) {
    if (value !== null && value !== undefined && value !== "") entry[field] = redactDebugText(value);
  }
  return entry;
}

function newSessionId(scope) {
  const crypto = scope.crypto ?? globalThis.crypto;
  return crypto.randomUUID().replaceAll("-", "").slice(0, 12);
}

/* ------------------------------------------------------------ the ring */

const EVENTS = "events";
const META = "meta";
const TOTALS = "totals";

// A request's result, or its error. A cursor's request settles once per call:
// call again after continue() or advance() for the next position. The search
// page's line history (search-history.js) waits on its requests with these too.
export function settled(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Resolves once `transaction` commits; rejects with its error, or names
// `store` when it aborts without one.
export function committed(transaction, store = "debug log") {
  const done = new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error(`the ${store} transaction was aborted`));
  });
  // A request that fails first is what the operation reports.
  done.catch(() => {});
  return done;
}

// Delete the oldest records until the ring is within both limits.
function prune(events, totals, maxEntries, maxBytes) {
  if (totals.count <= maxEntries && totals.bytes <= maxBytes) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cursor = events.openCursor();
    cursor.onerror = () => reject(cursor.error);
    cursor.onsuccess = () => {
      const oldest = cursor.result;
      if (oldest === null) {
        Object.assign(totals, { count: 0, bytes: 0 });
        resolve();
        return;
      }
      if (totals.count <= maxEntries && totals.bytes <= maxBytes) {
        resolve();
        return;
      }
      totals.count -= 1;
      totals.bytes -= oldest.value?.bytes ?? 0;
      oldest.delete();
      oldest.continue();
    };
  });
}

// The extension origin's ring. A record's `bytes` is its JSON size; the meta
// store keeps the count and byte total that one transaction updates with the
// records, so concurrent writers from several contexts keep it exact.
export function openDebugLogStore(indexedDB, { name = DEBUG_LOG_DATABASE, maxEntries = DEBUG_LOG_MAX_ENTRIES,
  maxBytes = DEBUG_LOG_MAX_BYTES } = {}) {
  let database = null;

  function open() {
    database ??= new Promise((resolve, reject) => {
      const opening = indexedDB.open(name, 1);
      opening.onupgradeneeded = () => {
        opening.result.createObjectStore(EVENTS, { autoIncrement: true });
        opening.result.createObjectStore(META);
      };
      opening.onsuccess = () => {
        const opened = opening.result;
        opened.onversionchange = () => {
          opened.close();
          database = null;
        };
        resolve(opened);
      };
      opening.onerror = () => reject(opening.error);
    }).catch((error) => {
      database = null;
      throw error;
    });
    return database;
  }

  // `ops` are { record, key }: a record to add, or to put at `key` if that
  // record is still kept. Resolves to each record's key.
  async function write(ops) {
    const transaction = (await open()).transaction([EVENTS, META], "readwrite");
    const done = committed(transaction);
    const events = transaction.objectStore(EVENTS);
    const meta = transaction.objectStore(META);
    const totals = { count: 0, bytes: 0, ...await settled(meta.get(TOTALS)) };
    const kept = await Promise.all(ops.map(({ key }) => key === undefined ? undefined : settled(events.get(key))));
    const keys = await Promise.all(ops.map(({ record, key }, index) => {
      if (kept[index] === undefined) {
        totals.count += 1;
        totals.bytes += record.bytes;
        return settled(events.add(record));
      }
      events.put(record, key);
      totals.bytes += record.bytes - (kept[index].bytes ?? 0);
      return key;
    }));
    await prune(events, totals, maxEntries, maxBytes);
    meta.put(totals, TOTALS);
    await done;
    return keys;
  }

  // Every kept record, oldest first, with the totals.
  async function read() {
    const transaction = (await open()).transaction([EVENTS, META], "readonly");
    const [records, totals] = await Promise.all([
      settled(transaction.objectStore(EVENTS).getAll()),
      settled(transaction.objectStore(META).get(TOTALS)),
    ]);
    return { records, totals: { count: 0, bytes: 0, ...totals }, maxEntries, maxBytes };
  }

  return { name, write, read };
}

const jsonBytes = value => new TextEncoder().encode(JSON.stringify(value)).length;

function storedRecord(entry) {
  const { key, ...record } = entry;
  record.bytes = 0;
  record.bytes = jsonBytes(record);
  return record;
}

// A record another document sends for the ring, as the search page's frame
// does (#644): only its text, numbers and flags, the text redacted again, and
// its size measured here, so the ring's totals stay exact. Each text keeps its
// DEBUG_LOG_MESSAGE_LIMIT but the fields are not counted, so the frame's code,
// the user's own script among it, can empty the ring with one record larger
// than DEBUG_LOG_MAX_BYTES. The ring holds only the user's own debug info.
export function debugLogRecord(value) {
  const record = {};
  for (const [field, entry] of Object.entries(value ?? {})) {
    if (typeof entry === "string") record[field] = redactDebugText(entry);
    else if (["number", "boolean"].includes(typeof entry) || entry === null) record[field] = entry;
  }
  return storedRecord(record);
}

/* ------------------------------------------------------------ capture */

const sameEntry = (left, right) => left.level === right.level && left.message === right.message
  && left.where === right.where && left.stack === right.stack;

// The extension's version. An offscreen document and a dedicated worker have
// no chrome.runtime.getManifest; they read the manifest once something is
// written.
function manifestVersion(scope) {
  const manifest = scope.chrome?.runtime?.getManifest?.();
  if (manifest) return manifest.version;
  if (typeof scope.fetch !== "function" || !scope.location) return null;
  return async () => (await (await scope.fetch(new URL("/manifest.json", scope.location.href))).json()).version;
}

// `store` is openDebugLogStore()'s ring, or null to keep entries in memory
// only. `version` is the extension's, or a function that resolves it.
export function captureDebugLog(scope, { context, store = null, now = () => Date.now(),
  version = manifestVersion(scope), session = newSessionId(scope) }) {
  if (scope[DEBUG_LOG]) return scope[DEBUG_LOG];
  const startedAt = new Date(now()).toISOString();
  const entries = [];
  const unsaved = new Set();
  const persistence = { saved: 0, error: store === null ? "not persisted in this context" : null };
  let count = 0;
  let last = null;
  let queued = false;
  let writing = Promise.resolve();
  let resolvedVersion = typeof version === "function" ? null : version;
  let versionRead = typeof version === "function" ? null : Promise.resolve(version);

  function keep(entry, save = true) {
    entries.push(entry);
    if (entries.length > DEBUG_LOG_LIMIT) entries.splice(0, entries.length - DEBUG_LOG_LIMIT);
    last = entry;
    if (save) schedule(entry);
    return entry;
  }

  function add(level, message, fields = {}, save = true) {
    count += 1;
    const entry = debugLogEntry({ at: new Date(now()).toISOString(), session, n: count, context,
      version: resolvedVersion, level, message, ...fields });
    if (last !== null && sameEntry(last, entry)) {
      last.repeat = (last.repeat ?? 1) + 1;
      last.lastAt = entry.at;
      count -= 1;
      if (save) schedule(last);
      return last;
    }
    return keep(entry, save);
  }

  function schedule(entry) {
    if (store === null) return;
    unsaved.add(entry);
    if (queued) return;
    queued = true;
    // Once the current task has recorded what it will: a reload or a crash
    // moments later must not lose it, and a timer would wait out the
    // throttling of a hidden page.
    void Promise.resolve().then(() => {
      queued = false;
      return flush();
    });
  }

  async function save() {
    if (unsaved.size === 0) return;
    const batch = [...unsaved];
    unsaved.clear();
    try {
      versionRead ??= Promise.resolve().then(version).catch(() => null);
      resolvedVersion = await versionRead;
      for (const entry of batch) entry.version ??= resolvedVersion;
      const keys = await store.write(batch.map(entry => ({ key: entry.key, record: storedRecord(entry) })));
      batch.forEach((entry, index) => { entry.key = keys[index]; });
      persistence.saved += batch.length;
      persistence.error = null;
    } catch (error) {
      // Still in memory: the next write retries them.
      for (const entry of batch) if (entries.includes(entry)) unsaved.add(entry);
      const description = error?.message || String(error);
      if (persistence.error !== description) {
        persistence.error = description;
        add("debug-log", `the debug log could not be saved: ${description}`, {}, false);
      }
    }
  }

  function flush() {
    writing = writing.then(save);
    return writing;
  }

  function record(level, ...parts) {
    const error = parts.find(errorLike) ?? null;
    return add(level, parts.map(formatPart).join(" "), { error });
  }

  // `message` as the page showed it, with the error behind it.
  function recordUserError(where, message, error = null, detail = null) {
    return add("user-error", message, { where, error, detail });
  }

  function recordAction(name) {
    return add("action", name);
  }

  const console = scope.console;
  for (const level of ["warn", "error"]) {
    const original = console[level];
    console[level] = function captured(...args) {
      record(level, ...args);
      return original.apply(this, args);
    };
  }
  scope.addEventListener?.("error", event => record("uncaught", event.error ?? event.message));
  scope.addEventListener?.("unhandledrejection", event => record("unhandledrejection", event.reason));
  // A page about to unload writes what is waiting.
  scope.addEventListener?.("pagehide", () => flush());
  const fetch = scope.fetch;
  if (typeof fetch === "function") {
    scope.fetch = function capturedFetch(input, init) {
      return fetch.call(scope, input, init).catch((error) => {
        if (error?.name !== "AbortError") {
          const method = init?.method ?? input?.method ?? "GET";
          record("failed-fetch", `${method} ${typeof input === "string" ? input : input?.url ?? String(input)}:`, error);
        }
        throw error;
      });
    };
  }

  const log = {
    context, session, startedAt, record, recordUserError, recordAction, flush,
    entries: () => entries.map(({ key, ...entry }) => entry),
    status: () => ({ context, session, startedAt, version: resolvedVersion, saved: persistence.saved,
      unsaved: unsaved.size, error: persistence.error }),
  };
  scope[DEBUG_LOG] = log;
  return log;
}

// This context's entries, written to the ring first so a report that reads
// the ring next finds them there.
export async function readDebugLog(scope) {
  const log = scope[DEBUG_LOG];
  if (!log) return { context: null, entries: [] };
  await log.flush();
  return { ...log.status(), entries: log.entries() };
}

// Add an answered request failure to this context's log, if it has one.
export function recordDebugFailure(scope, type, error) {
  scope[DEBUG_LOG]?.record("failed-request", `${type}:`, error);
}

// Add an error the page shows the reader; returns the kept entry.
export function recordUserError(scope, where, message, error = null, detail = null) {
  return scope[DEBUG_LOG]?.recordUserError(where, message, error, detail) ?? null;
}

/* ------------------------------------------------------------ the reader's actions */

const ACTION_TARGETS = "button, a[href], summary, [role='button'], [role='tab'], [role='menuitem']";

// A control by its id, or by its tag and first class inside the nearest
// element with an id. Never its text or value.
function debugActionTarget(element) {
  if (element.id) return `#${element.id}`;
  const name = element.classList?.[0] ? `${element.localName}.${element.classList[0]}` : element.localName;
  const owner = element.parentElement?.closest("[id]");
  return owner ? `${name} in #${owner.id}` : name;
}

export function captureDocumentActions(document, log) {
  const view = document.defaultView;
  document.addEventListener("click", (event) => {
    const target = event.target?.closest?.(ACTION_TARGETS);
    if (target) log.recordAction(`click ${debugActionTarget(target)}`);
  }, { capture: true, passive: true });
  document.addEventListener("change", (event) => {
    const target = event.target;
    if (!target?.matches?.("input, select, textarea")) return;
    const files = target.type === "file" ? ` (${target.files?.length ?? 0} files)` : "";
    log.recordAction(`change ${debugActionTarget(target)}${files}`);
  }, { capture: true, passive: true });
  view.addEventListener("hashchange", () => log.recordAction(`navigate ${view.location.hash || "#"}`));
  log.recordAction(`open ${view.location.pathname.split("/").pop()}${view.location.hash}`);
}

// What "Copy error details" puts on the clipboard: the error as the page
// showed it, its stack and cause, and what this page did before it.
export function formatDebugErrorReport(log, entry, { userAgent = "", before = 12 } = {}) {
  const kept = log.entries();
  const index = kept.findIndex(item => item.n === entry.n);
  const earlier = (index < 0 ? [] : kept.slice(Math.max(0, index - before), index)).map((item) => {
    const level = item.level === "action" ? "" : item.level + ": ";
    const repeat = item.repeat ? ` (×${item.repeat})` : "";
    return `  ${item.at.slice(11, 23)} ${level}${item.message}${repeat}`;
  });
  return [
    `Hachidori ${entry.version ?? "(unknown version)"} · ${log.context} · session ${entry.session}`,
    entry.where ? `${entry.at} · ${entry.where}` : entry.at,
    entry.message,
    ...(entry.detail ? [entry.detail] : []),
    ...(entry.code ? [`Code: ${entry.code}`] : []),
    ...(entry.stack ? [entry.stack] : []),
    ...(entry.cause ? [`Caused by: ${entry.cause}`] : []),
    ...(earlier.length ? ["Before this, on this page:", ...earlier] : []),
    ...(userAgent ? [`Browser: ${userAgent}`] : []),
  ].join("\n");
}
