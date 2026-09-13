import {
  httpsUrl,
  assertRecommendedDictionary,
  MANAGED_DICTIONARY_CHANGED,
  managedDictionaryFingerprint,
  managedDictionaryMatches,
  recommendedDictionarySource,
  recommendedDownloadUrlMatches,
} from "./managed-dictionary-source.js";
import {
  CUSTOM_DICTIONARY_ID,
  CUSTOM_DICTIONARY_TITLE,
  appendCustomDictionaryEntry,
  buildCustomDictionaryZip,
  customDictionarySemanticRevision,
  customDictionaryMetadataMatches,
  normaliseCustomDictionaryDocument,
  parseCustomDictionary,
} from "./custom-dictionary.js";
import { sameJsonValue } from "./json-value.js";
import {
  boundResponseFailure,
  isBoundedRequest,
  responseFits,
  responseLimitError,
  validResponseRequestId,
} from "./response-limits.js";

/*
 * Owns the single hoshidicts engine instance inside a dedicated Web Worker.
 *
 * Everything that touches the engine runs on one promise chain: the engine is
 * not reentrant, and an import must never interleave with a lookup. Blocking the
 * worker for the length of an import is safe: pthread joins and synchronous
 * OPFS access must not block the offscreen document's browser main thread.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const WORKER_TARGET = "hoshidicts-worker";
const DICT_ROOT = "/dicts";
const REMOVAL_ROOT = `${DICT_ROOT}/.hdw-remove`;
const GENERATION_PREFIX = ".hdw-generation-";
const GENERATION_NAME = /^\.hdw-generation-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const IMPORT_ZIP = "/.hdw-archive.zip";
const OPFS_IMPORT_ZIP = `${DICT_ROOT}/.hdw-archive.zip`;

// Index into this array is the `kind` argument of hdw_add_dict.
const KINDS = ["term", "freq", "pitch", "kanji"];

// A directory holding one of these is an imported dictionary; anything else
// under /dicts is debris. _4 means the importer trained a zstd dictionary for
// the term banks and wrote a dict.zstd alongside; _3 means it did not, which is
// also how every dictionary imported by an older engine looks. Both load, so the
// presence of dict.zstd is deliberately not part of the test.
const MARKER_FILES = [".hoshidicts_4", ".hoshidicts_3", ".hoshidicts_2", ".hoshidicts_1"];

const FREQUENCY_ORDERS = ["auto", "ascending", "descending", "disabled"];
const DEFAULT_MAX_RESULTS = 32;
const DEFAULT_SCAN_LENGTH = 16;
const MAX_LOOKUP_TEXT_BYTES = 4 * 1024;
const MAX_MEDIA_DICTIONARY_BYTES = 1024;
const MAX_MEDIA_PATH_BYTES = 4 * 1024;
const UTF8 = new TextEncoder();

const BASE64_CHUNK = 0x8000;
const MEDIA_TYPES = {
  avif: "image/avif",
  webp: "image/webp",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
};

// No engine call, so this must not queue behind a long import: the settings page
// polls hd_status while one is running.
const UNQUEUED = new Set(["hd_status", "hd_backup_release"]);

// A storage read-modify-write spans two messages, so another context can write
// in between; the worker refuses the write when that happens and the change is
// recomputed from what is there now.
const STORAGE_ATTEMPTS = 3;

let engine = null;
// Set only when the engine itself is unusable -- the wasm did not compile, or
// its filesystem did not mount -- which nothing in this worker can undo.
let bootError = null;
// Set when the engine is fine but the dictionary list could not be read or
// written, which leaves nothing loaded. Recoverable, so it is reported and
// retried rather than latched.
let reloadError = null;
let ready = false;
let busy = 0;
let generation = 0;
let dictionaryCount = 0;
// Committed packages the engine could not load into its current set.
let loadFailures = [];
let hostRequest = null;
let started = false;
let createHoshidicts = null;
let storageBackend = "memory";
let lowRam = true;
// Optional sink for import download/installation phases, keyed by request ID.
let reportProgress = null;
// Download progress is a transient UI signal; one report per chunk would flood
// the host bridge on a fast connection.
const PROGRESS_INTERVAL_MS = 100;

export function configureEngineService(request, options = {}) {
  if (hostRequest !== null) {
    throw new Error("the engine service is already configured");
  }
  hostRequest = request;
  createHoshidicts = options.createHoshidicts;
  storageBackend = options.storageBackend ?? "memory";
  lowRam = options.lowRam !== false;
  reportProgress = typeof options.reportProgress === "function" ? options.reportProgress : null;
}

function describe(error) {
  if (error instanceof Error) {
    return error.message || String(error);
  }
  if (typeof error === "string") {
    return error;
  }
  return error?.message ? String(error.message) : JSON.stringify(error);
}

function asError(error) {
  return error instanceof Error ? error : new Error(describe(error));
}

class UnknownDictionaryStateCommitError extends Error {
  constructor(commitError, readError, subject = "dictionary state") {
    super(
      `${subject} commit outcome is unknown: ${describe(commitError)}; `
      + `readback failed: ${describe(readError)}`,
    );
    this.name = "UnknownDictionaryStateCommitError";
    this.cause = commitError;
  }
}

function text(value) {
  return typeof value === "string" ? value : "";
}

function usableDictionaryTitle(title) {
  return (
    title !== "" &&
    title !== "." &&
    title !== ".." &&
    title !== ".hdw-import" &&
    title !== ".hdw-remove" &&
    !title.includes("/") &&
    !title.includes("\\") &&
    !title.includes("\0")
  );
}

function clampInt(value, min, max, fallback) {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, number));
}

function parseJson(json, source) {
  try {
    return JSON.parse(json);
  } catch (error) {
    throw new Error(`${source} returned malformed JSON: ${describe(error)}`);
  }
}

function boundedText(value, label, maxBytes, cString = true) {
  const result = text(value);
  if (cString && result.includes("\0")) throw new Error(`${label} contains NUL`);
  // Three UTF-8 bytes per UTF-16 code unit is a conservative upper bound.
  if (result.length * 3 > maxBytes && UTF8.encode(result).byteLength > maxBytes) {
    throw new Error(`${label} exceeds the ${maxBytes}-byte limit`);
  }
  return result;
}

function lookupArguments(message) {
  return [
    boundedText(message.text, "lookup text", MAX_LOOKUP_TEXT_BYTES),
    clampInt(message.maxResults, 1, 256, DEFAULT_MAX_RESULTS),
    clampInt(message.scanLength, 1, 64, DEFAULT_SCAN_LENGTH),
    JSON.stringify({
      frequencyDictionary: boundedText(message.options?.frequencyDictionary, "frequency dictionary", MAX_LOOKUP_TEXT_BYTES, false),
      frequencyOrder: FREQUENCY_ORDERS.includes(message.options?.frequencyOrder)
        ? message.options.frequencyOrder : "auto",
      primaryReading: boundedText(message.options?.primaryReading, "primary reading", MAX_LOOKUP_TEXT_BYTES, false),
    }),
  ];
}

function termLookupReply(json, source) {
  const parsed = parseJson(json, source);
  if (!Array.isArray(parsed?.results) || !Number.isSafeInteger(parsed?.dictionaryCount)
      || parsed.dictionaryCount < 0) {
    throw new Error(`${source} returned a malformed lookup response`);
  }
  return { results: parsed.results, dictionaryCount: parsed.dictionaryCount, nativeJsonLength: json.length };
}

let tail = Promise.resolve();

function serialise(job) {
  busy += 1;
  const run = tail.then(() => job(), () => job());
  run.then(
    () => {
      busy -= 1;
    },
    () => {
      busy -= 1;
    },
  );
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function requireEngine() {
  if (!ready) {
    throw bootError ?? new Error("the dictionary engine is still starting");
  }
  return engine;
}

function lastError() {
  return engine.ccall("hdw_last_error", "string", [], []) || "unknown engine error";
}

// The engine's failure fallbacks are shape-valid and indistinguishable from a
// genuine empty answer -- hdw_lookup returns dictionaryCount 0 even with
// dictionaries loaded, which the content script would render as "no dictionaries
// imported". hdw_last_error is cleared on entry to every entry point, so a
// non-empty value here means the call we just made is the one that failed.
function throwIfEngineFailed(name) {
  const message = engine.ccall("hdw_last_error", "string", [], []);
  if (message !== "") {
    throw new Error(`${name}: ${message}`);
  }
}

function syncfs(populate) {
  return new Promise((resolve, reject) => {
    engine.FS.syncfs(populate, (error) => {
      if (error) {
        reject(asError(error));
      } else {
        resolve();
      }
    });
  });
}

async function persistFilesystem() {
  if (storageBackend === "idbfs") {
    await syncfs(false);
  }
}

function exists(path) {
  try {
    engine.FS.stat(path);
    return true;
  } catch (error) {
    return false;
  }
}

function createGenerationRoot() {
  const path = `${DICT_ROOT}/${GENERATION_PREFIX}${globalThis.crypto.randomUUID()}`;
  if (exists(path)) {
    throw new Error("the new dictionary generation path already exists");
  }
  return path;
}

function isGenerationRoot(path) {
  const prefix = `${DICT_ROOT}/`;
  return path.startsWith(prefix)
    && GENERATION_NAME.test(path.slice(prefix.length));
}

function dictionaryRoot(dictionary) {
  const title = text(dictionary?.title);
  const path = text(dictionary?.path);
  if (title === ""
      || title === "."
      || title === ".."
      || title === ".hdw-import"
      || title.includes("/")
      || title.includes("\\")
      || title.includes("\0")) {
    return null;
  }
  if (path === `${DICT_ROOT}/${title}`) {
    return path;
  }
  const separator = path.lastIndexOf("/");
  const root = path.slice(0, separator);
  return separator > DICT_ROOT.length
    && path === `${root}/${title}`
    && isGenerationRoot(root)
    ? root
    : null;
}

function isDirectory(stat) {
  return (stat.mode & 0o170000) === 0o040000;
}

function removeTree(path) {
  const FS = engine.FS;
  let stat;
  try {
    stat = FS.stat(path);
  } catch (error) {
    return;
  }
  if (!isDirectory(stat)) {
    FS.unlink(path);
    return;
  }
  for (const name of FS.readdir(path)) {
    if (name !== "." && name !== "..") {
      removeTree(`${path}/${name}`);
    }
  }
  FS.rmdir(path);
}

function removeEmptyDirectory(path) {
  if (exists(path) && engine.FS.readdir(path).every((name) => name === "." || name === "..")) {
    engine.FS.rmdir(path);
  }
}

function hasDictionaryMarker(path) {
  return MARKER_FILES.some((marker) => exists(`${path}/${marker}`));
}

function removeUnreferencedDictionaryRoot(name, referencedRoots) {
  if (name === "." || name === "..") {
    return false;
  }
  const path = `${DICT_ROOT}/${name}`;
  let stat;
  try {
    stat = engine.FS.stat(path);
  } catch (error) {
    return false;
  }
  if (!isDirectory(stat)) {
    return false;
  }
  if (GENERATION_NAME.test(name)) {
    if (referencedRoots.has(path)) {
      return false;
    }
  } else if (!hasDictionaryMarker(path) || referencedRoots.has(path)) {
    return false;
  }
  removeTree(path);
  return true;
}

async function cleanupUnreferencedDictionaries(dictionaries) {
  const referencedRoots = new Set(dictionaries.map((dictionary) => dictionaryRoot(dictionary)));
  if (referencedRoots.has(null)) {
    throw new Error("the committed dictionary state contains an invalid path");
  }
  let changed = false;
  for (const name of engine.FS.readdir(DICT_ROOT)) {
    changed = removeUnreferencedDictionaryRoot(name, referencedRoots) || changed;
  }
  if (changed) {
    await persistFilesystem();
  }
}

async function discardGeneration(path) {
  if (!isGenerationRoot(path)) {
    throw new Error("refusing to discard a path outside the dictionary generation namespace");
  }
  if (exists(path)) {
    removeTree(path);
    await persistFilesystem();
  }
}

function moveDictionaryFiles(source, destination, markerLast) {
  const FS = engine.FS;
  if (!exists(destination)) {
    FS.mkdir(destination);
  }
  const files = FS.readdir(source).filter((name) => name !== "." && name !== "..");
  for (const name of files) {
    if (isDirectory(FS.stat(`${source}/${name}`))) {
      throw new Error("an imported dictionary contains an unsupported nested path");
    }
  }
  const markers = files.filter((name) => MARKER_FILES.includes(name));
  const data = files.filter((name) => !MARKER_FILES.includes(name));
  for (const name of markerLast ? [...data, ...markers] : [...markers, ...data]) {
    FS.rename(`${source}/${name}`, `${destination}/${name}`);
  }
  removeEmptyDirectory(source);
}

function settleStagedRemoval(title, restore) {
  const stagedPath = `${REMOVAL_ROOT}/${title}`;
  if (!exists(stagedPath)) {
    return false;
  }
  if (restore) {
    moveDictionaryFiles(stagedPath, `${DICT_ROOT}/${title}`, true);
  } else {
    removeTree(stagedPath);
  }
  removeEmptyDirectory(REMOVAL_ROOT);
  return true;
}

function count(value) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function optionalText(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

function recommendedSourceForImport(message) {
  const sourceId = optionalText(message?.sourceId);
  const finalUrl = optionalText(message?.finalUrl);
  if (sourceId === null && finalUrl === null) {
    return null;
  }
  const source = recommendedDictionarySource(sourceId);
  if (!source) {
    throw new Error("the recommended import names an unknown catalogue source");
  }
  if (finalUrl !== null && !recommendedDownloadUrlMatches(source, finalUrl)) {
    throw new Error(`${source.name} downloaded from an unexpected final URL`);
  }
  return source;
}

function capabilities(value) {
  return [
    ["term", value.termCount],
    ["freq", value.frequencyCount],
    ["pitch", value.pitchCount],
    ["kanji", value.kanjiCount],
    ["media", value.mediaCount],
  ].filter(([, count]) => Number(count) > 0).map(([kind]) => kind);
}

function withRecommendedSource(dictionary, source) {
  return {
    ...dictionary,
    sourceId: source.sourceId,
    isUpdatable: true,
    indexUrl: source.indexUrl,
    downloadUrl: source.downloadUrl,
  };
}

function validateRecommendedImport(source, report, generated) {
  assertRecommendedDictionary(source, { ...report, indexUrl: generated.indexUrl, revision: generated.revision });
}

function installedAt(importDate, path) {
  if (typeof importDate === "number" && Number.isFinite(importDate)) {
    return new Date(importDate).toISOString();
  }
  const mtime = engine.FS.stat(`${path}/index.json`).mtime;
  return new Date(mtime instanceof Date ? mtime.getTime() : Number(mtime) * 1000).toISOString();
}

async function stableDictionaryId(title) {
  const bytes = new TextEncoder().encode(title);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest.subarray(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function packageFromIndex(path) {
  const json = new TextDecoder().decode(engine.FS.readFile(`${path}/index.json`));
  const index = parseJson(json, `${path}/index.json`);
  const title = text(index?.title);
  if (title === "") {
    throw new Error(`${path}/index.json has no dictionary title`);
  }
  return {
    id: await stableDictionaryId(title),
    title,
    displayName: null,
    path,
    enabled: true,
    favorite: false,
    revision: text(index?.revision),
    isUpdatable: index?.isUpdatable === true,
    indexUrl: optionalText(index?.indexUrl),
    downloadUrl: optionalText(index?.downloadUrl),
    language: optionalText(index?.sourceLanguage),
    frequencyMode: optionalText(index?.frequencyMode),
    termCount: count(index?.counts?.terms?.total),
    frequencyCount: count(index?.counts?.termMeta?.freq),
    pitchCount: count(index?.counts?.termMeta?.pitch) + count(index?.counts?.termMeta?.ipa),
    kanjiCount: count(index?.counts?.kanji?.total),
    mediaCount: count(index?.counts?.media?.total),
    installedAt: installedAt(index?.importDate, path),
    lastUpdateCheck: null,
  };
}

async function listLegacyImported(legacy) {
  const FS = engine.FS;
  const dictionaries = [];
  const expectedTitles = new Set(
    legacy.map((row) => text(row?.title)).filter((title) => title !== ""),
  );
  for (const title of expectedTitles) {
    const path = `${DICT_ROOT}/${title}`;
    if (dictionaryRoot({ title, path }) === null) {
      continue;
    }
    let stat;
    try {
      stat = FS.stat(path);
    } catch (error) {
      continue;
    }
    if (isDirectory(stat) && hasDictionaryMarker(path)) {
      const dictionary = await packageFromIndex(path);
      if (dictionary.title !== title) {
        throw new Error(`${path}/index.json does not match its legacy dictionary title`);
      }
      dictionaries.push(dictionary);
    }
  }
  return dictionaries;
}

async function ask(type, fields = {}) {
  if (hostRequest === null) {
    throw new Error("the engine service has no host bridge");
  }
  const reply = await hostRequest({ target: WORKER_TARGET, type, ...fields });
  // A message nothing answers resolves with undefined rather than rejecting, and
  // an unanswered dictionary read is indistinguishable from empty storage --
  // reconcile() would adopt every directory on disk as a term dictionary and
  // write that back over the user's choices. Never degrade to a default here.
  if (reply === undefined || reply === null) {
    throw new Error(`the service worker did not answer ${type}`);
  }
  return reply;
}

async function readDictionaryStorage() {
  const reply = await ask("hd_state_read");
  if (reply.ok !== true) {
    throw new Error(reply.error || "the service worker could not read dictionary state");
  }
  if (reply.state !== null && (
    reply.state?.schemaVersion !== 1
    || !Number.isInteger(reply.state?.revision)
    || reply.state.revision < 0
    || !Array.isArray(reply.state?.dictionaries)
  )) {
    throw new Error("the service worker returned invalid dictionary state");
  }
  if (reply.legacyDictionaries !== null && !Array.isArray(reply.legacyDictionaries)) {
    throw new Error("the service worker returned an invalid legacy dictionary list");
  }
  return {
    state: reply.state,
    legacyDictionaries: reply.legacyDictionaries,
  };
}

async function readStoredDictionaries() {
  const { state } = await readDictionaryStorage();
  return state?.dictionaries ?? [];
}

async function readCustomStorage() {
  const reply = await ask("hd_custom_read");
  if (reply.ok !== true) {
    throw new Error(reply.error || "the service worker could not read the custom dictionary");
  }
  if (reply.state !== null && (
    reply.state?.schemaVersion !== 1
    || !Number.isInteger(reply.state?.revision)
    || reply.state.revision < 0
    || !Array.isArray(reply.state?.dictionaries)
    || !Array.isArray(reply.state?.groups)
  )) {
    throw new Error("the service worker returned invalid custom dictionary state");
  }
  return {
    document: normaliseCustomDictionaryDocument(reply.document),
    state: reply.state,
  };
}

function sameDictionaries(left, right) {
  return sameJsonValue(left, right);
}

function groupsForDictionaries(groups, dictionaries) {
  const installed = new Set(dictionaries.map((dictionary) => dictionary?.id));
  return (groups ?? []).map((group) => ({
    ...group,
    dictionaryIds: (group?.dictionaryIds ?? []).filter((id, index, values) =>
      installed.has(id) && values.indexOf(id) === index),
  }));
}

function expectedCustomDocument(document, source, semanticRevision) {
  if (document.text === source && document.semanticRevision === semanticRevision) {
    return document;
  }
  return {
    schemaVersion: 1,
    revision: document.revision + 1,
    semanticRevision,
    text: source,
  };
}

async function commitCustomStorage(snapshot, source, semanticRevision, dictionaries) {
  if (snapshot.state === null) {
    throw new Error("the dictionary state is unavailable");
  }
  const document = expectedCustomDocument(snapshot.document, source, semanticRevision);
  const groups = dictionaries === undefined
    ? snapshot.state.groups
    : groupsForDictionaries(snapshot.state.groups, dictionaries);
  const changesState = dictionaries !== undefined
    && (!sameDictionaries(snapshot.state.dictionaries, dictionaries)
      || !sameJsonValue(snapshot.state.groups, groups));
  const state = changesState
    ? {
        schemaVersion: 1,
        revision: snapshot.state.revision + 1,
        dictionaries,
        groups,
      }
    : snapshot.state;
  const fields = {
    baseDocumentRevision: snapshot.document.revision,
    baseRevision: snapshot.state.revision,
    text: source,
    semanticRevision,
    ...(changesState ? { dictionaries, groups } : {}),
  };
  try {
    const reply = await ask("hd_custom_cas", fields);
    // The host reply's envelope belongs to this internal CAS request. Let
    // handleEngineMessage apply the public save/append envelope instead of
    // allowing these fields to overwrite its type and request ID.
    const result = { ...reply };
    delete result.type;
    delete result.requestId;
    delete result.generation;
    return result;
  } catch (commitError) {
    let current;
    try {
      current = await readCustomStorage();
    } catch (readError) {
      throw new UnknownDictionaryStateCommitError(
        commitError,
        readError,
        "custom dictionary",
      );
    }
    if (sameJsonValue(current.document, document) && sameJsonValue(current.state, state)) {
      return { ok: true, document, state };
    }
    if (sameJsonValue(current.document, document)) {
      throw new UnknownDictionaryStateCommitError(
        commitError,
        new Error("readback did not match the exact source and dictionary-state pair"),
        "custom dictionary",
      );
    }
    return {
      ok: false,
      stale: current.document.revision !== snapshot.document.revision,
      conflict: current.state?.revision !== snapshot.state.revision,
      error: describe(commitError),
      ...current,
    };
  }
}

// A service worker can commit the CAS and disappear before its reply reaches
// this worker. Read back that one exact revision so callers do not report a
// failed change which storage already accepted.
async function commitDictionaryState(baseRevision, dictionaries) {
  try {
    return await ask("hd_state_cas", { baseRevision, dictionaries });
  } catch (commitError) {
    let state;
    try {
      ({ state } = await readDictionaryStorage());
    } catch (readError) {
      throw new UnknownDictionaryStateCommitError(commitError, readError);
    }
    if (state?.revision === baseRevision + 1
        && sameDictionaries(state.dictionaries, dictionaries)) {
      return { ok: true, state };
    }
    const currentRevision = state?.revision ?? 0;
    return {
      ok: false,
      conflict: currentRevision !== baseRevision,
      error: describe(commitError),
      state,
    };
  }
}

async function recoverPendingRemovals(snapshot) {
  if (!exists(REMOVAL_ROOT)) {
    return;
  }
  const stored = snapshot.state?.dictionaries ?? snapshot.legacyDictionaries ?? [];
  const retainedTitles = new Set(stored.map((dictionary) => text(dictionary?.title)));
  let changed = false;
  for (const title of engine.FS.readdir(REMOVAL_ROOT)) {
    const stagedPath = `${REMOVAL_ROOT}/${title}`;
    if (title === "." || title === ".." || !usableDictionaryTitle(title)
        || !isDirectory(engine.FS.stat(stagedPath))) {
      continue;
    }
    changed = settleStagedRemoval(title, retainedTitles.has(title)) || changed;
  }
  if (changed) {
    await persistFilesystem();
  }
}

// `buildCandidate` must derive its list from the supplied snapshot: a refused
// write is rebuilt against the authoritative state before it is attempted again.
// Loading happens before the CAS so a disabled corrupt package cannot be
// published merely because the live engine would otherwise skip it.
async function commitDictionaryCandidate(buildCandidate) {
  for (let attempt = 0; ; attempt += 1) {
    const snapshot = await readDictionaryStorage();
    const next = await buildCandidate(snapshot);
    const loadedCount = loadDictionaries(next, { committed: snapshot.state?.dictionaries ?? [] });
    if (snapshot.state !== null && sameDictionaries(next, snapshot.state.dictionaries)) {
      return { state: snapshot.state, loadedCount };
    }
    const baseRevision = snapshot.state?.revision ?? 0;
    const reply = await commitDictionaryState(baseRevision, next);
    if (reply.ok === true) {
      if (reply.state?.schemaVersion !== 1
          || !Number.isInteger(reply.state?.revision)
          || !Array.isArray(reply.state?.dictionaries)) {
        throw new Error("the service worker returned invalid committed dictionary state");
      }
      return { state: reply.state, loadedCount };
    }
    if (reply.conflict !== true || attempt + 1 >= STORAGE_ATTEMPTS) {
      throw new Error(reply.error || "the service worker could not save dictionary state");
    }
  }
}

function withStoredPresentation(generated, stored) {
  const sourceId = optionalText(stored?.sourceId);
  return {
    ...generated,
    id: optionalText(stored?.id) ?? generated.id,
    displayName: typeof stored?.displayName === "string" ? stored.displayName : null,
    enabled: stored?.enabled !== false,
    favorite: stored?.favorite === true,
    isUpdatable: stored?.isUpdatable === true || generated.isUpdatable,
    indexUrl: stored?.indexUrl ?? generated.indexUrl,
    downloadUrl: stored?.downloadUrl ?? generated.downloadUrl,
    lastUpdateCheck: stored?.lastUpdateCheck ?? null,
    ...(stored?.updateScheduleOverride === undefined ? {} : { updateScheduleOverride: stored.updateScheduleOverride }),
    ...(sourceId === null ? {} : { sourceId }),
  };
}

// Once revisioned state exists, its paths are the commit record. Refresh
// generated metadata from those exact paths, but never discover another path
// and silently publish it.
async function refreshReferencedPackages(stored) {
  const entries = [];
  for (const storedPackage of stored) {
    const path = text(storedPackage?.path);
    if (dictionaryRoot(storedPackage) === null) {
      throw new Error(`the committed dictionary state contains an invalid path: ${path}`);
    }
    let generated;
    try {
      generated = await packageFromIndex(path);
    } catch (error) {
      // Keep the committed row; loading reports the package if it cannot load.
      console.warn(`hoshidicts: could not refresh ${path}: ${describe(error)}`);
      entries.push(storedPackage);
      continue;
    }
    if (generated.title !== storedPackage?.title) {
      throw new Error(`${path}/index.json does not match its committed dictionary title`);
    }
    entries.push(withStoredPresentation(generated, storedPackage));
  }
  return entries;
}

function migrateLegacyPackages(legacy, onDisk) {
  const orderedTitles = [];
  const enabledByTitle = new Map();
  for (const row of legacy) {
    const title = text(row?.title);
    if (title === "" || !onDisk.has(title)) {
      continue;
    }
    if (!enabledByTitle.has(title)) {
      orderedTitles.push(title);
      enabledByTitle.set(title, false);
    }
    if (row?.enabled !== false) {
      enabledByTitle.set(title, true);
    }
  }

  const entries = [];
  const listed = new Set();
  for (const title of orderedTitles) {
    listed.add(title);
    entries.push({ ...onDisk.get(title), enabled: enabledByTitle.get(title) });
  }
  for (const [title, generated] of onDisk) {
    if (!listed.has(title)) {
      entries.push(generated);
    }
  }
  return entries;
}

async function reconcile() {
  await recoverPendingRemovals(await readDictionaryStorage());
  return commitDictionaryCandidate(async (snapshot) => {
    if (snapshot.state !== null) {
      return refreshReferencedPackages(snapshot.state.dictionaries);
    }
    const legacy = snapshot.legacyDictionaries ?? [];
    const onDisk = new Map(
      (await listLegacyImported(legacy)).map((dictionary) => [dictionary.title, dictionary]),
    );
    return migrateLegacyPackages(legacy, onDisk);
  });
}

function kindsForPackage(dictionary) {
  const kinds = [
    ["term", dictionary.termCount],
    ["freq", dictionary.frequencyCount],
    ["pitch", dictionary.pitchCount],
    ["kanji", dictionary.kanjiCount],
  ]
    .filter(([, capabilityCount]) => Number(capabilityCount) > 0)
    .map(([kind]) => kind);
  return kinds.length === 0 ? ["term"] : kinds;
}

class DictionaryLoadError extends Error {
  constructor(dictionary, kindName) {
    super(`could not load ${dictionary.path} as ${kindName}: ${lastError()}`);
    this.name = "DictionaryLoadError";
    this.dictionary = dictionary;
  }
}

function addDictionaries(dictionaries, includeDisabled) {
  let loadedCount = 0;
  for (const dictionary of dictionaries) {
    if (!includeDisabled && dictionary.enabled === false) {
      continue;
    }
    for (const kindName of kindsForPackage(dictionary)) {
      const kind = KINDS.indexOf(kindName);
      if (!engine.ccall("hdw_add_dict", "number", ["string", "number"], [dictionary.path, kind])) {
        throw new DictionaryLoadError(dictionary, kindName);
      }
      loadedCount += 1;
    }
  }
  return loadedCount;
}

// Every package, enabled or not, must load. A package a mutation introduces is
// never published unless it does, but one already at a `committed` path that
// stops loading is left out and reported in `loadFailures`: otherwise a single
// broken package would stop lookups in every other dictionary.
function loadDictionaries(dictionaries, { committed = [] } = {}) {
  for (const dictionary of dictionaries) {
    if (dictionaryRoot(dictionary) === null) {
      throw new Error(`refusing to load an invalid dictionary path: ${text(dictionary?.path)}`);
    }
  }
  const tolerated = new Set(committed.map((dictionary) => text(dictionary?.path)));
  const failed = [];
  const skipped = new Set();
  const recordFailure = (error) => {
    if (!(error instanceof DictionaryLoadError) || !tolerated.has(error.dictionary.path)) {
      throw error;
    }
    skipped.add(error.dictionary.path);
    failed.push({
      id: optionalText(error.dictionary.id),
      title: text(error.dictionary.title),
      error: error.message,
    });
  };
  for (const dictionary of dictionaries) {
    if (dictionary.enabled !== false) {
      continue;
    }
    engine.ccall("hdw_reset", null, [], []);
    try {
      addDictionaries([dictionary], true);
    } catch (error) {
      recordFailure(error);
    }
  }
  // An enabled package can fail after some of its kinds were added, so reload
  // without it rather than keep part of it.
  for (;;) {
    engine.ccall("hdw_reset", null, [], []);
    try {
      const loadedCount = addDictionaries(
        dictionaries.filter((dictionary) => !skipped.has(dictionary.path)),
        false,
      );
      loadFailures = failed;
      return loadedCount;
    } catch (error) {
      recordFailure(error);
    }
  }
}

function publishLoadedDictionaries(loadedCount) {
  dictionaryCount = loadedCount;
  generation += 1;
}

async function restoreCommittedDictionaries(state = null, { publish = true } = {}) {
  const committed = state ?? (await readDictionaryStorage()).state;
  if (committed === null) {
    throw new Error("the committed dictionary state is unavailable");
  }
  const loadedCount = loadDictionaries(committed.dictionaries, { committed: committed.dictionaries });
  if (publish) publishLoadedDictionaries(loadedCount);
  else dictionaryCount = loadedCount;
  reloadError = null;
  return committed;
}

// Reconciliation loads a fully validated candidate before publishing it. Keep
// any failure for hd_status to report and for the next request to retry; public
// count/generation state still describes the last published load set.
async function reloadFromStorage() {
  try {
    const committed = await reconcile();
    publishLoadedDictionaries(committed.loadedCount);
    reloadError = null;
    await cleanupCommittedDictionaries();
  } catch (error) {
    reloadError = asError(error);
    throw reloadError;
  }
}

// A lookup served while reloadError is set would answer dictionaryCount 0, which
// the content script renders as "no dictionaries imported" -- a lie the reader
// cannot act on. Retry instead: the usual cause is a service worker that died
// mid-message, and the next request reaches a fresh one.
async function ensureLoaded() {
  requireEngine();
  if (reloadError !== null) {
    await reloadFromStorage();
  }
}

// Single-flight: hd_status is polled every second while the engine is loading,
// and each retry unloads and reloads every dictionary.
let reloadRetry = null;

function retryReload() {
  if (reloadRetry !== null || preparedBackup !== null) {
    return;
  }
  // Through serialise(), or this would call hdw_reset underneath a running
  // import. The rejection is already recorded in reloadError.
  const run = serialise(reloadFromStorage);
  reloadRetry = run;
  const done = () => {
    if (reloadRetry === run) {
      reloadRetry = null;
    }
  };
  run.then(done, done);
}

async function boot() {
  try {
    if (typeof createHoshidicts !== "function") {
      throw new Error("the engine service has no WASM factory");
    }
    engine = await createHoshidicts();
    if (storageBackend === "idbfs") {
      if (!exists(DICT_ROOT)) {
        engine.FS.mkdir(DICT_ROOT);
      }
      engine.FS.mount(engine.IDBFS, {}, DICT_ROOT);
      await syncfs(true);
    }
    const initialized = engine.ccall(
      "hdw_init_storage",
      "number",
      ["number"],
      [storageBackend === "opfs" ? 1 : 0],
    );
    if (initialized !== 1) {
      throwIfEngineFailed("hdw_init_storage");
      throw new Error("hdw_init_storage failed");
    }
    if (storageBackend === "idbfs") {
      // The populated filesystem may contain a transaction written by the old
      // canonical-path importer; persist native recovery before reconciliation.
      await persistFilesystem();
    } else if (storageBackend === "opfs") {
      try {
        engine.FS.unlink(OPFS_IMPORT_ZIP);
      } catch {
        // No archive was left by an interrupted import.
      }
    }
    ready = true;
  } catch (error) {
    ready = false;
    bootError = asError(error);
    console.error(`hoshidicts: the engine failed to start: ${bootError.message}`);
    return;
  }

  // Outside the try above on purpose: a failed dictionary list is not a failed
  // engine, and latching bootError here would leave a working engine refusing
  // every lookup and every import until the browser restarts, since nothing
  // recreates this document.
  try {
    await reloadFromStorage();
  } catch (error) {
    console.error(`hoshidicts: could not load the dictionaries at startup: ${describe(error)}`);
  }
}

function emptyReport(error) {
  return {
    success: false,
    title: "",
    termCount: 0,
    metaCount: 0,
    frequencyCount: 0,
    pitchCount: 0,
    kanjiCount: 0,
    mediaCount: 0,
    error,
  };
}

function normaliseReport(raw) {
  const report = emptyReport(text(raw?.error));
  report.success = raw?.success === true;
  report.title = text(raw?.title);
  for (const key of ["termCount", "metaCount", "frequencyCount", "pitchCount", "kanjiCount", "mediaCount"]) {
    const count = Number(raw?.[key]);
    report[key] = Number.isFinite(count) ? count : 0;
  }
  return report;
}

function withCustomDictionary(stored, generated) {
  const current = stored.find((dictionary) => dictionary?.id === CUSTOM_DICTIONARY_ID);
  if (stored.some((dictionary) =>
    dictionary?.id !== CUSTOM_DICTIONARY_ID
      && text(dictionary?.title) === CUSTOM_DICTIONARY_TITLE)) {
    throw new Error(`a dictionary named ${CUSTOM_DICTIONARY_TITLE} is already installed`);
  }
  const custom = {
    ...generated,
    id: CUSTOM_DICTIONARY_ID,
    title: CUSTOM_DICTIONARY_TITLE,
    displayName: typeof current?.displayName === "string" ? current.displayName : null,
    enabled: true,
    favorite: current?.favorite === true,
    isUpdatable: false,
    indexUrl: null,
    downloadUrl: null,
    lastUpdateCheck: null,
  };
  return [custom, ...stored.filter((dictionary) => dictionary?.id !== CUSTOM_DICTIONARY_ID)];
}

async function customPackageSatisfies(state, semanticRevision, entryCount) {
  const custom = state?.dictionaries?.[0];
  if (custom?.id !== CUSTOM_DICTIONARY_ID
      || custom?.title !== CUSTOM_DICTIONARY_TITLE
      || custom?.enabled !== true
      || custom?.revision !== semanticRevision
      || custom?.termCount !== entryCount
      || !isGenerationRoot(dictionaryRoot(custom) ?? "")) {
    return false;
  }
  try {
    const generated = await packageFromIndex(custom.path);
    if (!customDictionaryMetadataMatches(generated, semanticRevision, entryCount)
        || !sameDictionaries(
          state.dictionaries,
          withCustomDictionary(state.dictionaries, generated),
        )) {
      return false;
    }
    loadDictionaries(state.dictionaries, {
      committed: state.dictionaries.filter((dictionary) => dictionary?.id !== CUSTOM_DICTIONARY_ID),
    });
    return true;
  } catch {
    return false;
  }
}

function importReplacementIndex(stored, generated, recommendedSource, managedSource) {
  let existingIndex = managedSource === null ? -1 : stored.findIndex((dictionary) =>
    dictionary?.id === managedSource.fingerprint.id);
  if (managedSource !== null) {
    const existing = stored[existingIndex];
    if (existingIndex < 0 || !managedDictionaryMatches(existing, managedSource.fingerprint)) {
      throw new Error(MANAGED_DICTIONARY_CHANGED);
    }
  }
  if (existingIndex < 0 && recommendedSource !== null) {
    existingIndex = stored.findIndex((dictionary) =>
      optionalText(dictionary?.sourceId) === recommendedSource.sourceId);
  }
  if (existingIndex < 0 && generated.indexUrl !== null) {
    existingIndex = stored.findIndex((dictionary) => dictionary?.indexUrl === generated.indexUrl);
  }
  if (existingIndex < 0) {
    existingIndex = stored.findIndex((dictionary) =>
      dictionary?.id === generated.id || text(dictionary?.title) === generated.title);
  }
  return existingIndex;
}

function withImport(stored, generated, recommendedSource, managedSource) {
  if (generated.title === CUSTOM_DICTIONARY_TITLE) {
    throw new Error(`${CUSTOM_DICTIONARY_TITLE} is reserved for the managed custom dictionary`);
  }
  const existingIndex = importReplacementIndex(
    stored,
    generated,
    recommendedSource,
    managedSource,
  );
  if (existingIndex < 0) {
    return [...stored, recommendedSource === null
      ? generated
      : withRecommendedSource(generated, recommendedSource)];
  }
  const collision = stored.some((dictionary, index) =>
    index !== existingIndex
      && (dictionary?.id === generated.id || text(dictionary?.title) === generated.title));
  if (collision) {
    throw new Error(`a dictionary named ${generated.title} is already installed`);
  }
  const next = [...stored];
  let replacement = {
    ...withStoredPresentation(generated, stored[existingIndex]),
    lastUpdateCheck: null,
  };
  if (managedSource !== null) {
    replacement = {
      ...replacement,
      isUpdatable: true,
      indexUrl: managedSource.fingerprint.source.indexUrl,
      downloadUrl: managedSource.fingerprint.source.downloadUrl,
      lastUpdateCheck: {
        checkedAt: managedSource.checkedAt,
        status: "up-to-date",
        remoteRevision: generated.revision,
        error: null,
      },
    };
  }
  next[existingIndex] = recommendedSource === null
    ? replacement
    : withRecommendedSource(replacement, recommendedSource);
  return next;
}

async function cleanupCommittedDictionaries() {
  try {
    const { state } = await readDictionaryStorage();
    if (state === null) {
      return;
    }
    await cleanupUnreferencedDictionaries(state.dictionaries);
  } catch (error) {
    console.warn(`hoshidicts: could not remove unreferenced dictionaries: ${describe(error)}`);
  }
}

async function commitImportedGeneration(
  generationRoot,
  report,
  recommendedSource,
  managedSource,
  expectedRevision,
) {
  const generated = await packageFromIndex(`${generationRoot}/${report.title}`);
  if (generated.title !== report.title) {
    throw new Error("the imported dictionary title changed while it was being committed");
  }
  if (expectedRevision !== null && generated.revision !== expectedRevision) {
    throw new Error("the downloaded dictionary revision did not match its update index");
  }
  if (managedSource !== null
      && httpsUrl(generated.indexUrl) !== managedSource.fingerprint.source.indexUrl) {
    throw new Error("the downloaded dictionary did not match its update source");
  }
  if (recommendedSource !== null) {
    validateRecommendedImport(recommendedSource, report, generated);
  }
  const committed = await commitDictionaryCandidate((snapshot) =>
    withImport(
      snapshot.state?.dictionaries ?? [],
      generated,
      recommendedSource,
      managedSource,
    ));
  publishLoadedDictionaries(committed.loadedCount);
  reloadError = null;
  await cleanupCommittedDictionaries();
  return committed.state;
}

async function rollbackImportedGenerations(generationRoots, failure) {
  let committed = null;
  let restoreError = null;
  try {
    committed = await restoreCommittedDictionaries();
  } catch (error) {
    restoreError = error;
    reloadError = asError(error);
  }
  const retained = new Set(committed?.dictionaries.map(dictionaryRoot));
  if (committed !== null) {
    try {
      await discardGenerations(generationRoots.filter(root => !retained.has(root)));
    } catch (error) {
      console.warn(`hoshidicts: could not discard failed dictionary generations: ${describe(error)}`);
    }
  }
  if (restoreError !== null) {
    throw new Error(`${describe(failure)}; dictionary rollback failed: ${describe(restoreError)}`);
  }
}

function rollbackImportedGeneration(generationRoot, failure) {
  return rollbackImportedGenerations([generationRoot], failure);
}

function toBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + BASE64_CHUNK));
  }
  return btoa(binary);
}

function mediaType(path) {
  const dot = path.lastIndexOf(".");
  const extension = dot < 0 ? "" : path.slice(dot + 1).toLowerCase();
  return MEDIA_TYPES[extension] ?? "application/octet-stream";
}

// A declared length is only comparable to the received bytes when the body is
// not transformed in flight; a content-encoded response counts decoded bytes
// against an encoded total, so it reports no total at all.
export function declaredResponseLength(response) {
  const headers = response?.headers;
  if (typeof headers?.get !== "function") return null;
  const encoding = headers.get("content-encoding");
  if (encoding !== null && encoding !== "" && encoding.trim().toLowerCase() !== "identity") return null;
  const length = Number(headers.get("content-length"));
  return Number.isSafeInteger(length) && length > 0 ? length : null;
}

export async function streamResponseToFile(FS, response, path, onProgress = null) {
  const reader = response.body?.getReader?.();
  const totalBytes = declaredResponseLength(response);
  const report = (receivedBytes) => {
    onProgress?.({ phase: "downloading", receivedBytes, totalBytes: totalBytes !== null && receivedBytes <= totalBytes ? totalBytes : null });
  };
  if (reader === undefined) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    FS.writeFile(path, bytes);
    report(bytes.byteLength);
    return bytes.byteLength;
  }

  const output = FS.open(path, "w");
  let written = 0;
  let reportedAt = -Infinity;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      if (bytes.byteLength === 0) continue;
      FS.write(output, bytes, 0, bytes.byteLength);
      written += bytes.byteLength;
      if (onProgress !== null && performance.now() - reportedAt >= PROGRESS_INTERVAL_MS) {
        reportedAt = performance.now();
        report(written);
      }
    }
  } finally {
    FS.close(output);
    reader.releaseLock?.();
  }
  report(written);
  return written;
}

async function importDictionaryArchive(response, archivePath, generationRoot, importLowRam, fileName, onProgress = null) {
  const FS = engine.FS;
  try {
    const archiveBytes = await streamResponseToFile(FS, response, archivePath, onProgress);
    if (archiveBytes === 0) {
      throw new Error(`${fileName} is empty`);
    }
    // The native importer has no progress callback: installation is one call.
    onProgress?.({ phase: "installing", receivedBytes: archiveBytes, totalBytes: archiveBytes });
    return normaliseReport(
      parseJson(
        engine.ccall(
          "hdw_import",
          "string",
          ["string", "string", "number"],
          [archivePath, generationRoot, importLowRam ? 1 : 0],
        ),
        "hdw_import",
      ),
    );
  } finally {
    try {
      FS.unlink(archivePath);
    } catch (error) {
      // Never written, or already gone.
    }
  }
}

async function managedSourceForImport(message, recommendedSource) {
  const requested = message?.managedFingerprint;
  if (requested === null || requested === undefined) {
    return null;
  }
  const dictionary = (await readStoredDictionaries()).find((entry) => entry?.id === requested?.id);
  if (!managedDictionaryMatches(dictionary, requested)) {
    throw new Error(MANAGED_DICTIONARY_CHANGED);
  }
  const fingerprint = managedDictionaryFingerprint(dictionary);
  const isRecommended = fingerprint.source.kind === "recommended";
  if ((isRecommended && recommendedSource?.sourceId !== fingerprint.source.sourceId)
      || (!isRecommended && recommendedSource !== null)) {
    throw new Error(MANAGED_DICTIONARY_CHANGED);
  }
  const archiveUrl = httpsUrl(message?.archiveUrl);
  if (archiveUrl === null
      || (isRecommended && archiveUrl !== fingerprint.source.downloadUrl)) {
    throw new Error("the managed dictionary update carried an invalid archive URL");
  }
  const checkedAt = typeof message?.checkedAt === "string" && message.checkedAt !== ""
    ? message.checkedAt
    : null;
  if (checkedAt === null) {
    throw new Error("the managed dictionary update carried no check time");
  }
  return {
    fingerprint,
    archiveUrl,
    checkedAt,
  };
}

function validateLocalImportRequest(message, managedSource, recommendedSource) {
  if (managedSource !== null) {
    throw new Error("the managed import request carried a blob URL");
  }
  if (recommendedSource !== null
      && !recommendedDownloadUrlMatches(recommendedSource, optionalText(message.finalUrl))) {
    throw new Error(`${recommendedSource.name} downloaded from an unexpected final URL`);
  }
}

// A remote import is either a checked managed update or a first install of a
// recommended source, which downloads only its catalogue-pinned archive.
function validateRemoteImportRequest(message, managedSource, recommendedSource, expectedRevision) {
  if (managedSource !== null) {
    if (expectedRevision === null) {
      throw new Error("the managed import request carried no expected revision");
    }
    return managedSource.archiveUrl;
  }
  if (recommendedSource === null) {
    throw new Error("the import request carried no archive URL");
  }
  if (httpsUrl(message.archiveUrl) !== recommendedSource.downloadUrl) {
    throw new Error(`${recommendedSource.name} must be downloaded from its catalogue archive URL`);
  }
  return recommendedSource.downloadUrl;
}

async function prepareImportRequest(message) {
  const blobUrl = text(message.blobUrl);
  const importLowRam = typeof message.lowRam === "boolean" ? message.lowRam : lowRam;
  const recommendedSource = recommendedSourceForImport(message);
  const managedSource = await managedSourceForImport(message, recommendedSource);
  const expectedRevision = optionalText(message.expectedRevision);
  const remote = blobUrl === "";
  let archiveUrl = blobUrl;
  if (remote) {
    archiveUrl = validateRemoteImportRequest(message, managedSource, recommendedSource, expectedRevision);
  } else {
    validateLocalImportRequest(message, managedSource, recommendedSource);
  }
  return {
    archiveUrl,
    expectedRevision,
    fileName: text(message.fileName) || recommendedSource?.archiveName || "the archive",
    importLowRam,
    managedSource,
    recommendedSource,
    remote,
  };
}

function remoteArchiveFinalUrlMatches(request, finalUrl) {
  return request.recommendedSource === null
    ? httpsUrl(finalUrl) !== null
    : recommendedDownloadUrlMatches(request.recommendedSource, finalUrl);
}

async function fetchImportArchive(request) {
  const response = await fetch(request.archiveUrl, { credentials: "omit" });
  if (!response.ok) {
    throw new Error(`could not read ${request.fileName}: HTTP ${response.status}`);
  }
  if (request.remote
      && !remoteArchiveFinalUrlMatches(request, optionalText(response.url))) {
    throw new Error(`${request.fileName} downloaded from an unexpected final URL`);
  }
  return response;
}

async function runImportTransaction(response, fileName, importLowRam, commit, onProgress = null) {
  const generationRoot = createGenerationRoot();
  // Unload before importing: the loaded dictionaries are mapped into the same
  // 32-bit address space the importer needs. Public count/generation state is
  // not changed until either the candidate or the committed state is loaded.
  engine.ccall("hdw_reset", null, [], []);

  const archivePath = storageBackend === "opfs" ? OPFS_IMPORT_ZIP : IMPORT_ZIP;
  let report;
  let rollbackAttempted = false;
  try {
    report = await importDictionaryArchive(
      response,
      archivePath,
      generationRoot,
      importLowRam,
      fileName,
      onProgress,
    );
    if (report.success && report.title === "") {
      // hdw_import refuses a title it cannot use as a folder name, so this is
      // unreachable; without a title there is nothing to register, and a row
      // with an empty title would poison reconcile().
      report.success = false;
      report.error = `${fileName} declares no dictionary title`;
    }
    if (report.success) {
      await persistFilesystem();
      await commit(generationRoot, report);
    } else {
      const failure = new Error(report.error || `${fileName} could not be imported`);
      rollbackAttempted = true;
      await rollbackImportedGeneration(generationRoot, failure);
    }
  } catch (error) {
    if (error instanceof UnknownDictionaryStateCommitError) {
      // Storage may already reference the new path. Neither generation is safe
      // to delete until an authoritative read succeeds.
      reloadError = error;
      throw error;
    }
    if (!rollbackAttempted) {
      await rollbackImportedGeneration(generationRoot, error);
    }
    throw error;
  }
  return report;
}

class CustomCommitRejectedError extends Error {
  constructor(reply) {
    super(reply?.error || "the custom dictionary could not be saved");
    this.name = "CustomCommitRejectedError";
    this.reply = reply;
  }
}

function customStaleReply(snapshot) {
  return {
    ok: false,
    stale: true,
    error: "the custom dictionary source changed while it was being saved",
    ...snapshot,
  };
}

function customSnapshotFromReply(reply) {
  return {
    document: normaliseCustomDictionaryDocument(reply.document),
    state: reply.state,
  };
}

async function commitCustomSourceOnly(initial, source, semanticRevision) {
  let snapshot = initial;
  for (let attempt = 0; attempt < STORAGE_ATTEMPTS; attempt += 1) {
    if (snapshot.document.revision !== initial.document.revision) {
      return customStaleReply(snapshot);
    }
    const reply = await commitCustomStorage(snapshot, source, semanticRevision);
    if (reply.ok === true || reply.stale === true) return reply;
    if (reply.conflict !== true || reply.document === undefined || reply.state === null) {
      return reply;
    }
    snapshot = customSnapshotFromReply(reply);
  }
  return {
    ok: false,
    conflict: true,
    error: "the dictionary state kept changing while the custom source was being saved",
    ...snapshot,
  };
}

async function completeCustomRemoval(reply, removesPackage, loadedCount) {
  if (removesPackage) {
    publishLoadedDictionaries(loadedCount);
    reloadError = null;
    await cleanupCommittedDictionaries();
  }
  return { ...reply, rebuilt: false, removed: removesPackage };
}

async function rethrowCustomRemovalFailure(error, removesPackage) {
  if (error instanceof UnknownDictionaryStateCommitError) {
    reloadError = error;
    throw error;
  }
  if (removesPackage) {
    try {
      await restoreCommittedDictionaries();
    } catch (restoreError) {
      reloadError = asError(restoreError);
      throw new Error(`${describe(error)}; custom dictionary rollback failed: ${describe(restoreError)}`);
    }
  }
  throw error;
}

function customRemovalLoadedCount(dictionaries, removesPackage) {
  if (!removesPackage) return dictionaryCount;
  return loadDictionaries(dictionaries, { committed: dictionaries });
}

async function commitCustomRemoval(initial, source, semanticRevision) {
  let snapshot = initial;
  for (let attempt = 0; attempt < STORAGE_ATTEMPTS; attempt += 1) {
    if (snapshot.document.revision !== initial.document.revision) {
      return customStaleReply(snapshot);
    }
    const dictionaries = snapshot.state.dictionaries.filter(
      (dictionary) => dictionary?.id !== CUSTOM_DICTIONARY_ID,
    );
    const removesPackage = dictionaries.length !== snapshot.state.dictionaries.length;
    try {
      const loadedCount = customRemovalLoadedCount(dictionaries, removesPackage);
      const reply = await commitCustomStorage(
        snapshot,
        source,
        semanticRevision,
        removesPackage ? dictionaries : undefined,
      );
      if (reply.ok === true) {
        const completed = await completeCustomRemoval(reply, removesPackage, loadedCount);
        return completed;
      }
      if (reply.conflict === true
          && reply.stale !== true
          && reply.document !== undefined
          && reply.state !== null
          && attempt + 1 < STORAGE_ATTEMPTS) {
        snapshot = customSnapshotFromReply(reply);
        continue;
      }
      if (removesPackage) await restoreCommittedDictionaries(reply.state ?? snapshot.state);
      return reply;
    } catch (error) {
      await rethrowCustomRemovalFailure(error, removesPackage);
    }
  }
  throw new Error("the dictionary state kept changing while the custom dictionary was removed");
}

async function commitCustomGeneration(
  initial,
  source,
  semanticRevision,
  generationRoot,
  report,
) {
  const generated = await packageFromIndex(`${generationRoot}/${report.title}`);
  if (report.title !== CUSTOM_DICTIONARY_TITLE
      || generated.title !== CUSTOM_DICTIONARY_TITLE) {
    throw new Error("the compiled custom archive has the wrong dictionary title");
  }
  if (generated.revision !== semanticRevision) {
    throw new Error("the compiled custom archive has the wrong semantic revision");
  }

  let snapshot = initial;
  for (let attempt = 0; attempt < STORAGE_ATTEMPTS; attempt += 1) {
    if (snapshot.document.revision !== initial.document.revision) {
      throw new CustomCommitRejectedError(customStaleReply(snapshot));
    }
    const dictionaries = withCustomDictionary(snapshot.state.dictionaries, generated);
    const loadedCount = loadDictionaries(dictionaries, { committed: snapshot.state.dictionaries });
    const reply = await commitCustomStorage(snapshot, source, semanticRevision, dictionaries);
    if (reply.ok === true) {
      publishLoadedDictionaries(loadedCount);
      reloadError = null;
      await cleanupCommittedDictionaries();
      return reply;
    }
    if (reply.conflict === true
        && reply.stale !== true
        && reply.document !== undefined
        && reply.state !== null
        && attempt + 1 < STORAGE_ATTEMPTS) {
      snapshot = customSnapshotFromReply(reply);
      continue;
    }
    throw new CustomCommitRejectedError(reply);
  }
  throw new Error("the dictionary state kept changing while the custom dictionary was saved");
}

async function saveCustomDictionary(snapshot, source) {
  const parsed = parseCustomDictionary(source);
  const semanticRevision = await customDictionarySemanticRevision(parsed.entries);
  if (parsed.entries.length === 0) {
    const removed = await commitCustomRemoval(snapshot, source, semanticRevision);
    return { ...removed, errors: parsed.errors };
  }
  if (snapshot.state.dictionaries.some((dictionary) =>
    dictionary?.id !== CUSTOM_DICTIONARY_ID
      && dictionary?.title === CUSTOM_DICTIONARY_TITLE)) {
    throw new Error(`a dictionary named ${CUSTOM_DICTIONARY_TITLE} is already installed`);
  }
  if (semanticRevision === snapshot.document.semanticRevision
      && await customPackageSatisfies(snapshot.state, semanticRevision, parsed.entries.length)) {
    const saved = await commitCustomSourceOnly(snapshot, source, semanticRevision);
    return { ...saved, errors: parsed.errors, rebuilt: false, removed: false };
  }

  const archive = buildCustomDictionaryZip(parsed.entries, semanticRevision);
  let committed = null;
  try {
    const report = await runImportTransaction(
      new Response(archive),
      "the custom dictionary archive",
      lowRam,
      async (generationRoot, importedReport) => {
        committed = await commitCustomGeneration(
          snapshot,
          source,
          semanticRevision,
          generationRoot,
          importedReport,
        );
      },
    );
    return {
      ...committed,
      errors: parsed.errors,
      rebuilt: true,
      removed: false,
      report,
    };
  } catch (error) {
    if (error instanceof CustomCommitRejectedError) {
      return { ...error.reply, errors: parsed.errors };
    }
    throw error;
  }
}

let preparedBackup = null;
const backupUrls = new Set();

async function readBackupStorage(raw = false) {
  const reply = await ask(raw ? "hd_backup_base_read" : "hd_backup_read");
  if (!reply.ok) throw new Error(reply.error || "Could not read the complete Hachidori state.");
  return reply;
}

function backupFileBlob(path, size) {
  const FS = engine.FS;
  const input = FS.open(path, "r");
  const parts = [];
  try {
    let offset = 0;
    while (offset < size) {
      // Transfer-sized chunks, not a limit on files or archive size.
      const bytes = new Uint8Array(Math.min(64 * 1024, size - offset));
      const read = FS.read(input, bytes, 0, bytes.length);
      if (read !== bytes.length) throw new Error(`Could not read the complete dictionary file: ${path}`);
      parts.push(new Blob([bytes]));
      offset += read;
    }
    return new Blob(parts);
  } finally {
    FS.close(input);
  }
}

function collectBackupFiles(root, prefix, assertPath, output) {
  const FS = engine.FS;
  if (!isDirectory(FS.lstat(root))) throw new Error(`Dictionary generation is not a directory: ${root}`);
  for (const name of FS.readdir(root).filter(name => name !== "." && name !== "..").sort()) {
    const path = `${prefix}/${name}`;
    assertPath(path);
    const absolute = `${root}/${name}`;
    const stat = FS.lstat(absolute);
    if (isDirectory(stat)) collectBackupFiles(absolute, path, assertPath, output);
    else if ((stat.mode & 0o170000) === 0o100000) output.push({ path, data: backupFileBlob(absolute, stat.size) });
    else throw new Error(`Dictionary generation contains a non-file entry: ${path}`);
  }
}

async function discardPreparedBackup() {
  const previous = preparedBackup;
  preparedBackup = null;
  if (previous) await discardGenerations(previous.roots);
}

async function discardGenerations(roots) {
  for (const root of roots) {
    if (!isGenerationRoot(root)) throw new Error("Refusing to discard a path outside the dictionary generation namespace.");
  }
  let changed = false;
  for (const root of roots) {
    if (exists(root)) { removeTree(root); changed = true; }
  }
  if (changed) await persistFilesystem();
}

async function stageBackupFiles(prepared, roots) {
  const archived = prepared.snapshot.state.dictionaries;
  const dictionaries = archived.map(dictionary => {
    const root = createGenerationRoot();
    roots.push(root);
    const next = { ...dictionary, path: `${root}/${dictionary.title}` };
    if (dictionaryRoot(next) === null) throw new Error("The backup contains an invalid dictionary title.");
    return next;
  });
  for (const file of prepared.files) {
    const [, ordinal, ...relative] = file.path.split("/");
    const dictionary = dictionaries[Number(ordinal)];
    if (!dictionary) throw new Error(`The backup file has no dictionary: ${file.path}`);
    const path = `${dictionary.path}/${relative.join("/")}`;
    engine.FS.mkdirTree(path.slice(0, path.lastIndexOf("/")));
    await streamResponseToFile(engine.FS, new Response(file.data), path);
  }
  for (const dictionary of dictionaries) await validateBackupDictionary(dictionary);
  await persistFilesystem();
  return dictionaries;
}

async function validateBackupDictionary(dictionary) {
  const generated = await packageFromIndex(dictionary.path);
  const keys = ["title", "revision", "termCount", "frequencyCount", "pitchCount", "kanjiCount", "mediaCount"];
  if (keys.some(key => generated[key] !== dictionary[key]) || !hasDictionaryMarker(dictionary.path)) {
    throw new Error(`The backup dictionary metadata does not match its files: ${dictionary.title}`);
  }
  const required = ["hash.table", "bloom.filter", "blobs.bin"];
  if (dictionary.mediaCount > 0) required.push("media.idx", "media.bin");
  for (const name of required) {
    if (!exists(`${dictionary.path}/${name}`)) throw new Error(`The backup is missing ${dictionary.title}/${name}`);
  }
  const recommended = recommendedDictionarySource(dictionary.sourceId);
  if (recommended) assertRecommendedDictionary(recommended, generated);
  if (dictionary.id === CUSTOM_DICTIONARY_ID
      && !customDictionaryMetadataMatches(generated, dictionary.revision, dictionary.termCount)) {
    throw new Error("The backup custom dictionary files do not satisfy the managed package invariants.");
  }
}

async function commitBackupSnapshot(current, snapshot, lookupStatsRows) {
  try {
    return await ask("hd_backup_cas", { base: current, snapshot, lookupStatsRows });
  } catch (commitError) {
    let readback;
    try { readback = (await readBackupStorage(true)).snapshot; }
    catch (readError) { throw new UnknownDictionaryStateCommitError(commitError, readError, "backup restore"); }
    if (sameJsonValue(readback, snapshot)) return { ok: true, snapshot };
    if (!sameJsonValue(readback, current)) {
      throw new UnknownDictionaryStateCommitError(commitError,
        new Error("readback did not match the exact complete restore transaction"), "backup restore");
    }
    return { ok: false, error: describe(commitError) };
  }
}

async function restoreBackup(message) {
  requireEngine();
  if (!preparedBackup || preparedBackup.token !== message.token) {
    throw new Error("This prepared backup is no longer available. Choose the file again.");
  }
  const prepared = preparedBackup;
  preparedBackup = null;
  try {
    const { restoredBackupSnapshot } = await import("./backup-state.js");
    const current = (await readBackupStorage(true)).snapshot;
    if (!sameJsonValue(current, prepared.current)) {
      throw new Error("Hachidori changed since this backup was prepared. Prepare it again before restoring.");
    }
    const loadedCount = loadDictionaries(prepared.dictionaries);
    const snapshot = restoredBackupSnapshot(current, prepared.snapshot, prepared.dictionaries);
    const reply = await commitBackupSnapshot(current, snapshot, prepared.lookupStatsRows);
    if (!reply.ok) throw new Error(reply.error || "Could not commit the backup restore.");
    publishLoadedDictionaries(loadedCount);
    reloadError = null;
    await cleanupCommittedDictionaries();
    let warning = reply.warning ?? null;
    try {
      const cleanup = await ask("hd_lookup_stats_cleanup");
      if (!cleanup.ok) throw new Error(cleanup.error);
    } catch (error) {
      warning = [warning, `Restored successfully; old lookup statistics could not be cleaned up: ${describe(error)}`].filter(Boolean).join("; ");
    }
    return { restored: true, dictionaryCount, warning };
  } catch (error) {
    if (error instanceof UnknownDictionaryStateCommitError) {
      reloadError = error;
      throw error;
    }
    // Read authoritative state; never write an old snapshot over concurrent edits.
    await rollbackImportedGenerations(prepared.roots, error);
    throw error;
  }
}

function removalTarget(dictionaries, id, title) {
  const target = dictionaries.find((dictionary) =>
    id === null ? text(dictionary?.title) === title : dictionary?.id === id);
  if (target === undefined) return null;
  if (text(target.title) !== title) {
    throw new Error("the remove request dictionary ID and title do not match");
  }
  if (target.id === CUSTOM_DICTIONARY_ID) {
    throw new Error("the managed custom dictionary can only be removed by saving an empty source");
  }
  return target;
}

const HANDLERS = {
  async hd_backup_export() {
    await ensureLoaded();
    const [{ createBackupArchive, assertBackupPath }, { assertBackupSnapshot }] = await Promise.all([
      import("./backup-archive.js"), import("./backup-state.js"),
    ]);
    const { snapshot, lookupStatsRows } = await readBackupStorage();
    await assertBackupSnapshot(snapshot);
    const files = [];
    for (const [index, dictionary] of snapshot.state.dictionaries.entries()) {
      if (dictionaryRoot(dictionary) === null) throw new Error("Cannot back up an invalid dictionary path.");
      collectBackupFiles(dictionary.path, `dictionaries/${index}`, assertBackupPath, files);
    }
    const archive = await createBackupArchive(snapshot, files, lookupStatsRows);
    const blobUrl = URL.createObjectURL(archive);
    backupUrls.add(blobUrl);
    return { blobUrl, size: archive.size };
  },

  hd_backup_release(message) {
    if (backupUrls.delete(message.blobUrl)) URL.revokeObjectURL(message.blobUrl);
    return {};
  },

  async hd_backup_cancel(message) {
    if (preparedBackup?.token === message.token) await discardPreparedBackup();
    return {};
  },

  async hd_backup_prepare(message) {
    requireEngine();
    if (typeof message.token !== "string" || message.token === "") {
      throw new Error("Backup preparation requires its Settings cancellation token.");
    }
    await discardPreparedBackup();
    const current = (await readBackupStorage(true)).snapshot;
    const [{ openBackupArchive }, { assertBackupSnapshot }] = await Promise.all([
      import("./backup-archive.js"), import("./backup-state.js"),
    ]);
    if (typeof message.blobUrl !== "string" || !message.blobUrl.startsWith("blob:")) {
      throw new Error("Choose a local Hachidori backup archive.");
    }
    const response = await fetch(message.blobUrl);
    if (!response.ok) throw new Error("Could not read the selected backup.");
    const prepared = await openBackupArchive(await response.blob());
    await assertBackupSnapshot(prepared.snapshot);
    const roots = [];
    try {
      const dictionaries = await stageBackupFiles(prepared, roots);
      loadDictionaries(dictionaries);
      let warning = null;
      try {
        await restoreCommittedDictionaries(null, { publish: false });
        if (loadFailures.length > 0) {
          warning = "Some current dictionaries cannot be loaded. This validated backup can replace them.";
        }
      } catch (error) {
        reloadError = asError(error);
        warning = "The current dictionaries cannot be loaded. This validated backup can replace them.";
      }
      const token = message.token;
      preparedBackup = { token, current, roots, dictionaries, snapshot: prepared.snapshot, lookupStatsRows: prepared.lookupStatsRows };
      return { token, warning, createdAt: prepared.createdAt, dictionaries: dictionaries.map(({ title, enabled }) => ({ title, enabled })),
        customEntryCount: parseCustomDictionary(prepared.snapshot.document.text).entries.length };
    } catch (error) {
      try { await restoreCommittedDictionaries(null, { publish: false }); }
      catch (restoreError) { reloadError = asError(restoreError); }
      // Prepare never publishes these paths, even when the old state is broken.
      await discardGenerations(roots);
      throw error;
    }
  },

  hd_backup_restore: restoreBackup,

  async hd_lookup(message) {
    await ensureLoaded();
    const json = engine.ccall(
      "hdw_lookup",
      "string",
      ["string", "number", "number", "string"],
      lookupArguments(message),
    );
    throwIfEngineFailed("hdw_lookup");
    return termLookupReply(json, "hdw_lookup");
  },

  async hd_lookup_dictionary(message) {
    await ensureLoaded();
    const args = lookupArguments(message);
    const title = text(message.dictionary);
    const entry = (await readStoredDictionaries()).find((candidate) =>
      candidate?.enabled !== false
      && kindsForPackage(candidate).includes("term")
      && candidate?.title === title);
    if (!entry) {
      return { results: [], dictionaryCount };
    }
    const json = engine.ccall(
      "hdw_lookup_dictionary",
      "string",
      ["string", "string", "number", "number", "string"],
      [args[0], text(entry.path), ...args.slice(1)],
    );
    throwIfEngineFailed("hdw_lookup_dictionary");
    return termLookupReply(json, "hdw_lookup_dictionary");
  },

  async hd_kanji(message) {
    await ensureLoaded();
    const character = boundedText(message.character, "kanji text", MAX_LOOKUP_TEXT_BYTES);
    if (character === "") {
      return { kanji: null };
    }
    const json = engine.ccall("hdw_kanji", "string", ["string"], [character]);
    throwIfEngineFailed("hdw_kanji");
    const kanji = parseJson(json, "hdw_kanji");
    if (typeof kanji?.character !== "string" || !Array.isArray(kanji.entries)) {
      throw new TypeError("hdw_kanji returned a malformed lookup response");
    }
    return { kanji: kanji.character === "" ? null : kanji, nativeJsonLength: json.length };
  },

  async hd_styles() {
    await ensureLoaded();
    const json = engine.ccall("hdw_styles", "string", [], []);
    throwIfEngineFailed("hdw_styles");
    const styles = parseJson(json, "hdw_styles");
    return { styles: Array.isArray(styles) ? styles : [] };
  },

  async hd_media(message) {
    await ensureLoaded();
    if (!Number.isSafeInteger(message.generation) || message.generation !== generation) {
      throw new Error("media generation no longer matches the loaded dictionaries");
    }
    const dictionary = boundedText(message.dictionary, "media dictionary", MAX_MEDIA_DICTIONARY_BYTES);
    const path = boundedText(message.path, "media path", MAX_MEDIA_PATH_BYTES);
    if (dictionary === "" || path === "") {
      return { dataUrl: null };
    }
    const length = engine.ccall("hdw_media", "number", ["string", "string"], [dictionary, path]);
    throwIfEngineFailed("hdw_media");
    if (length <= 0) {
      return { dataUrl: null };
    }
    // "pointer", not "number": the glue only masks the raw i32 back to unsigned
    // for the former, and with ALLOW_MEMORY_GROWTH up to 4GB the buffer can sit
    // above 0x80000000, where a signed read silently slices the wrong bytes.
    const pointer = engine.ccall("hdw_media_data", "pointer", [], []);
    if (pointer === 0) {
      return { dataUrl: null };
    }
    // Read HEAPU8 through the module: memory growth swaps the view out.
    const bytes = engine.HEAPU8.subarray(pointer, pointer + length);
    return { dataUrl: `data:${mediaType(path)};base64,${toBase64(bytes)}` };
  },

  async hd_custom_save(message) {
    requireEngine();
    if (!Number.isInteger(message?.baseDocumentRevision)
        || message.baseDocumentRevision < 0) {
      throw new Error("the custom dictionary save carried no valid document revision");
    }
    if (typeof message?.text !== "string") {
      throw new TypeError("the custom dictionary save carried no source text");
    }
    const snapshot = await readCustomStorage();
    if (message.baseDocumentRevision !== snapshot.document.revision) {
      return customStaleReply(snapshot);
    }
    return saveCustomDictionary(snapshot, message.text);
  },

  async hd_custom_append(message) {
    requireEngine();
    // This read deliberately happens inside the engine mutation queue. A Note
    // submitted behind a Settings save must append to that newly committed
    // source rather than the document that existed when the click was sent.
    const snapshot = await readCustomStorage();
    const source = appendCustomDictionaryEntry(snapshot.document.text, message?.entry);
    return saveCustomDictionary(snapshot, source);
  },

  async hd_import(message) {
    requireEngine();
    const request = await prepareImportRequest(message);
    const response = await fetchImportArchive(request);
    const {
      expectedRevision,
      fileName,
      importLowRam,
      managedSource,
      recommendedSource,
    } = request;
    const requestId = message.requestId ?? null;
    const onProgress = reportProgress === null ? null : (event) => reportProgress({ requestId, ...event });
    const report = await runImportTransaction(
      response,
      fileName,
      importLowRam,
      (generationRoot, importedReport) =>
        commitImportedGeneration(
          generationRoot,
          importedReport,
          recommendedSource,
          managedSource,
          expectedRevision,
        ),
      onProgress,
    );

    if (!report.success) {
      return { ok: false, error: report.error || `${fileName} could not be imported`, report };
    }
    return { report };
  },

  async hd_apply_state(message) {
    requireEngine();
    if (!Number.isInteger(message?.baseRevision) || message.baseRevision < 0) {
      throw new Error("the dictionary state change carried no valid base revision");
    }
    if (!Array.isArray(message?.dictionaries)) {
      throw new TypeError("the dictionary state change carried no dictionary list");
    }

    let restorationAttempted = false;
    try {
      const loadedCount = loadDictionaries(message.dictionaries, {
        committed: await readStoredDictionaries(),
      });
      const reply = await commitDictionaryState(message.baseRevision, message.dictionaries);
      if (reply.ok === true) {
        publishLoadedDictionaries(loadedCount);
        reloadError = null;
        return { state: reply.state };
      }
      if (reply.conflict !== true || reply.state === null) {
        throw new Error(reply.error || "the dictionary state could not be saved");
      }
      restorationAttempted = true;
      await restoreCommittedDictionaries(reply.state);
      return {
        ok: false,
        conflict: true,
        error: reply.error || "the dictionary state changed while it was being written",
        state: reply.state,
      };
    } catch (error) {
      if (restorationAttempted) {
        reloadError = asError(error);
        throw error;
      }
      try {
        const { state } = await readDictionaryStorage();
        await restoreCommittedDictionaries(state);
      } catch (restoreError) {
        reloadError = asError(restoreError);
      }
      throw error;
    }
  },

  async hd_reload() {
    requireEngine();
    await reloadFromStorage();
    return { dictionaryCount };
  },

  async hd_remove(message) {
    requireEngine();
    const title = text(message.title);
    const id = optionalText(message.id);
    const legacyRemovalRoot = title === ".hdw-remove" && hasDictionaryMarker(REMOVAL_ROOT);
    if (!usableDictionaryTitle(title) && !legacyRemovalRoot) {
      throw new Error("the remove request carried an unusable dictionary title");
    }
    const snapshot = await readDictionaryStorage();
    if (snapshot.state === null) {
      throw new Error("the dictionary state is unavailable");
    }
    await recoverPendingRemovals(snapshot);

    const target = removalTarget(snapshot.state.dictionaries, id, title);
    if (target === null) {
      // Nothing to do, and reloading for nothing would invalidate the renderer's
      // media cache.
      return {};
    }
    const remaining = snapshot.state.dictionaries.filter(
      (dictionary) => dictionary?.id !== target.id,
    );

    let loadedCount;
    let reply;
    try {
      loadedCount = loadDictionaries(remaining, { committed: remaining });
      reply = await commitDictionaryState(snapshot.state.revision, remaining);
    } catch (error) {
      if (error instanceof UnknownDictionaryStateCommitError) {
        // The manifest may already exclude the package. Keep its files until an
        // authoritative read can decide whether they are still committed.
        reloadError = error;
        throw error;
      }
      try {
        await restoreCommittedDictionaries(snapshot.state);
      } catch (restoreError) {
        reloadError = asError(restoreError);
        throw new Error(`${describe(error)}; removal rollback failed: ${describe(restoreError)}`);
      }
      throw error;
    }

    if (reply.ok === true) {
      publishLoadedDictionaries(loadedCount);
      reloadError = null;
      await cleanupCommittedDictionaries();
      return {};
    }

    const authoritative = reply.conflict === true && reply.state !== null
      ? reply.state
      : snapshot.state;
    try {
      await restoreCommittedDictionaries(authoritative);
    } catch (restoreError) {
      reloadError = asError(restoreError);
      throw new Error(
        `${reply.error || "the dictionary removal could not be saved"}; `
        + `removal rollback failed: ${describe(restoreError)}`,
      );
    }
    return {
      ok: false,
      conflict: reply.conflict === true,
      error: reply.error || "the dictionary removal could not be saved",
      state: reply.state,
    };
  },

  hd_status() {
    // Nothing else repairs a failed reload on its own. ensureLoaded() retries on
    // the next lookup, which keeps hovering alive, but a reader who only opens
    // the settings page would sit in front of "Engine error, 0 dictionaries
    // loaded" indefinitely -- the engine is fine and the files are on disk, and
    // the only way out was to go and hover a word. So a status poll drives the
    // recovery: this reply describes the state as it is now, and the next poll
    // sees the repair. A timer would do the same, but would also keep waking the
    // service worker forever in the case where the retry cannot succeed.
    if (bootError === null && reloadError !== null) {
      retryReload();
    }
    // A reload failure is reported here too, or an engine that is ready with
    // nothing loaded is indistinguishable from an empty profile: the settings
    // page would say "0 dictionaries loaded" next to the rows it just imported.
    const failure = bootError ?? reloadError;
    return {
      ok: failure === null,
      error: failure === null ? null : describe(failure),
      ready,
      loading: busy > 0,
      dictionaryCount,
      failedDictionaries: loadFailures,
      generation,
      storageBackend,
      threaded: storageBackend === "opfs",
    };
  },
};

function failurePayload(type) {
  switch (type) {
    case "hd_lookup":
    case "hd_lookup_dictionary":
      return { results: [], dictionaryCount: 0 };
    case "hd_kanji":
      return { kanji: null };
    case "hd_styles":
      return { styles: [] };
    case "hd_media":
      return { dataUrl: null };
    case "hd_import":
      return { report: emptyReport("") };
    case "hd_reload":
      return { dictionaryCount: 0 };
    case "hd_status":
      return { ready: false, loading: false, dictionaryCount: 0, generation };
    default:
      return {};
  }
}

function engineFailureReply(type, requestId, error) {
  return boundResponseFailure({
    type: `${type}_result`, requestId, ok: false, error: describe(error),
    generation, ...failurePayload(type),
  });
}

export async function handleEngineMessage(message) {
  const type = text(message.type);
  let requestId = message.requestId ?? null;
  if (!Object.prototype.hasOwnProperty.call(HANDLERS, type)) {
    return {
      type: `${type || "hd_unknown"}_result`,
      requestId,
      ok: false,
      error: `unknown request type ${JSON.stringify(type)}`,
      generation,
    };
  }

  const bounded = isBoundedRequest(type);
  try {
    if (bounded) {
      if (!validResponseRequestId(requestId)) {
        requestId = null;
        throw new Error("request ID must be a string, finite number, or null");
      }
      if (!responseFits({ type: `${type}_result`, requestId, ok: false,
        error: responseLimitError(type), generation, ...failurePayload(type) })) {
        requestId = null;
        throw new Error(responseLimitError(type));
      }
    }
    const handler = HANDLERS[type];
    const run = UNQUEUED.has(type)
      ? Promise.resolve().then(() => handler(message))
      : serialise(() => handler(message));
    const result = await run;
    const { ok = true, error = null, nativeJsonLength = 0, ...payload } = result ?? {};
    const reply = { type: `${type}_result`, requestId, ok, error, generation, ...payload };
    if (bounded && !responseFits(reply, nativeJsonLength)) throw new Error(responseLimitError(type));
    return reply;
  } catch (error) {
    return engineFailureReply(type, requestId, error);
  }
}

export function startEngine() {
  if (started) {
    throw new Error("the engine service is already started");
  }
  started = true;
  serialise(boot);
}
