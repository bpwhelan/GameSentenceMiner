// Recent warnings and errors for Settings → Advanced → Get debug info. Each
// extension context (service worker, offscreen document, engine worker,
// Settings) installs one capture on its global: console.warn/error, uncaught
// errors and unhandled rejections are kept as text, and request failures that
// are answered rather than logged can be added with record(). Nothing is sent
// anywhere; the debug report reads each context's entries on request.
//
// The log is a ring of the newest DEBUG_LOG_LIMIT entries, each message cut to
// DEBUG_LOG_MESSAGE_LIMIT characters, so a burst of failures (every hover while
// the engine is down) cannot grow a context's memory or the service worker's
// session-storage copy without bound.
// SPDX-License-Identifier: GPL-3.0-or-later

export const DEBUG_LOG = Symbol.for("hachidori.debugLog");
export const DEBUG_LOG_LIMIT = 200;
export const DEBUG_LOG_MESSAGE_LIMIT = 4000;
export const DEBUG_LOG_SESSION_KEY = "debugLog";

function formatPart(value) {
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function formatDebugLogMessage(parts) {
  const message = parts.map(formatPart).join(" ");
  return message.length > DEBUG_LOG_MESSAGE_LIMIT ? `${message.slice(0, DEBUG_LOG_MESSAGE_LIMIT)}…` : message;
}

// `persist(entries)` (the service worker's session storage) is called after
// each new entry. `restore()` reads back what a restarted worker persisted;
// those entries are placed before any recorded meanwhile, and nothing is
// persisted until they are, so a restart cannot overwrite them.
export function captureDebugLog(scope, { context, now = () => Date.now(), persist = null, restore = null }) {
  if (scope[DEBUG_LOG]) return scope[DEBUG_LOG];
  let entries = [];
  const startedAt = new Date(now()).toISOString();
  const restored = restore === null ? Promise.resolve() : Promise.resolve().then(restore).then(
    previous => { if (Array.isArray(previous)) entries = [...previous, ...entries].slice(-DEBUG_LOG_LIMIT); },
    () => {});
  let persisted = restored;

  function record(level, ...parts) {
    entries.push({ at: new Date(now()).toISOString(), context, level, message: formatDebugLogMessage(parts) });
    if (entries.length > DEBUG_LOG_LIMIT) entries.splice(0, entries.length - DEBUG_LOG_LIMIT);
    if (persist) persisted = persisted.then(() => persist(entries.slice())).catch(() => {});
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

  const log = { context, startedAt, record, entries: async () => { await restored; return entries.slice(); } };
  scope[DEBUG_LOG] = log;
  return log;
}

// The service worker restarts often; its log survives that in session storage
// (cleared when the browser closes) so the entries before a restart remain.
export function captureWorkerDebugLog(scope, session) {
  return captureDebugLog(scope, { context: "service-worker",
    restore: async () => (await session.get(DEBUG_LOG_SESSION_KEY))[DEBUG_LOG_SESSION_KEY],
    persist: entries => session.set({ [DEBUG_LOG_SESSION_KEY]: entries }) });
}

export async function readDebugLog(scope) {
  const log = scope[DEBUG_LOG];
  return log ? { context: log.context, startedAt: log.startedAt, entries: await log.entries() } : { context: null, entries: [] };
}

// Add an answered request failure to this context's log, if it has one.
export function recordDebugFailure(scope, type, error) {
  scope[DEBUG_LOG]?.record("failed-request", `${type}:`, error);
}
