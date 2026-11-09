// The search page's line history (docs/search-history.md): every line that
// enters the search box, typed and searched, pasted, or read by the Clipboard
// monitor, with its time, its source and the window it was searched in.
// It is an IndexedDB database of the extension's origin, as the debug log is
// (debug-log.js), rather than chrome.storage.local: every chrome.storage
// change goes to every extension context and every web page's reader, and a
// line is added each time the clipboard changes. search.html opens it for the
// frame it holds (search-shell.js), and Settings for its count and Clear
// history. A BroadcastChannel of the same name tells the other open pages of
// each change. A profile key can be added later as a `profile` field with an
// index, in version 2: lines without one are the Japanese profile's.
// SPDX-License-Identifier: GPL-3.0-or-later
import { committed, settled } from "./debug-log.js";

export const SEARCH_HISTORY_DATABASE = "hachidori-search-history";
// How a line entered the box: searched from the box, pasted outside a text
// field, or read by the Clipboard monitor.
export const LINE_SOURCES = Object.freeze(["typed", "paste", "clipboard"]);
// The search page it was searched in: a tab, or the popup window.
export const LINE_PAGES = Object.freeze(["tab", "popup"]);
const LINES = "lines";

// The values a cursor walks over, up to `limit` of them.
function collected(request, limit) {
  return new Promise((resolve, reject) => {
    const found = [];
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) found.push(cursor.value);
      if (cursor && found.length < limit) cursor.continue();
      else resolve(found);
    };
  });
}

// A line's text, trimmed as the search box's text is searched.
function lineText(text) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed) throw new TypeError("A search history line needs text.");
  return trimmed;
}

function lineId(id, name = "id") {
  if (!Number.isSafeInteger(id) || id < 1) throw new TypeError(`A search history ${name} is a positive integer.`);
  return id;
}

function oneOf(value, values, name) {
  if (!values.includes(value)) throw new TypeError(`A search history line's ${name} is one of ${values.join(", ")}.`);
  return value;
}

// Opens the history lazily. `onChange` listeners hear each change made here or,
// through the channel, in another page: { type: "add", line }, { type: "edit",
// line }, { type: "remove", id }, { type: "clear" }, or { type: "prune", before }
// once the lines older than the id `before` are gone.
export function openSearchHistory({ indexedDB, IDBKeyRange = globalThis.IDBKeyRange,
  BroadcastChannel = globalThis.BroadcastChannel, name = SEARCH_HISTORY_DATABASE, now = () => Date.now() }) {
  let database = null;
  const listeners = new Set();
  const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(name) : null;
  const tell = (change) => { for (const listener of listeners) listener(change); };
  channel?.addEventListener("message", ({ data }) => tell(data));

  function emit(change) {
    tell(change);
    channel?.postMessage(change);
  }

  function open() {
    database ??= new Promise((resolve, reject) => {
      const opening = indexedDB.open(name, 1);
      opening.onupgradeneeded = () => {
        opening.result.createObjectStore(LINES, { keyPath: "id", autoIncrement: true });
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

  async function transaction(mode, work) {
    const opened = (await open()).transaction(LINES, mode);
    const done = committed(opened, "search history");
    const result = await work(opened.objectStore(LINES));
    await done;
    return result;
  }

  // Deletes the oldest lines beyond `limit` in one request; returns the id of
  // the oldest line kept, or null when nothing was over the limit.
  async function pruneWithin(lines, limit) {
    const count = await settled(lines.count());
    if (count <= limit) return null;
    const walk = lines.openCursor();
    const oldest = await settled(walk);
    oldest.advance(count - limit);
    const kept = await settled(walk);
    await settled(lines.delete(IDBKeyRange.upperBound(kept.key, true)));
    return kept.key;
  }

  // Keeps `line` ({ text, source, page }) unless it repeats the newest line,
  // and then the newest `limit` lines. Resolves to { line, added }: the line
  // kept, or the newest one it repeats.
  async function add(line, { limit }) {
    const record = { text: lineText(line?.text), at: now(), source: oneOf(line.source, LINE_SOURCES, "source"),
      page: oneOf(line.page, LINE_PAGES, "page") };
    lineId(limit, "limit");
    const { kept, pruned } = await transaction("readwrite", async (lines) => {
      const newest = await settled(lines.openCursor(null, "prev"));
      if (newest?.value.text === record.text) return { kept: newest.value, pruned: null };
      record.id = await settled(lines.add(record));
      return { kept: record, pruned: await pruneWithin(lines, limit) };
    });
    if (kept !== record) return { line: kept, added: false };
    emit({ type: "add", line: record });
    if (pruned !== null) emit({ type: "prune", before: pruned });
    return { line: record, added: true };
  }

  // Lines oldest first: every line, the newest `limit` lines before the id
  // `before`, or the oldest `limit` lines after the id `after`.
  function list({ before, after, limit } = {}) {
    if (before !== undefined) lineId(before, "position");
    if (after !== undefined) lineId(after, "position");
    if (limit !== undefined) lineId(limit, "limit");
    if (before !== undefined && after !== undefined) throw new TypeError("A search history list starts before or after a line, not both.");
    return transaction("readonly", async (lines) => {
      if (after !== undefined) return settled(lines.getAll(IDBKeyRange.lowerBound(after, true), limit));
      const range = before === undefined ? null : IDBKeyRange.upperBound(before, true);
      if (limit === undefined) return settled(lines.getAll(range));
      return (await collected(lines.openCursor(range, "prev"), limit)).reverse();
    });
  }

  // Resolves to the line with its new text, or null when there is no such line.
  async function edit(id, text) {
    lineId(id);
    const next = lineText(text);
    const { line, changed } = await transaction("readwrite", async (lines) => {
      const stored = await settled(lines.get(id));
      if (!stored || stored.text === next) return { line: stored ?? null, changed: false };
      const edited = { ...stored, text: next };
      await settled(lines.put(edited));
      return { line: edited, changed: true };
    });
    if (changed) emit({ type: "edit", line });
    return line;
  }

  async function remove(id) {
    lineId(id);
    const removed = await transaction("readwrite", async (lines) => {
      if (!await settled(lines.get(id))) return false;
      await settled(lines.delete(id));
      return true;
    });
    if (removed) emit({ type: "remove", id });
    return removed;
  }

  // Deletes every line; resolves to how many there were.
  async function clear() {
    const count = await transaction("readwrite", async (lines) => {
      const kept = await settled(lines.count());
      await settled(lines.clear());
      return kept;
    });
    emit({ type: "clear" });
    return count;
  }

  // Keeps the newest `limit` lines, as add does.
  async function prune(limit) {
    lineId(limit, "limit");
    const pruned = await transaction("readwrite", lines => pruneWithin(lines, limit));
    if (pruned !== null) emit({ type: "prune", before: pruned });
    return pruned !== null;
  }

  const count = () => transaction("readonly", lines => settled(lines.count()));

  function onChange(listener) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  function close() {
    listeners.clear();
    channel?.close();
    void database?.then(opened => opened.close(), () => {});
    database = null;
  }

  return { name, add, list, edit, remove, clear, prune, count, onChange, close };
}
