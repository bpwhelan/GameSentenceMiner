import { actualIndexPolicy, planIndexStorage, residentHashBudgetBytes } from "./dictionary-index-storage.js";
import { encodeBase64 } from "./base64.js";
import { readDebugLog, recordDebugFailure, setDebugLogLanguages } from "./debug-log.js";
import { describeErrorMessageOrJson } from "./error-text.js";
import { languageName } from "./language-names.js";
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
  isPersonalDictionaryTitle,
  normaliseCustomDictionaryDocument,
  parseCustomDictionary,
  personalDictionaryIdentity,
  personalDictionaryLanguage,
} from "./custom-dictionary.js";
import { sameJsonValue } from "./json-value.js";
import {
  boundResponseFailure,
  isBoundedRequest,
  responseFits,
  responseLimitError,
  validResponseRequestId,
} from "./response-limits.js";
import {
  dictionaryArchiveIdentity,
  dictionaryImportTarget,
} from "./dictionary-import.js";
import { OVERLAY_MODE } from "./overlay-mode.js";
import { dictionaryImportError, isImportMemoryError, nativeImportCall } from "./dictionary-import-errors.js";
import { archiveHoldsRanks } from "./frequency-mode.js";
// HDGlossary.parseTagList: the one U+0020 tag splitter the renderer, Anki and
// the API host share; and the furigana split that withFurigana completes.
import "./render/glossary.js";

// A language code as profiles and packs name languages (docs/languages.md 2),
// and the dictionary state's schema once it has profiles (4.2). The engine
// keeps its own copies: it imports the profile code only once the records
// have profiles.
const LANGUAGE_CODE = /^[a-z]{2,3}$/u;
const DICTIONARY_STATE_PROFILES_SCHEMA = 2;

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
// An MDX dictionary is staged under its own file name because the engine finds
// its MDD resource files as siblings named after the .mdx stem and falls back
// to that stem when the header has no title.
const IMPORT_MDX_DIR = "/.hdw-mdx";
const OPFS_IMPORT_ZIP = `${DICT_ROOT}/.hdw-archive.zip`;
// The OPFS root directory (/dicts in WasmFS) that holds an exported backup
// until Chrome has downloaded it, and a chosen one while it is restored.
const BACKUP_FILE_DIRECTORY = ".hdw-backup-files";

// Index into this array is the `kind` argument of hdw_add_dict.
const KINDS = ["term", "freq", "pitch", "kanji"];

// A directory holding one of these is an imported dictionary; anything else
// under /dicts is debris. _6 and _4 mean the importer trained a zstd dictionary
// for the term banks and wrote a dict.zstd alongside; _5 and _3 mean it did not,
// which is also how every dictionary imported by an older engine looks. _5 and
// _6 store the term score as a double, _4 and older as an int32. All load, so
// the presence of dict.zstd is deliberately not part of the test.
const MARKER_FILES = [".hoshidicts_6", ".hoshidicts_5", ".hoshidicts_4", ".hoshidicts_3", ".hoshidicts_2", ".hoshidicts_1"];

const FREQUENCY_ORDERS = ["auto", "ascending", "descending", "disabled"];
const DEFAULT_MAX_RESULTS = 32;
const DEFAULT_SCAN_LENGTH = 16;
const MAX_LOOKUP_TEXT_BYTES = 4 * 1024;
const MAX_MEDIA_DICTIONARY_BYTES = 1024;
const MAX_MEDIA_PATH_BYTES = 4 * 1024;
const UTF8 = new TextEncoder();

const MEDIA_TYPES = {
  avif: "image/avif",
  webp: "image/webp",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
};

// Status, memory and release do not touch the loaded dictionaries. Imports stage their
// network body outside the engine queue, then explicitly serialize only the
// revalidation and native installation phase.
// Dictionary download reads serve an archive already built by its open, so
// they need no turn in the queue either.
// Segmentation is unqueued too: its handler serialises one engine turn per
// chunk itself (hd_segment) and lets pending messages in between chunks, so a
// hover's lookup runs between a page's chunks.
const UNQUEUED = new Set(["hd_status", "hd_memory", "hd_debug_log", "hd_backup_release", "hd_import", "hd_segment", "hd_api_dictionary_read", "hd_api_dictionary_close"]);

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
let stagingImports = 0;
let generation = 0;
let dictionaryCount = 0;
// Committed packages the engine could not load into its current set.
let loadFailures = [];
let hostRequest = null;
let started = false;
let createHoshidicts = null;
let storageBackend = "memory";
// The single-thread runtime imports on one thread with small read-ahead; the
// pthread runtimes (OPFS or IDBFS) use the bounded worker group, unless the
// low-memory worker asks for one thread too.
let lowRam = true;
// Direct OPFS workers keep entries on disk by default, independently of the
// import threading and recycler (docs/memory.md).
let pagedDictionaries = false;
let dictionaryEntryStorage = "auto";
let dictionaryIndexStorage = "auto";
let useLessRamByDefault = true;
let indexPagedPaths = new Set();
// Whether this is a pthread runtime, as hd_status reports it.
let threaded = false;
// Optional sink for import download/installation phases, keyed by request ID.
let reportProgress = null;
// Optional importer running in its own engine instance on the shared OPFS
// root (engine-worker-runtime.js), so hd_import never blocks or unloads this
// engine. IDBFS runtimes have none: two instances cannot share one IDBFS
// store, so they import inside the live engine (see runImportTransaction).
let isolatedImport = null;
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
  pagedDictionaries = options.pagedDictionaries === true;
  dictionaryEntryStorage = options.dictionaryEntryStorage ?? "auto";
  dictionaryIndexStorage = options.dictionaryIndexStorage ?? "auto";
  useLessRamByDefault = options.useLessRamByDefault !== false;
  threaded = options.threaded ?? !lowRam;
  reportProgress = typeof options.reportProgress === "function" ? options.reportProgress : null;
  isolatedImport = typeof options.isolatedImport === "function" ? options.isolatedImport : null;
}

function asError(error) {
  return error instanceof Error ? error : new Error(describeErrorMessageOrJson(error));
}

class UnknownDictionaryStateCommitError extends Error {
  constructor(commitError, readError, subject = "dictionary state") {
    super(
      `${subject} commit outcome is unknown: ${describeErrorMessageOrJson(commitError)}; `
      + `readback failed: ${describeErrorMessageOrJson(readError)}`,
    );
    this.name = "UnknownDictionaryStateCommitError";
    this.cause = commitError;
  }
}

function text(value) {
  return typeof value === "string" ? value : "";
}

// The folder a package's files live in, as hoshidicts'
// dictionary_importer::folder_name chooses it: the title itself when it is one
// plain path component, otherwise the title with "/", "\\", ":" and NUL as "_"
// plus " #" and the FNV-1a 32-bit hash of its UTF-8 bytes. A Yomitan title is
// any string ("Nico/Pixiv"); only the folder has to be a path component.
function dictionaryFolderName(title) {
  if (title !== "" && title !== "." && title !== ".." && !/[/\\\0]/u.test(title)) {
    return title;
  }
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(title)) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  }
  return `${title.replace(/[/\\:\0]/gu, "_")} #${hash.toString(16).padStart(8, "0")}`;
}

// Whether a title can name a package: any nonempty title whose folder is not
// one of the engine's own staging directories.
function usableDictionaryTitle(title) {
  const folder = title === "" ? "" : dictionaryFolderName(title);
  return folder !== "" && folder !== ".hdw-import" && folder !== ".hdw-remove";
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
    throw new Error(`${source} returned malformed JSON: ${describeErrorMessageOrJson(error)}`);
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

// The engine's ranking options, the same for a hover lookup and a segment.
function lookupOptionsJson(options, extra = {}) {
  return JSON.stringify({
    frequencyDictionary: boundedText(options?.frequencyDictionary, "frequency dictionary", MAX_LOOKUP_TEXT_BYTES, false),
    frequencyOrder: FREQUENCY_ORDERS.includes(options?.frequencyOrder) ? options.frequencyOrder : "auto",
    primaryReading: boundedText(options?.primaryReading, "primary reading", MAX_LOOKUP_TEXT_BYTES, false),
    // Words that only frequency and pitch dictionaries have (#620). The engine
    // never returns them from hdw_lookup_dictionary.
    metadataOnlyTerms: options?.metadataOnlyTerms === true,
    ...extra,
  });
}

// Once the records have profiles, the worker names each lookup's language,
// its profile's enabled package ids and its pack settings' engine effects
// (docs/languages.md 9.3). The ids map to the paths this engine has loaded,
// so a lookup resolved before a reimport swapped a generation still finds
// its dictionary. A request without them is today's: no keys are added.
function languageLookupOptions(message) {
  if (message.language === undefined) return {};
  const language = text(message.language);
  if (languageFailures.some((entry) => entry.language === language)) throw new Error(`${languageName(language)} could not be loaded.`);
  const paths = new Map((loadedPackages ?? []).map((entry) => [entry.id, entry.path]));
  const ids = Array.isArray(message.dictionaries) ? message.dictionaries : [];
  return {
    language,
    dictionaries: ids.filter((id) => paths.has(id)).map((id) => paths.get(id)),
    languageOptions: (Array.isArray(message.languageOptions) ? message.languageOptions : [])
      .filter((option) => typeof option === "string"),
  };
}

function lookupArguments(message) {
  return [
    boundedText(message.text, "lookup text", MAX_LOOKUP_TEXT_BYTES),
    clampInt(message.maxResults, 1, 256, DEFAULT_MAX_RESULTS),
    clampInt(message.scanLength, 1, 64, DEFAULT_SCAN_LENGTH),
    lookupOptionsJson(message.options, languageLookupOptions(message)),
  ];
}

// The English name of a language, for messages.
// The title of the personal package of the language a request is for.
function personalTitle(message) {
  return personalDictionaryIdentity(message.language ?? JAPANESE_PROFILE_ID)?.title ?? CUSTOM_DICTIONARY_TITLE;
}

// The KANJIDIC furigana split is Japanese work: it runs for packs whose ruby
// is anchored on kana (docs/languages.md 9.4), and for requests that name no
// language.
function kanaRuby(message) {
  if (message.language === undefined || message.language === JAPANESE_PROFILE_ID) return true;
  return globalThis.HDLanguages?.get?.(message.language)?.capabilities?.ruby?.alignment === "kana";
}

function termLookupReply(json, source) {
  const parsed = parseJson(json, source);
  if (!Array.isArray(parsed?.results) || !Number.isSafeInteger(parsed?.dictionaryCount)
      || parsed.dictionaryCount < 0) {
    throw new Error(`${source} returned a malformed lookup response`);
  }
  return { results: parsed.results, dictionaryCount: parsed.dictionaryCount, nativeJsonLength: json.length };
}

// A reader with the personal dictionary off leaves out its glossaries. The
// managed package itself stays loaded, enabled and first, so turning the
// option back on needs no rebuild. Filtering after the engine's maxResults
// cut means a personal-only term can use up one result slot.
function withoutPersonalDictionary(reply, message) {
  if (message.options?.personalDictionary !== false) return reply;
  const title = personalTitle(message);
  const results = [];
  for (const result of reply.results) {
    const glossaries = result?.term?.glossaries ?? [];
    const kept = glossaries.filter((glossary) => glossary?.dictionary !== title);
    if (kept.length === glossaries.length) results.push(result);
    else if (kept.length > 0) results.push({ ...result, term: { ...result.term, glossaries: kept } });
  }
  return { ...reply, results };
}

// Each glossary gets `tags`, its definitionTags as Yomitan's Translator expands
// them from the dictionary's tag bank at 67db60d (_expandTagGroups, _createTag,
// _mergeSimilarTags, _groupTags): a name is looked up by its part before ":",
// one the bank lacks is category "default", a repeated name is listed once,
// and the list is sorted by order, then name. definitionTags is left as the
// engine wrote it. The banks change only with the loaded set, so they are read
// once per generation.
const TAG_NAME_COLLATOR = new Intl.Collator("en-US");
// A tag's share of the serialized reply beyond its name, category and notes:
// keys and punctuation (54), a separating comma and two numbers, each at most
// 25 characters (-0.0000012345678901234567). The reply bound counts it with
// the native JSON, so an ordinary reply is still not serialized twice.
const TAG_JSON_OVERHEAD = 54 + 1 + 2 * 25;
let tagBanks = { generation: -1, banks: new Map() };

function tagBank(dictionary) {
  if (tagBanks.generation !== generation) {
    const json = engine.ccall("hdw_tags", "string", [], []);
    throwIfEngineFailed("hdw_tags");
    const banks = new Map();
    for (const { dictionary: title, tags } of parseJson(json, "hdw_tags")) {
      const bank = new Map();
      // Yomitan's findTagMetaBulk answers a name with its first row.
      for (const tag of tags) if (!bank.has(tag.name)) bank.set(tag.name, tag);
      banks.set(title, bank);
    }
    tagBanks = { generation, banks };
  }
  return tagBanks.banks.get(dictionary);
}

// Yomitan's _expandTagGroups and _groupTags for one definitionTags string and
// its dictionary's tag bank (a Map from name to row; undefined without one).
export function expandDefinitionTags(definitionTags, bank) {
  const tags = [];
  for (const name of new Set(globalThis.HDGlossary.parseTagList(definitionTags))) {
    const colon = name.indexOf(":");
    const entry = bank?.get(colon < 0 ? name : name.slice(0, colon));
    tags.push({ name, category: entry?.category || "default", order: entry?.order ?? 0,
      score: entry?.score ?? 0, notes: entry?.notes ?? "" });
  }
  return tags.sort((left, right) => left.order - right.order || TAG_NAME_COLLATOR.compare(left.name, right.name));
}

function withDefinitionTags(reply) {
  let tagJsonLength = 0;
  for (const result of reply.results) {
    for (const glossary of result?.term?.glossaries ?? []) {
      glossary.tags = expandDefinitionTags(glossary.definitionTags, tagBank(glossary.dictionary));
      tagJsonLength += ',"tags":[]'.length;
      for (const { name, category, notes } of glossary.tags) {
        tagJsonLength += TAG_JSON_OVERHEAD + name.length + category.length + notes.length;
      }
    }
  }
  return { ...reply, nativeJsonLength: reply.nativeJsonLength + tagJsonLength };
}

// A headword gets `term.furigana`, the split its kanji's KANJIDIC readings
// give it (HDGlossary.kanjiFurigana), where that differs from the split the
// renderer makes alone: where the kana leave more than one split, the one that
// reads (#459), and each run of kanji read one kanji at a time (#605), where
// KANJIDIC's readings read none by Jitendex kanwa's readings and compounds as
// well (#641). Every other reply stays as the engine wrote it. The readings
// tables are imported and indexed as the engine starts (startEngine), so the
// first lookup need not wait for them, and kept for the worker's life; each
// kanji's readings are derived as it is needed.
let readingTables = null;

function importKanjiReadings() {
  return Promise.all([
    import("./vendor/kanjidic/kanji-readings.json", { with: { type: "json" } }),
    import("./vendor/kanwa/kanwa-readings.json", { with: { type: "json" } }),
  ]).then(([{ default: kanjidic }, { default: kanwa }]) => {
    if (readingTables === null) {
      const { createKanjiReadings, createKanwaReadings } = globalThis.HDGlossary;
      const kanjiReadings = createKanjiReadings(kanjidic.readings);
      readingTables = { kanjiReadings, kanwa: createKanwaReadings(kanwa, kanjiReadings) };
    }
    return readingTables;
  });
}

export async function withFurigana(reply) {
  if (reply.results.length === 0) return reply;
  const { kanjiReadings, kanwa } = readingTables ?? await importKanjiReadings();
  const { kanjiFurigana } = globalThis.HDGlossary;
  let furiganaJsonLength = 0;
  for (const result of reply.results) {
    const term = result?.term;
    const furigana = term ? kanjiFurigana(term.expression, term.reading, kanjiReadings, kanwa) : null;
    if (furigana === null) continue;
    term.furigana = furigana;
    furiganaJsonLength += ',"furigana":'.length + JSON.stringify(furigana).length;
  }
  return furiganaJsonLength === 0 ? reply
    : { ...reply, nativeJsonLength: reply.nativeJsonLength + furiganaJsonLength };
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

// Resolves once the messages that reached the engine before it are dispatched.
// A request arrives as a message event, a task of its own, and a loop of
// serialised turns runs as one chain of microtasks, which no message can enter
// until the loop ends.
function yieldToMessages() {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
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
    // Trim first: IDBFS stores each file as a view of its array, and a
    // structured clone of a view carries the whole backing buffer.
    trimMemfsFiles(DICT_ROOT);
    const stored = new Map();
    pendingBlobPaths = stored;
    try {
      await syncfs(false);
    } finally {
      pendingBlobPaths = null;
    }
    await adoptPersistedBlobs(stored);
  }
}

// The classic FS keeps every file as a JavaScript array that grows by 12.5% per
// write once it passes 1 MiB, so streaming an 80 MB blobs.bin copies about nine
// times its size (expandFileStorage was 340 ms of a Jitendex import in
// Electron). Doubling instead copies about twice its size; the slack is given
// back by trimMemfsFiles before the import is persisted.
function speedUpMemfsGrowth() {
  const memfs = engine.FS?.filesystems?.MEMFS;
  if (typeof memfs?.expandFileStorage !== "function"
      || typeof memfs.getFileDataAsTypedArray !== "function") {
    return;
  }
  memfs.expandFileStorage = (node, newCapacity) => {
    const prevCapacity = node.contents.length;
    if (prevCapacity >= newCapacity) return;
    const capacity = Math.max(newCapacity, prevCapacity * 2, 256) >>> 0;
    const oldContents = memfs.getFileDataAsTypedArray(node);
    node.contents = new Uint8Array(capacity);
    node.contents.set(oldContents);
  };
}

// IDBFS persists each file as an IndexedDB record whose `contents` is a
// Uint8Array. Chromium serialises such a value through the renderer on every
// put and deserialises it on every get, and the cost grew with the size of the
// database (Electron: 400, 630 and 880 ms for three imports of 70–100 MB).
// A Blob value is handed to the browser's blob storage once; the same three
// imports persist in 230, 280 and 340 ms. Files under 1 MiB stay arrays.
//
// A file whose record is a Blob is also not copied back into JavaScript: its
// MEMFS node keeps the Blob (`node.blob`, contents null) and reads, `mmap` and
// the IDBFS mirror read only the ranges they need with FileReaderSync. `mmap`
// still copies the mapped bytes into the heap, as for any MEMFS file. A write
// or a truncation reads the file into an ordinary array first. A freshly
// imported file is swapped for its stored Blob only once the persistence that
// wrote it has completed, so a failed sync still has the bytes to retry or
// roll back. Records written as arrays by earlier versions still load as
// arrays. FileReaderSync exists only in workers, so the single-thread engine
// in the offscreen document keeps whole-file arrays.
const IDBFS_BLOB_THRESHOLD = 1024 * 1024;
// Bytes per FileReaderSync read: transfer-sized, not a limit on files.
const BLOB_READ_CHUNK = 8 * 1024 * 1024;
// Paths of files persisted as Blobs by the sync in flight, with the timestamp
// they were stored at; adoptPersistedBlobs() swaps them in after it completes.
let pendingBlobPaths = null;

function blobBackedIdbfs() {
  const FS = engine.FS;
  const memfs = FS?.filesystems?.MEMFS;
  const idbfs = FS?.filesystems?.IDBFS;
  return FS && memfs?.ops_table?.file && idbfs && typeof FileReaderSync === "function" && typeof Blob === "function"
    ? { FS, memfs, idbfs } : null;
}

// MEMFS stream operations return synchronously to the native caller, so the
// asynchronous Blob#arrayBuffer() cannot be used here.
function readBlobRange(blob, start, end, target, targetOffset) {
  const reader = new FileReaderSync();
  for (let offset = start; offset < end; offset += BLOB_READ_CHUNK) {
    const chunk = blob.slice(offset, Math.min(end, offset + BLOB_READ_CHUNK));
    const bytes = new Uint8Array(reader.readAsArrayBuffer(chunk)); // NOSONAR: must be synchronous, see above
    target.set(bytes, targetOffset + offset - start);
  }
}

function backWithBlob(node, blob) {
  node.blob = blob;
  node.contents = null;
  node.usedBytes = blob.size;
}

// Before a node's bytes change: give it an ordinary array of its contents.
function materializeBlob(node) {
  const blob = node.blob;
  if (blob === undefined) return;
  delete node.blob;
  const contents = new Uint8Array(blob.size);
  readBlobRange(blob, 0, blob.size, contents, 0);
  node.contents = blob.size > 0 ? contents : null;
  node.usedBytes = blob.size;
}

function storeLargeIdbfsFilesAsBlobs() {
  const fs = blobBackedIdbfs();
  if (fs === null) return;
  const { FS, memfs, idbfs } = fs;
  // Every MEMFS file shares these op tables, and an open stream keeps the
  // table it was opened with, so the Blob paths are added to them rather than
  // to individual nodes: a file opened as an array keeps working once it is
  // backed by its Blob.
  const stream = memfs.ops_table.file.stream;
  const node = memfs.ops_table.file.node;
  const { read, write, mmap, msync } = stream;
  const setattr = node.setattr;
  stream.read = (handle, buffer, offset, length, position) => {
    const file = handle.node;
    if (file.blob === undefined) return read(handle, buffer, offset, length, position);
    if (position >= file.usedBytes) return 0;
    const size = Math.min(file.usedBytes - position, length);
    readBlobRange(file.blob, position, position + size,
      new Uint8Array(buffer.buffer, buffer.byteOffset + offset, size), 0);
    return size;
  };
  stream.write = (handle, ...rest) => {
    materializeBlob(handle.node);
    return write(handle, ...rest);
  };
  stream.mmap = (handle, length, position, prot, flags) => {
    const file = handle.node;
    if (file.blob === undefined) return mmap(handle, length, position, prot, flags);
    // MEMFS allocates the mapping and copies a one-byte stand-in, which also
    // refreshes the module's heap view after any growth; the range follows.
    const mapped = mmap({ node: { mode: file.mode, contents: new Uint8Array(1) } }, length, 0, prot, flags);
    const end = Math.min(file.usedBytes, position + length);
    if (end > position) readBlobRange(file.blob, position, end, engine.HEAPU8, mapped.ptr);
    return mapped;
  };
  // hoshidicts' unmap calls msync on every mapping. A mapping through a
  // read-only descriptor cannot have changed, so nothing is written back:
  // MEMFS would otherwise rewrite the identical bytes, touching the file's
  // mtime (and so its next IDBFS sync), and a Blob-backed file would be read
  // into an array first.
  stream.msync = (handle, ...rest) => {
    if ((handle.flags & 3) === 0) return 0;
    materializeBlob(handle.node);
    return msync(handle, ...rest);
  };
  node.setattr = (file, attr) => {
    if (attr.size !== undefined && file.blob !== undefined) {
      if (attr.size === 0) {
        delete file.blob;
        file.contents = null;
        file.usedBytes = 0;
      } else {
        materializeBlob(file);
      }
    }
    return setattr(file, attr);
  };

  const { storeRemoteEntry, storeLocalEntry, loadLocalEntry } = idbfs;
  idbfs.storeRemoteEntry = (store, path, entry, callback) => {
    if (entry?.contents instanceof Uint8Array && entry.contents.byteLength >= IDBFS_BLOB_THRESHOLD) {
      entry = { ...entry, contents: new Blob([entry.contents]) };
      pendingBlobPaths?.set(path, entry.timestamp.getTime());
    }
    return storeRemoteEntry(store, path, entry, callback);
  };
  // Restoring a Blob record creates the file empty and backs it with the Blob.
  idbfs.storeLocalEntry = (path, entry, callback) => {
    if (!(entry?.contents instanceof Blob) || !FS.isFile(entry.mode)) {
      return storeLocalEntry(path, entry, callback);
    }
    try {
      FS.writeFile(path, new Uint8Array(0));
      backWithBlob(FS.lookupPath(path).node, entry.contents);
      FS.chmod(path, entry.mode);
      FS.utime(path, entry.timestamp, entry.timestamp);
    } catch (error) {
      return callback(error);
    }
    return callback(null);
  };
  // A renamed Blob-backed file is stored again under its new path as the Blob.
  idbfs.loadLocalEntry = (path, callback) => {
    let file;
    try {
      file = FS.lookupPath(path).node;
    } catch (error) {
      return callback(error);
    }
    if (file.blob === undefined) return loadLocalEntry(path, callback);
    return callback(null, { timestamp: new Date(file.mtime), mode: file.mode, contents: file.blob });
  };
}

// After a successful sync, back each file it stored as a Blob with the record
// read back from IndexedDB, unless the file changed since. Best effort: a file
// left as an array is correct, only larger.
async function adoptPersistedBlobs(paths) {
  const fs = blobBackedIdbfs();
  const db = fs?.idbfs.dbs?.[DICT_ROOT];
  if (fs === null || db === undefined || paths.size === 0) return;
  const records = await new Promise((resolve) => {
    const found = new Map();
    try {
      const transaction = db.transaction([fs.idbfs.DB_STORE_NAME], "readonly");
      const store = transaction.objectStore(fs.idbfs.DB_STORE_NAME);
      for (const path of paths.keys()) {
        const request = store.get(path);
        request.onsuccess = () => found.set(path, request.result);
      }
      transaction.oncomplete = () => resolve(found);
      transaction.onerror = transaction.onabort = (event) => {
        event?.preventDefault?.();
        resolve(new Map());
      };
    } catch {
      resolve(new Map());
    }
  });
  for (const [path, timestamp] of paths) {
    const blob = records.get(path)?.contents;
    let file;
    try {
      file = fs.FS.lookupPath(path).node;
    } catch {
      continue;
    }
    if (blob instanceof Blob && fs.FS.isFile(file.mode) && file.blob === undefined
        && file.mtime === timestamp && file.usedBytes === blob.size) {
      backWithBlob(file, blob);
    }
  }
}

// Reallocate over-allocated classic-FS files under `root` to their exact size.
function trimMemfsFiles(root) {
  let node;
  try {
    node = engine.FS.lookupPath(root).node;
  } catch {
    return;
  }
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (engine.FS.isDir(current.mode)) {
      for (const child of Object.values(current.contents ?? {})) stack.push(child);
    } else if (engine.FS.isFile(current.mode)
        && current.contents instanceof Uint8Array
        && current.contents.length > current.usedBytes) {
      current.contents = current.contents.slice(0, current.usedBytes);
    }
  }
}

function exists(path) {
  try {
    engine.FS.stat(path);
    return true;
  } catch {
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
  // A legacy package may be titled .hdw-remove (the removal recovery keeps
  // it); only the import staging directory can never hold a package.
  const folder = title === "" ? "" : dictionaryFolderName(title);
  if (folder === "" || folder === ".hdw-import") {
    return null;
  }
  if (path === `${DICT_ROOT}/${folder}`) {
    return path;
  }
  const separator = path.lastIndexOf("/");
  const root = path.slice(0, separator);
  return separator > DICT_ROOT.length
    && path === `${root}/${folder}`
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
  } catch {
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
  } catch {
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

// Generation roots an isolated import is still writing. No manifest references
// them yet, and the import runs outside the engine queue, so a reload's cleanup
// could otherwise run in between and delete them.
const importingRoots = new Set();

async function cleanupUnreferencedDictionaries(dictionaries) {
  const referencedRoots = new Set(dictionaries.map((dictionary) => dictionaryRoot(dictionary)));
  if (referencedRoots.has(null)) {
    throw new Error("the committed dictionary state contains an invalid path");
  }
  for (const root of importingRoots) referencedRoots.add(root);
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

function settleStagedRemoval(folder, restore) {
  const stagedPath = `${REMOVAL_ROOT}/${folder}`;
  if (!exists(stagedPath)) {
    return false;
  }
  if (restore) {
    moveDictionaryFiles(stagedPath, `${DICT_ROOT}/${folder}`, true);
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

function withRecommendedSource(dictionary, source) {
  return {
    ...dictionary,
    sourceId: source.sourceId,
    isUpdatable: source.indexUrl !== null,
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

// Longest key, in code points, that the dictionary's long-key scan index
// records: the importer lists every key longer than 16 code points by its
// first eight, and the engine extends a lookup past its scan length only when
// the text begins like one of them (hoshidicts src/scan_index.hpp). The reader
// adds this to the page text it collects so such a key can be seen at all.
// Header: u32 magic "HDSI", u32 version, u32 count, u16 longest key. 0 for a
// dictionary imported before the index existed or with no long key.
const SCAN_INDEX_MAGIC = 0x49534448;
const SCAN_INDEX_VERSION = 1;
const SCAN_INDEX_HEADER_BYTES = 16;

function longKeyLengthFromScanIndex(path) {
  const file = `${path}/scan.idx`;
  if (!exists(file)) return 0;
  const header = new Uint8Array(SCAN_INDEX_HEADER_BYTES);
  let read = 0;
  try {
    const stream = engine.FS.open(file, "r");
    try {
      read = engine.FS.read(stream, header, 0, SCAN_INDEX_HEADER_BYTES, 0);
    } finally {
      engine.FS.close(stream);
    }
  } catch {
    // An unreadable index only costs the long-key window; the dictionary
    // itself still loads and lookups stay at the configured scan length.
    return 0;
  }
  if (read < SCAN_INDEX_HEADER_BYTES) return 0;
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (view.getUint32(0, true) !== SCAN_INDEX_MAGIC || view.getUint32(4, true) !== SCAN_INDEX_VERSION) return 0;
  return view.getUint16(12, true);
}

function readDictionaryIndex(path, FS = engine.FS) {
  const json = new TextDecoder().decode(FS.readFile(`${path}/index.json`));
  return parseJson(json, `${path}/index.json`);
}

function writeDictionaryIndex(path, index, FS = engine.FS) {
  const indexPath = `${path}/index.json`;
  // WasmFS's OPFS writeFile does not reliably truncate an existing file. This
  // serialized rewrite can be shorter than the engine-generated index, leaving
  // trailing JSON bytes if it overwrites the file in place.
  FS.unlink(indexPath);
  FS.writeFile(indexPath, new TextEncoder().encode(JSON.stringify(index)));
}

function importedIdentityFromIndex(path) {
  return dictionaryArchiveIdentity(readDictionaryIndex(path));
}

// Rows of records with profiles also carry the index's `targetLanguage`,
// which glossary direction and language, child-popup switching and notes read
// (docs/languages.md 4.2, 10.1-10.3, 12). Single-profile rows keep today's
// fields, so only the schema-2 commits and the conversion add it.
function withTargetLanguage(row) {
  if (!row || typeof row !== "object" || typeof row.path !== "string") return row;
  let target;
  try {
    target = optionalText(readDictionaryIndex(row.path)?.targetLanguage);
  } catch {
    return row;
  }
  const rest = { ...row };
  delete rest.targetLanguage;
  return target ? { ...rest, targetLanguage: target } : rest;
}

function withTargetLanguages(state) {
  return { ...state, dictionaries: state.dictionaries.map(withTargetLanguage) };
}

async function packageFromIndex(path) {
  const index = readDictionaryIndex(path);
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
    frequencyCount: count(index?.counts?.termMeta?.freq) + count(index?.counts?.kanjiMeta?.freq),
    pitchCount: count(index?.counts?.termMeta?.pitch) + count(index?.counts?.termMeta?.ipa),
    kanjiCount: count(index?.counts?.kanji?.total),
    mediaCount: count(index?.counts?.media?.total),
    longKeyLength: longKeyLengthFromScanIndex(path),
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
    const path = `${DICT_ROOT}/${dictionaryFolderName(title)}`;
    if (dictionaryRoot({ title, path }) === null) {
      continue;
    }
    let stat;
    try {
      stat = FS.stat(path);
    } catch {
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

// Records with profiles (docs/languages.md 9.2). The engine reads the whole
// schema-2 record but works, as before, on one list: every package once,
// with `enabled` meaning enabled in any profile, which is the set it loads.
// The view keeps the stored record in `stored`, and a commit merges its next
// list back into every profile (mergeEngineDictionaries). Replies to pages
// carry the stored record. A schema-1 state is its own view.
const JAPANESE_PROFILE_ID = "ja";
// Whether the last records this engine read have profiles, and their
// languages in the records' order (hd_state_read's `languages`).
let profileRecords = false;
let recordLanguages = [];

// The profile code (docs/languages.md 5): the packs' descriptors
// (registry.js), the profile projections (reader-options.js) and the
// schema-2 merges (profile-state.js). A Japanese-only start uses none of it,
// so the engine imports it the first time the records it reads have profiles,
// and before it runs a request that reads it in either shape
// (readsProfileCode). Every use runs after one of those.
let profileState = null;
let profileCode = null;

function loadProfileCode() {
  profileCode ??= Promise.all([
    import("./vendor/languages/registry.js"),
    import("./reader-options.js"),
    import("./profile-state.js"),
  ]).then(([, , module]) => {
    profileState = module;
  });
  return profileCode;
}

// The requests that read the profile code whatever the records' shape: the
// profile requests, every request made for a profile or a language (section
// 5.4), an import (every pack's personal title is reserved), a removal (no
// pack's personal package can be removed) and the backups (backup-state.js
// reads the registry).
const PROFILE_CODE_TYPES = new Set(["hd_profile_add", "hd_profile_remove", "hd_import", "hd_remove",
  "hd_backup_export", "hd_backup_prepare", "hd_backup_auto_prepare", "hd_backup_restore", "hd_api_dictionary_open"]);

function readsProfileCode(type, message) {
  return PROFILE_CODE_TYPES.has(type) || message.profileId !== undefined || message.language !== undefined;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// reader-options.js's hasDictionaryProfiles, without loading it: schema 2
// with a profiles object. Any other state has the single-profile shape.
function hasDictionaryProfiles(state) {
  return isObject(state) && state.schemaVersion === DICTIONARY_STATE_PROFILES_SCHEMA && isObject(state.profiles);
}

function engineState(state) {
  if (!hasDictionaryProfiles(state)) return state;
  return { schemaVersion: 1, revision: state.revision, dictionaries: globalThis.HDReaderOptions.allPackages(state),
    groups: [], stored: state };
}

function publicState(state) {
  return state?.stored ?? state;
}

function validProfileState(state) {
  return Number.isInteger(state?.revision) && state.revision >= 0 && Array.isArray(state.dictionaries)
    && isObject(state.profiles);
}

async function requestDictionaryStorage() {
  const reply = await ask("hd_state_read");
  if (reply.ok !== true) {
    throw new Error(reply.error || "the service worker could not read dictionary state");
  }
  if (hasDictionaryProfiles(reply.state)) {
    if (!validProfileState(reply.state) || !Array.isArray(reply.languages)) {
      throw new Error("the service worker returned invalid dictionary state");
    }
    await loadProfileCode();
    profileRecords = true;
    recordLanguages = reply.languages.filter(code => typeof code === "string");
    // This engine's debug log redacts the records' languages too (docs/languages.md 8.5).
    setDebugLogLanguages(recordLanguages);
    return { state: engineState(reply.state), legacyDictionaries: null };
  }
  profileRecords = false;
  recordLanguages = [];
  setDebugLogLanguages(recordLanguages);
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
  const { state } = await requestDictionaryStorage();
  return state?.dictionaries ?? [];
}

// `language` is null for a request that names none: today's message.
async function readCustomStorage(language = null) {
  const reply = await ask("hd_custom_read", language === null ? {} : { language });
  if (reply.ok !== true) {
    throw new Error(reply.error || "the service worker could not read the custom dictionary");
  }
  if (hasDictionaryProfiles(reply.state)) {
    if (!validProfileState(reply.state)) throw new Error("the service worker returned invalid custom dictionary state");
    await loadProfileCode();
    profileRecords = true;
    return { document: normaliseCustomDictionaryDocument(reply.document), state: engineState(reply.state) };
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

// The personal dictionary a save is for (docs/languages.md 15): `language`
// is null for a request that names none, which means Japanese.
const JAPANESE_CUSTOM = Object.freeze({ language: null, identity: personalDictionaryIdentity(JAPANESE_PROFILE_ID) });

function customRequest(message) {
  const language = message?.language ?? null;
  if (language === null) return JAPANESE_CUSTOM;
  if (typeof language !== "string" || !LANGUAGE_CODE.test(language)) {
    throw new TypeError("the custom dictionary request named an invalid language");
  }
  const identity = personalDictionaryIdentity(language);
  if (identity === null) throw new Error(`This Hachidori has no personal dictionary for ${language}.`);
  return { language, identity };
}

// Replies to pages carry the stored record, not the engine's view of it.
function withPublicState(reply) {
  return reply && Object.hasOwn(reply, "state") ? { ...reply, state: publicState(reply.state) } : reply;
}

// hd_custom_cas for records with profiles: the language's document, and the
// whole schema-2 record when the package list changes.
async function commitProfileCustomStorage(snapshot, source, semanticRevision, dictionaries, custom) {
  const document = expectedCustomDocument(snapshot.document, source, semanticRevision);
  const { stored } = snapshot.state;
  const next = dictionaries === undefined ? null
    : profileState.mergeEngineDictionaries(stored, dictionaries.map(withTargetLanguage));
  const changesState = next !== null
    && !(sameJsonValue(next.dictionaries, stored.dictionaries) && sameJsonValue(next.profiles, stored.profiles));
  const language = custom.language ?? JAPANESE_PROFILE_ID;
  const fields = {
    language,
    baseDocumentRevision: snapshot.document.revision,
    baseRevision: snapshot.state.revision,
    text: source,
    semanticRevision,
    ...(changesState ? { state: { dictionaries: next.dictionaries, profiles: next.profiles } } : {}),
  };
  const expected = changesState ? { ...next, revision: stored.revision + 1 } : stored;
  try {
    const reply = await ask("hd_custom_cas", fields);
    const result = { ...reply };
    delete result.type;
    delete result.requestId;
    delete result.generation;
    if (Object.hasOwn(result, "state")) result.state = engineState(result.state);
    return result;
  } catch (commitError) {
    let current;
    try {
      current = await readCustomStorage(language);
    } catch (readError) {
      throw new UnknownDictionaryStateCommitError(commitError, readError, "custom dictionary");
    }
    const committed = publicState(current.state);
    const sameState = committed?.revision === expected.revision && sameJsonValue(committed.dictionaries, expected.dictionaries)
      && sameJsonValue(committed.profiles, expected.profiles);
    if (sameJsonValue(current.document, document) && sameState) return { ok: true, document, state: current.state };
    if (sameJsonValue(current.document, document)) {
      throw new UnknownDictionaryStateCommitError(commitError,
        new Error("readback did not match the exact source and dictionary-state pair"), "custom dictionary");
    }
    return {
      ok: false,
      stale: current.document.revision !== snapshot.document.revision,
      conflict: current.state?.revision !== snapshot.state.revision,
      error: describeErrorMessageOrJson(commitError),
      ...current,
    };
  }
}

async function commitCustomStorage(snapshot, source, semanticRevision, dictionaries, custom = JAPANESE_CUSTOM) {
  if (snapshot.state === null) {
    throw new Error("the dictionary state is unavailable");
  }
  if (snapshot.state.stored) return commitProfileCustomStorage(snapshot, source, semanticRevision, dictionaries, custom);
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
      error: describeErrorMessageOrJson(commitError),
      ...current,
    };
  }
}

// A schema-2 commit writes the whole record (docs/languages.md 5.2); a lost
// reply is checked by reading back that whole record.
async function commitProfileDictionaryState(baseRevision, next) {
  const body = { dictionaries: next.dictionaries, profiles: next.profiles };
  try {
    const reply = await ask("hd_state_cas", { baseRevision, state: body });
    return Object.hasOwn(reply, "state") ? { ...reply, state: engineState(reply.state) } : reply;
  } catch (commitError) {
    let state;
    try {
      ({ state } = await requestDictionaryStorage());
    } catch (readError) {
      throw new UnknownDictionaryStateCommitError(commitError, readError);
    }
    const committed = publicState(state);
    if (committed?.revision === baseRevision + 1 && sameJsonValue(committed.dictionaries, body.dictionaries)
        && sameJsonValue(committed.profiles, body.profiles)) {
      return { ok: true, state };
    }
    return {
      ok: false,
      conflict: (state?.revision ?? 0) !== baseRevision,
      error: describeErrorMessageOrJson(commitError),
      state,
    };
  }
}

// A service worker can commit the CAS and disappear before its reply reaches
// this worker. Read back that one exact revision so callers do not report a
// failed change which storage already accepted. With profiles, `context`
// holds the stored record the list was built from and the profile a new
// package joins.
async function commitDictionaryState(baseRevision, dictionaries, context = null) {
  if (context?.stored) {
    return commitProfileDictionaryState(baseRevision, profileState.mergeEngineDictionaries(context.stored,
      dictionaries.map(withTargetLanguage), { profileId: context.profileId ?? JAPANESE_PROFILE_ID, joins: context.joins ?? [] }));
  }
  try {
    return await ask("hd_state_cas", { baseRevision, dictionaries });
  } catch (commitError) {
    let state;
    try {
      ({ state } = await requestDictionaryStorage());
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
      error: describeErrorMessageOrJson(commitError),
      state,
    };
  }
}

async function recoverPendingRemovals(snapshot) {
  if (!exists(REMOVAL_ROOT)) {
    return;
  }
  const stored = snapshot.state?.dictionaries ?? snapshot.legacyDictionaries ?? [];
  const retainedFolders = new Set(stored.map((dictionary) => text(dictionary?.title))
    .filter(usableDictionaryTitle).map(dictionaryFolderName));
  let changed = false;
  for (const folder of engine.FS.readdir(REMOVAL_ROOT)) {
    const stagedPath = `${REMOVAL_ROOT}/${folder}`;
    if (folder === "." || folder === ".." || !usableDictionaryTitle(folder)
        || !isDirectory(engine.FS.stat(stagedPath))) {
      continue;
    }
    changed = settleStagedRemoval(folder, retainedFolders.has(folder)) || changed;
  }
  if (changed) {
    await persistFilesystem();
  }
}

// `buildCandidate` must derive its list from the supplied snapshot: a refused
// write is rebuilt against the authoritative state before it is attempted again.
// Loading happens before the CAS so a disabled corrupt package cannot be
// published merely because the live engine would otherwise skip it.
// The ids of the packages at the generation path `joining()` names.
function joinedIds(next, joining) {
  if (joining === null) return [];
  const path = joining();
  return next.filter(row => row.path === path).map(row => row.id);
}

function assertCommittedState(state) {
  if (state?.schemaVersion !== 1 || !Number.isInteger(state?.revision) || !Array.isArray(state?.dictionaries)) {
    throw new Error("the service worker returned invalid committed dictionary state");
  }
}

// `joining()` names the generation path of a package that joins `profileId`
// even when it was installed already (an import requested for the profile).
async function commitDictionaryCandidate(buildCandidate, { profileId = JAPANESE_PROFILE_ID, joining = null } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const snapshot = await requestDictionaryStorage();
    // The single-profile shape has only the Japanese profile (section 5.2).
    if (!snapshot.state?.stored && profileId !== JAPANESE_PROFILE_ID) {
      throw profileRequestError(profileMessages().profileRemoved, "profile-missing");
    }
    const next = await buildCandidate(snapshot);
    const loadedCount = loadDictionaries(next, { committed: snapshot.state?.dictionaries ?? [] });
    if (snapshot.state !== null && sameDictionaries(next, snapshot.state.dictionaries)) {
      return { state: snapshot.state, loadedCount };
    }
    const baseRevision = snapshot.state?.revision ?? 0;
    const reply = await commitDictionaryState(baseRevision, next,
      snapshot.state?.stored ? { stored: snapshot.state.stored, profileId, joins: joinedIds(next, joining) } : null);
    if (reply.ok === true) {
      assertCommittedState(reply.state);
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
    // Preserve fields introduced by newer Hachidori versions or integrations.
    // Generated engine metadata below replaces only values owned by this import.
    ...stored,
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
      console.warn(`hoshidicts: could not refresh ${path}: ${describeErrorMessageOrJson(error)}`);
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
  await recoverPendingRemovals(await requestDictionaryStorage());
  // Packs load before the dictionaries publish, so no lookup of a new engine
  // instance runs without its language (docs/languages.md 9.2).
  if (profileRecords) await loadLanguagePacks(recordLanguages, { all: true });
  else languageFailures = [];
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

// bindings.cpp rejected_dictionary: the heap could not grow to hold the files.
const OUT_OF_MEMORY = "not enough memory to load ";

// Packages that did not fit in the heap this session. Their paths are
// generation-scoped and never change, so each loads with its entries read from
// disk from then on instead of growing the heap towards the same failure.
const pagedPaths = new Set();

function loadsPaged(path) {
  return pagedDictionaries || pagedPaths.has(path);
}

// `validation` adds a disabled package only to prove the engine opens it, then
// drops it: its entries are read on demand rather than copied into the heap,
// which would only raise the worker's high-water mark (docs/memory.md). Its
// hash header is checked without mapping the table under a paged policy.
function addDictionaryKind(dictionary, kind, { validation = false } = {}) {
  const indexPaged = indexPagedPaths.has(dictionary.path)
    || (validation && indexPolicy() !== "resident");
  const add = (paged) => engine.ccall(
    "hdw_add_dict", "number", ["string", "number", "number", "number"], [dictionary.path, kind, paged ? 1 : 0, indexPaged ? 1 : 0],
  ) === 1;
  const paged = validation || loadsPaged(dictionary.path);
  if (add(paged)) return true;
  // Only the selected resident files have to fit when entries are paged.
  if (paged || !lastError().startsWith(OUT_OF_MEMORY) || !add(true)) return false;
  pagedPaths.add(dictionary.path);
  return true;
}

function addDictionaries(dictionaries, includeDisabled, options) {
  let loadedCount = 0;
  for (const dictionary of dictionaries) {
    if (!includeDisabled && dictionary.enabled === false) {
      continue;
    }
    for (const kindName of kindsForPackage(dictionary)) {
      if (!addDictionaryKind(dictionary, KINDS.indexOf(kindName), options)) {
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
//
// Loading a package copies its files into the wasm heap (about 1 ms per MB, so
// 100-150 ms for Jitendex or Pixiv), and the engine cannot reorder or drop a
// loaded package on its own, so the first version of this rebuilt the whole
// set on every change. `loadedPackages` and `verifiedPackages` let a change
// that reorders, disables, or re-enables packages this session already loaded,
// or swaps one package's generation for a freshly imported one, be applied in
// place through hdw_remove_dict / hdw_add_dict / hdw_set_dict_order instead.
// Package paths are generation-scoped and their files never change once
// loaded, so a package that loaded once this session loads again; a failure
// falls back to the full rebuild below, which also discards whatever an
// interrupted incremental step left behind.
let loadedPackages = null;
// Includes disabled and tolerated failed packages. A reorder of this exact
// manifest must not retry a failed package or rebuild its healthy neighbours.
let loadedManifest = null;
let lastLoadPath = null;
const verifiedPackages = new Map();

function packageKinds(dictionary) {
  return kindsForPackage(dictionary).join(",");
}

function resetEngine() {
  engine.ccall("hdw_reset", null, [], []);
  loadedPackages = null;
  loadedManifest = null;
}

function trackLoaded(dictionaries, manifest = dictionaries) {
  loadedPackages = dictionaries.map((dictionary) => ({
    id: optionalText(dictionary.id),
    title: text(dictionary.title),
    path: dictionary.path,
    kinds: packageKinds(dictionary),
    paged: loadsPaged(dictionary.path),
    indexPaged: engine.ccall("hdw_hash_index_paged", "number", ["string"], [dictionary.path]) === 1,
  }));
  for (const entry of loadedPackages) verifiedPackages.set(entry.path, entry.kinds);
  loadedManifest = new Map(manifest.map(dictionary => [dictionary.path, {
    id: dictionary.id, title: dictionary.title, kinds: packageKinds(dictionary), enabled: dictionary.enabled !== false,
  }]));
}

function retainVerified(dictionaries) {
  const requested = new Set(dictionaries.map((dictionary) => dictionary.path));
  for (const path of [...verifiedPackages.keys()]) {
    if (!requested.has(path)) verifiedPackages.delete(path);
  }
  // Deleting the entry being visited is safe while iterating a Set.
  for (const path of pagedPaths) {
    if (!requested.has(path)) pagedPaths.delete(path);
  }
}

function isVerified(dictionary) {
  return verifiedPackages.get(dictionary.path) === packageKinds(dictionary);
}

// Only hd_apply_state (and its rollback) uses this path; an explicit reload
// still retries failed packages. The native set comes from the last successful
// load, not from verification of packages which are intentionally unloaded.
// Returns the loaded count, or null when the change needs loadDictionaries().
function reorderLoadedDictionaries(dictionaries) {
  if (loadedPackages === null || loadedManifest?.size !== dictionaries.length
    || !dictionaries.every(dictionary => {
      const loaded = loadedManifest.get(dictionary.path);
      return loaded?.id === dictionary.id && loaded?.title === dictionary.title
        && loaded?.kinds === packageKinds(dictionary) && loaded.enabled === (dictionary.enabled !== false);
    })) return null;
  const present = new Set(loadedPackages.map(entry => entry.path));
  const ordered = dictionaries.filter(dictionary => present.has(dictionary.path));
  // A refused order changes nothing natively; the loaded set has drifted and
  // the ordinary load path rebuilds it.
  if (!engine.ccall("hdw_set_dict_order", "number", ["string"], [JSON.stringify(ordered.map(entry => entry.path))])) {
    return null;
  }
  trackLoaded(ordered, dictionaries);
  lastLoadPath = "order-only";
  return ordered.reduce((count, dictionary) => count + kindsForPackage(dictionary).length, 0);
}

// A disabled package must also prove it loads before it is committed: add and
// drop each one in place rather than rebuilding the whole set around it.
// Returns false when the engine refused a drop.
function verifyDisabledPackagesInPlace(dictionaries) {
  for (const dictionary of dictionaries) {
    if (dictionary.enabled !== false || isVerified(dictionary)) continue;
    addDictionaries([dictionary], true, { validation: true });
    if (!engine.ccall("hdw_remove_dict", "number", ["string"], [dictionary.path])) return false;
    verifiedPackages.set(dictionary.path, packageKinds(dictionary));
  }
  return true;
}

// Returns the loaded count, or null when the change needs the full rebuild.
// A package this session has not loaded yet (a freshly imported generation) is
// added here too: hdw_add_dict is the verification, and a failure falls back to
// the full rebuild, which tolerates only committed packages.
function loadDictionariesIncrementally(dictionaries) {
  if (loadedPackages === null) {
    return null;
  }
  const enabled = dictionaries.filter((dictionary) => dictionary.enabled !== false);
  const wanted = new Map(enabled.map((dictionary) => [dictionary.path, packageKinds(dictionary)]));
  const present = new Map(loadedPackages.map((entry) => [entry.path, entry.kinds]));
  try {
    for (const entry of loadedPackages) {
      if (wanted.get(entry.path) === entry.kinds && entry.indexPaged === indexPagedPaths.has(entry.path)) continue;
      if (!engine.ccall("hdw_remove_dict", "number", ["string"], [entry.path])) return null;
      present.delete(entry.path);
    }
    for (const dictionary of enabled) {
      if (present.has(dictionary.path)) continue;
      addDictionaries([dictionary], true);
      present.set(dictionary.path, packageKinds(dictionary));
    }
    if (!verifyDisabledPackagesInPlace(dictionaries)) return null;
    const order = JSON.stringify(enabled.map((dictionary) => dictionary.path));
    if (!engine.ccall("hdw_set_dict_order", "number", ["string"], [order])) return null;
  } catch (error) {
    if (!(error instanceof DictionaryLoadError)) throw error;
    return null;
  } finally {
    // Until the rebuild below or trackLoaded() describes it, the loaded set is
    // unknown; the fast path must not trust an interrupted step.
    loadedPackages = null;
  }
  trackLoaded(enabled, dictionaries);
  retainVerified(dictionaries);
  loadFailures = [];
  return enabled.reduce((count, dictionary) => count + kindsForPackage(dictionary).length, 0);
}

function loadDictionaries(dictionaries, { committed = [] } = {}) {
  for (const dictionary of dictionaries) {
    if (dictionaryRoot(dictionary) === null) {
      throw new Error(`refusing to load an invalid dictionary path: ${text(dictionary?.path)}`);
    }
  }
  indexPagedPaths = planIndexStorage(dictionaries, indexPolicy(), hashTableBytes, indexBudget() ?? 0);
  const incremental = loadDictionariesIncrementally(dictionaries);
  if (incremental !== null) {
    lastLoadPath = "incremental";
    return incremental;
  }
  lastLoadPath = "full";
  const tolerated = new Set(committed.map((dictionary) => text(dictionary?.path)));
  const failed = [];
  const skipped = new Set();
  const recordFailure = (error) => {
    if (!(error instanceof DictionaryLoadError) || !tolerated.has(error.dictionary.path)) {
      throw error;
    }
    skipped.add(error.dictionary.path);
    verifiedPackages.delete(error.dictionary.path);
    failed.push({
      id: optionalText(error.dictionary.id),
      title: text(error.dictionary.title),
      error: error.message,
    });
  };
  for (const dictionary of dictionaries) {
    if (dictionary.enabled !== false || isVerified(dictionary)) {
      continue;
    }
    resetEngine();
    try {
      addDictionaries([dictionary], true, { validation: true });
      verifiedPackages.set(dictionary.path, packageKinds(dictionary));
    } catch (error) {
      recordFailure(error);
    }
  }
  // An enabled package can fail after some of its kinds were added, so reload
  // without it rather than keep part of it.
  for (;;) {
    resetEngine();
    const candidates = dictionaries.filter((dictionary) => !skipped.has(dictionary.path));
    try {
      const loadedCount = addDictionaries(candidates, false);
      loadFailures = failed;
      trackLoaded(candidates.filter((dictionary) => dictionary.enabled !== false), dictionaries);
      retainVerified(dictionaries);
      return loadedCount;
    } catch (error) {
      recordFailure(error);
    }
  }
}

// The first hdw_lookup after the module starts runs 15-30x slower than the
// steady state (about 7 ms against 0.3-0.5 ms for Jitendex: V8 tiers the wasm
// up on first execution). Spend it here, still inside the serialised load, so a
// reader's first hover after a browser start or an import gets a warm engine.
// Best effort: the engine's failure fallback for a lookup is shape-valid.
const WARM_LOOKUP_TEXT = "食べました";

// The warm-up uses Japanese's sample when a Japanese profile exists, as
// today, and otherwise the first profile's (docs/languages.md 9.2).
function warmLookup() {
  const language = profileRecords && !recordLanguages.includes(JAPANESE_PROFILE_ID) ? recordLanguages[0] : undefined;
  const sample = language === undefined ? WARM_LOOKUP_TEXT
    : globalThis.HDLanguages?.get?.(language)?.host?.sample?.warmup;
  try {
    engine.ccall(
      "hdw_lookup",
      "string",
      ["string", "number", "number", "string"],
      language === undefined || typeof sample !== "string" ? [WARM_LOOKUP_TEXT, 1, 4, ""]
        : [sample, 1, 4, JSON.stringify({ language })],
    );
  } catch {
    // A failed warm-up only forfeits the speedup; the next lookup reports it.
  }
}

// Language packs (docs/languages.md 9.2). Japanese is built into the engine;
// others load from the extension's generated copy. The engine keeps its
// registry outside the object hdw_reset rebuilds, so a reload keeps them; a
// new engine instance starts with Japanese alone and loads the rest at its
// first reconciliation, before it publishes.
const loadedLanguages = new Set([JAPANESE_PROFILE_ID]);
// Packs that did not load, as hd_status reports them; their lookups fail.
let languageFailures = [];

async function fetchLanguageFile(code, name) {
  const response = await fetch(new URL(`./vendor/languages/${code}/${name}`, import.meta.url));
  if (!response.ok) throw new Error(`${code}/${name} could not be read (HTTP ${response.status})`);
  return response.text();
}

async function loadLanguagePack(code) {
  if (loadedLanguages.has(code)) return;
  if (!LANGUAGE_CODE.test(code)) throw new Error(`invalid language code ${JSON.stringify(code)}`);
  const languageJson = await fetchLanguageFile(code, "language.json");
  const transforms = parseJson(languageJson, `${code}/language.json`)?.lookup?.transforms;
  const transformsJson = typeof transforms === "string" && transforms !== "" ? await fetchLanguageFile(code, transforms) : "";
  if (engine.ccall("hdw_language_load", "number", ["string", "string"], [languageJson, transformsJson]) !== 1) {
    throw new Error(lastError());
  }
  loadedLanguages.add(code);
}

// Loads every pack of `codes` that is not loaded; the ones that fail are
// reported and the others keep working. A reconciliation passes every
// language of the records (`all`), which also forgets removed languages.
async function loadLanguagePacks(codes, { all = false } = {}) {
  const failures = [];
  for (const code of codes) {
    try {
      await loadLanguagePack(code); // NOSONAR: one engine call at a time
    } catch (error) {
      failures.push({ language: code, error: describeErrorMessageOrJson(error) });
    }
  }
  const attempted = new Set(codes);
  languageFailures = [...(all ? [] : languageFailures.filter(entry => !attempted.has(entry.language))), ...failures];
}

function publishLoadedDictionaries(loadedCount, { warm = true } = {}) {
  dictionaryCount = loadedCount;
  generation += 1;
  if (warm && loadedCount > 0) {
    warmLookup();
  }
}

async function restoreCommittedDictionaries(state = null, { publish = true } = {}) {
  const committed = state ?? (await requestDictionaryStorage()).state;
  if (committed === null) {
    throw new Error("the committed dictionary state is unavailable");
  }
  const loadedCount = reorderLoadedDictionaries(committed.dictionaries)
    ?? loadDictionaries(committed.dictionaries, { committed: committed.dictionaries });
  if (publish) publishLoadedDictionaries(loadedCount, { warm: lastLoadPath !== "order-only" });
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
    loadedPackages = null;
    verifiedPackages.clear();
    if (storageBackend === "idbfs") {
      speedUpMemfsGrowth();
      storeLargeIdbfsFilesAsBlobs();
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
      // Earlier versions staged the archive in OPFS; remove one left by an
      // interrupted import there.
      try {
        engine.FS.unlink(OPFS_IMPORT_ZIP);
      } catch {
        // No archive was left by an interrupted import.
      }
      // Backup files a closed browser left behind.
      await navigator.storage.getDirectory()
        .then(root => root.removeEntry(BACKUP_FILE_DIRECTORY, { recursive: true }))
        .catch(() => {});
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
    console.error(`hoshidicts: could not load the dictionaries at startup: ${describeErrorMessageOrJson(error)}`);
  }
}

// hd_apply_state once the records have profiles (docs/languages.md 5.2): the
// profile's schema-1 view is merged into the whole record before anything
// loads, so the loaded set stays the union of every profile's. Settings names
// the profile it edits; a view that names none is an older client's and
// means the Japanese profile. Null when the records turn out to have no
// profiles, for the single-profile path.
async function applyProfileState(message) {
  const snapshot = await requestDictionaryStorage();
  const stored = snapshot.state?.stored;
  if (!stored) {
    if (message.profileId !== undefined && message.profileId !== JAPANESE_PROFILE_ID) {
      throw profileRequestError(profileMessages().profileRemoved, "profile-missing");
    }
    return null;
  }
  if (snapshot.state.revision !== message.baseRevision) {
    return { ok: false, conflict: true, error: "the dictionary state changed while it was being written", state: stored };
  }
  const profileId = message.profileId ?? JAPANESE_PROFILE_ID;
  if (!stored.profiles[profileId]) {
    throw message.profileId === undefined
      ? profileRequestError(profileMessages().noJapaneseProfile, "no-japanese-profile")
      : profileRequestError(profileMessages().profileRemoved, "profile-missing");
  }
  const next = profileState.mergeDictionaryView(stored, profileId,
    { dictionaries: message.dictionaries, groups: message.groups }, { legacy: message.profileId === undefined });
  const union = globalThis.HDReaderOptions.allPackages(next);
  let restorationAttempted = false;
  try {
    const loadedCount = reorderLoadedDictionaries(union) ?? loadDictionaries(union, { committed: snapshot.state.dictionaries });
    const loadPath = lastLoadPath;
    const reply = await commitProfileDictionaryState(message.baseRevision, next);
    if (reply.ok === true) {
      publishLoadedDictionaries(loadedCount, { warm: loadPath !== "order-only" });
      reloadError = null;
      return { state: publicState(reply.state), loadPath };
    }
    if (reply.conflict !== true || reply.state === null) {
      throw new Error(reply.error || "the dictionary state could not be saved");
    }
    restorationAttempted = true;
    await restoreCommittedDictionaries(reply.state);
    return { ok: false, conflict: true, error: reply.error || "the dictionary state changed while it was being written",
      state: publicState(reply.state) };
  } catch (error) {
    if (restorationAttempted) {
      reloadError = asError(error);
      throw error;
    }
    try {
      await restoreCommittedDictionaries();
    } catch (restoreError) {
      reloadError = asError(restoreError);
    }
    throw error;
  }
}

function profileMessages() {
  return globalThis.HDReaderOptions.PROFILE_MESSAGES;
}

function profileRequestError(text, code) {
  const error = new Error(text);
  error.errorCode = code;
  return error;
}

// After a lost hd_profile_cas reply, the records it would have written are
// read back (docs/languages.md 5.2): the committed state is the expected one,
// or its single-profile conversion, at the next revision; the options hold
// the languages they should, as the read reports them; an erased language's
// personal document is empty one revision up, or gone with the `languages`
// entries when the erase converted the records back. The counts and marks of
// an erase are written in the same storage write as these.
async function profileCasReadback(commitError, baseRevision, next, wantsLanguages, erased = null) {
  let snapshot;
  let document = null;
  try {
    snapshot = await requestDictionaryStorage();
    if (erased !== null) ({ document } = await readCustomStorage(erased.language));
  } catch (readError) {
    throw new UnknownDictionaryStateCommitError(commitError, readError, "language change");
  }
  const committed = publicState(snapshot.state);
  const expected = { ...next, revision: baseRevision + 1 };
  const matches = committed?.revision === baseRevision + 1
    && (hasDictionaryProfiles(committed)
      ? sameJsonValue(committed.dictionaries, expected.dictionaries) && sameJsonValue(committed.profiles, expected.profiles)
        && wantsLanguages(recordLanguages)
      : sameJsonValue(committed, profileState.dictionaryStateWithoutProfiles(expected)))
    && (erased === null || (document.text === "" && (document.revision === erased.documentRevision + 1
      || (!hasDictionaryProfiles(committed) && document.revision === 0))));
  if (matches) {
    return { ok: true, state: committed, converted: !profileRecords, ...(profileRecords ? { languages: recordLanguages } : {}) };
  }
  return { ok: false, conflict: (committed?.revision ?? 0) !== baseRevision, error: describeErrorMessageOrJson(commitError),
    state: committed };
}

// Adding a language (docs/languages.md 5.2, 6.3 and 16.3). Under the
// mutation lock the engine loads the pack and strict-loads every package that
// enters the loaded set (a re-added language's personal package); the
// worker's hd_profile_cas writes options and dictionaryState together; then
// the engine publishes. Nothing is compiled.
async function addProfile(message) {
  requireEngine();
  const language = addedLanguage(message);
  try {
    await loadLanguagePack(language);
  } catch (error) {
    throw new Error(`${languageName(language)} could not be loaded. ${describeErrorMessageOrJson(error)}`);
  }
  for (let attempt = 0; ; attempt += 1) {
    const snapshot = await requestDictionaryStorage();
    const plan = addedProfileState(snapshot, language);
    const { loadedCount, reply } = await commitAddedProfile(snapshot, plan, language, message);
    if (reply.ok === true) {
      adoptProfileRecords(reply);
      if (plan.entering) publishLoadedDictionaries(loadedCount);
      reloadError = null;
      return { state: publicState(reply.state), languages: recordLanguages };
    }
    if (plan.entering) await restoreCommittedDictionaries(reply.state ? engineState(reply.state) : null);
    if (reply.conflict !== true || attempt + 1 >= STORAGE_ATTEMPTS) return profileFailure(reply, "the language could not be added");
  }
}

function addedLanguage(message) {
  const language = text(message.language);
  if (!LANGUAGE_CODE.test(language)) throw new TypeError("the language request named no language");
  if (message.copyFrom !== undefined && typeof message.copyFrom !== "string") {
    throw new TypeError("the language request named an invalid profile to copy");
  }
  return language;
}

// The records an added language leaves: its profile, holding its personal
// package when the library has one, and whether a package enters the set.
function addedProfileState(snapshot, language) {
  const stored = snapshot.state?.stored ?? withTargetLanguages(profileState.dictionaryStateWithProfiles(snapshot.state));
  const personal = personalDictionaryIdentity(language);
  const own = personal !== null && stored.dictionaries.some((row) => row.id === personal.id)
    ? [{ id: personal.id, enabled: true }] : [];
  const profiles = { ...stored.profiles, [language]: { dictionaries: own, groups: [] } };
  const next = { schemaVersion: DICTIONARY_STATE_PROFILES_SCHEMA, revision: stored.revision, dictionaries: stored.dictionaries, profiles };
  const union = globalThis.HDReaderOptions.allPackages(next);
  const before = new Set((snapshot.state?.dictionaries ?? []).filter((row) => row.enabled !== false).map((row) => row.path));
  return { next, union, personal, baseRevision: snapshot.state?.revision ?? 0,
    entering: union.some((row) => row.enabled !== false && !before.has(row.path)) };
}

// Loads the packages that enter the set, then commits. A failure restores
// the committed set.
async function commitAddedProfile(snapshot, plan, language, message) {
  let loadedCount = dictionaryCount;
  try {
    if (plan.entering) {
      loadedCount = loadDictionaries(plan.union, {
        committed: (snapshot.state?.dictionaries ?? []).filter((row) => row.enabled !== false || row.id !== plan.personal?.id),
      });
    }
    return { loadedCount, reply: await askProfileAdd(plan, language, message) };
  } catch (error) {
    if (plan.entering) await restoreAfterFailedLoad();
    throw error;
  }
}

async function askProfileAdd(plan, language, message) {
  try {
    return await ask("hd_profile_cas", { action: "add", language, copyFrom: message.copyFrom,
      baseRevision: plan.baseRevision,
      state: { dictionaries: plan.next.dictionaries, profiles: plan.next.profiles } });
  } catch (commitError) {
    return profileCasReadback(commitError, plan.baseRevision, plan.next, (languages) => languages.includes(language));
  }
}

async function restoreAfterFailedLoad() {
  try {
    await restoreCommittedDictionaries();
  } catch (restoreError) {
    reloadError = asError(restoreError);
  }
}

// What a committed language change leaves: whether the records have
// profiles, and their languages (docs/languages.md 5.2).
function adoptProfileRecords(reply) {
  profileRecords = reply.converted !== true;
  recordLanguages = Array.isArray(reply.languages) ? reply.languages : [];
  setDebugLogLanguages(recordLanguages);
}

function profileFailure(reply, fallback) {
  return { ok: false, conflict: reply.conflict === true, error: reply.error || fallback, state: publicState(reply.state ?? null) };
}

// Removing a language, or erasing a held language (docs/languages.md 5.2
// and 16.5): the profile's settings and list go, its packages stay in the
// library, and the engine unloads what left the set once the commit is in.
// With `erase` the same commit empties the language's personal source and
// removes its package, counts and marks. Version 1 gives a profile its
// language's code as id (section 2).
async function removeProfile(message) {
  requireEngine();
  const request = removedLanguage(message);
  for (let attempt = 0; ; attempt += 1) {
    const stored = await storedForRemoval(request);
    const next = removedProfileState(stored, request);
    const confirmation = await eraseConfirmation(request);
    if (confirmation.stale) return changedAfterConfirmation(confirmation.document);
    const reply = await askProfileRemove(request, stored, next, confirmation.revision);
    const outcome = removalOutcome(reply, request, attempt);
    if (outcome !== null) return outcome;
  }
}

async function storedForRemoval(request) {
  const stored = (await requestDictionaryStorage()).state?.stored;
  if (!stored) throw new Error("The last language cannot be removed.");
  if (request.profileId !== undefined && !stored.profiles[request.profileId]) {
    throw profileRequestError(profileMessages().profileRemoved, "profile-missing");
  }
  return stored;
}

// An erase removes the personal source its confirmation read; a newer one
// is kept and the removal stops.
async function eraseConfirmation(request) {
  if (!request.erase) return { stale: false, revision: undefined };
  const { document } = await readCustomStorage(request.language);
  return document.revision === request.confirmed
    ? { stale: false, revision: document.revision } : { stale: true, document };
}

// The removal's reply, or null to try again after a storage conflict.
function removalOutcome(reply, request, attempt) {
  if (reply.ok === true) return adoptRemovedProfile(reply, request.erase);
  if (reply.stale === true) return { ...changedAfterConfirmation(reply.document), state: publicState(reply.state ?? null) };
  if (reply.conflict !== true || attempt + 1 >= STORAGE_ATTEMPTS) return profileFailure(reply, "the language could not be removed");
  return null;
}

function removedLanguage(message) {
  const erase = message.erase === true;
  const profileId = message.profileId;
  if (profileId !== undefined && (typeof profileId !== "string" || profileId === "")) {
    throw new TypeError("the language request named an invalid profile");
  }
  const language = profileId ?? text(message.language);
  if (!LANGUAGE_CODE.test(language) || (profileId === undefined && !erase)) {
    throw new TypeError("the language request named no language");
  }
  // An erase carries the document revision its confirmation read; a newer
  // document is kept (docs/languages.md 5.2), as today's erase keeps it.
  const confirmed = message.baseDocumentRevision;
  if (erase && (!Number.isInteger(confirmed) || confirmed < 0)) {
    throw new TypeError("the erase carried no valid document revision");
  }
  return { erase, profileId, language, confirmed };
}

function changedAfterConfirmation(document) {
  return { ok: false, stale: true, document,
    error: "The personal dictionary changed after you confirmed, so it was kept. Review it and try again." };
}

// The records a removal leaves: without the profile, and with an erase
// without the language's personal package.
function removedProfileState(stored, { erase, profileId, language }) {
  const personal = personalDictionaryIdentity(language);
  const dictionaries = erase ? stored.dictionaries.filter((row) => row.id !== personal?.id) : stored.dictionaries;
  const kept = new Set(dictionaries.map((row) => row.id));
  const profiles = Object.fromEntries(Object.entries(stored.profiles).filter(([id]) => id !== profileId)
    .map(([id, profile]) => [id, { ...profile, dictionaries: profile.dictionaries.filter((entry) => kept.has(entry.id)) }]));
  return { schemaVersion: DICTIONARY_STATE_PROFILES_SCHEMA, revision: stored.revision, dictionaries, profiles };
}

async function askProfileRemove({ erase, profileId, language }, stored, next, baseDocumentRevision) {
  try {
    return await ask("hd_profile_cas", { action: "remove", language, ...(profileId === undefined ? {} : { profileId }),
      erase, baseRevision: stored.revision, ...(erase ? { baseDocumentRevision } : {}),
      state: { dictionaries: next.dictionaries, profiles: next.profiles } });
  } catch (commitError) {
    return profileCasReadback(commitError, stored.revision, next,
      (languages) => profileId === undefined || !languages.includes(language),
      erase ? { language, documentRevision: baseDocumentRevision } : null);
  }
}

// Once a removal commits, the engine loads the committed set.
async function adoptRemovedProfile(reply, erase) {
  adoptProfileRecords(reply);
  const committed = engineState(reply.state);
  try {
    publishLoadedDictionaries(loadDictionaries(committed.dictionaries, { committed: committed.dictionaries }));
    reloadError = null;
  } catch (error) {
    reloadError = asError(error);
    throw error;
  }
  if (erase) await cleanupCommittedDictionaries();
  return { state: publicState(reply.state), ...(profileRecords ? { languages: recordLanguages } : {}) };
}

// Every count an import report carries. The last four are what a successful
// MDX import left out; a Yomitan archive reports them as 0. Settings words
// them (mdxImportNotes); they are not stored with the dictionary.
const IMPORT_REPORT_COUNTS = Object.freeze([
  "termCount",
  "metaCount",
  "frequencyCount",
  "pitchCount",
  "kanjiCount",
  "mediaCount",
  "skippedRecordCount",
  "unresolvedRedirectCount",
  "missingResourceCount",
  "unreadableResourceCount",
]);

function emptyReport(error) {
  const report = { success: false, title: "" };
  for (const key of IMPORT_REPORT_COUNTS) report[key] = 0;
  report.error = error;
  return report;
}

function normaliseReport(raw) {
  const report = emptyReport(text(raw?.error));
  report.success = raw?.success === true;
  report.title = text(raw?.title);
  for (const key of IMPORT_REPORT_COUNTS) {
    const count = Number(raw?.[key]);
    report[key] = Number.isFinite(count) ? count : 0;
  }
  return report;
}

// `inPlace`: the list is a schema-2 union view, where every personal package
// keeps its place in installation order and each profile pins its own first.
function withCustomDictionary(stored, generated, identity = JAPANESE_CUSTOM.identity, inPlace = false) {
  const current = stored.find((dictionary) => dictionary?.id === identity.id);
  if (stored.some((dictionary) =>
    dictionary?.id !== identity.id
      && text(dictionary?.title) === identity.title)) {
    throw new Error(`a dictionary named ${identity.title} is already installed`);
  }
  const custom = {
    ...generated,
    id: identity.id,
    title: identity.title,
    displayName: typeof current?.displayName === "string" ? current.displayName : null,
    enabled: true,
    favorite: current?.favorite === true,
    isUpdatable: false,
    indexUrl: null,
    downloadUrl: null,
    lastUpdateCheck: null,
  };
  if (inPlace && current !== undefined) return stored.map((dictionary) => dictionary?.id === identity.id ? custom : dictionary);
  return [custom, ...stored.filter((dictionary) => dictionary?.id !== identity.id)];
}

async function customPackageSatisfies(state, semanticRevision, entryCount, identity = JAPANESE_CUSTOM.identity) {
  const inPlace = Boolean(state?.stored);
  const custom = inPlace ? state.dictionaries.find((dictionary) => dictionary?.id === identity.id) : state?.dictionaries?.[0];
  if (custom?.id !== identity.id
      || custom?.title !== identity.title
      || custom?.enabled !== true
      || custom?.revision !== semanticRevision
      || custom?.termCount !== entryCount
      || !isGenerationRoot(dictionaryRoot(custom) ?? "")) {
    return false;
  }
  try {
    const generated = await packageFromIndex(custom.path);
    if (!customDictionaryMetadataMatches(generated, semanticRevision, entryCount, identity)
        || !sameDictionaries(
          state.dictionaries,
          withCustomDictionary(state.dictionaries, generated, identity, inPlace),
        )) {
      return false;
    }
    loadDictionaries(state.dictionaries, {
      committed: state.dictionaries.filter((dictionary) => dictionary?.id !== identity.id),
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
  if (existingIndex < 0) {
    existingIndex = stored.findIndex((dictionary) =>
      dictionary?.id === generated.id || text(dictionary?.title) === generated.title);
  }
  return existingIndex;
}

function withImport(stored, generated, recommendedSource, managedSource) {
  if (isPersonalDictionaryTitle(generated.title)) {
    throw new Error(`${generated.title} is reserved for the managed custom dictionary`);
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

function sameImportedIdentity(left, right) {
  return left.title === right.title
    && left.revision === right.revision
    && left.indexUrl === right.indexUrl
    && left.downloadUrl === right.downloadUrl;
}

function interactiveTargetIndex(stored, decision) {
  const existingIndex = stored.findIndex(dictionary => dictionary?.id === decision.target.id);
  const existing = stored[existingIndex];
  if (existingIndex < 0
      || !sameJsonValue(dictionaryImportTarget(existing), decision.target)) {
    throw new Error("the chosen dictionary changed while the archive was being imported");
  }
  if (decision.matchKind === "title") {
    if (existing.title !== decision.identity.title) {
      throw new Error("the chosen dictionary no longer matches the imported title");
    }
  } else {
    if (decision.identity.indexUrl === null
        || optionalText(existing.indexUrl) !== decision.identity.indexUrl
        || stored.some(dictionary => dictionary?.title === decision.identity.title)) {
      throw new Error("the chosen dictionary no longer matches the imported source");
    }
  }
  return existingIndex;
}

function storedImportIdentityIndex(stored, identity) {
  const titleIndex = stored.findIndex(dictionary => dictionary?.title === identity.title);
  if (titleIndex >= 0 || identity.indexUrl === null) return titleIndex;
  return stored.findIndex(dictionary => optionalText(dictionary?.indexUrl) === identity.indexUrl);
}

function withInteractiveReplacement(stored, generated, existingIndex) {
  const current = stored[existingIndex];
  const collision = stored.some((dictionary, index) =>
    index !== existingIndex
      && (dictionary?.id === current.id || dictionary?.title === generated.title));
  if (collision) {
    throw new Error(`a dictionary named ${generated.title} is already installed`);
  }
  const replacement = {
    ...withStoredPresentation(generated, current),
    // A local archive cannot acquire or redirect update ownership while
    // replacing a package. Keep the target's source contract verbatim.
    isUpdatable: current?.isUpdatable === true,
    indexUrl: optionalText(current?.indexUrl),
    downloadUrl: optionalText(current?.downloadUrl),
    lastUpdateCheck: null,
  };
  if (current?.sourceId === undefined) delete replacement.sourceId;
  const next = [...stored];
  next[existingIndex] = replacement;
  return next;
}

async function separateDictionaryTitle(title, stored) {
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${title} (${suffix})`;
    if (!usableDictionaryTitle(candidate)
        || stored.some(dictionary => dictionary?.title === candidate)) {
      continue;
    }
    const id = await stableDictionaryId(candidate);
    if (!stored.some(dictionary => dictionary?.id === id)) return candidate;
  }
}

function retitleImportedPackage(generationRoot, currentTitle, nextTitle) {
  if (currentTitle === nextTitle) return;
  if (!usableDictionaryTitle(nextTitle)) {
    throw new Error("the separate dictionary title cannot be used as a filesystem path");
  }
  const currentPath = `${generationRoot}/${dictionaryFolderName(currentTitle)}`;
  const nextPath = `${generationRoot}/${dictionaryFolderName(nextTitle)}`;
  if (!exists(currentPath) || exists(nextPath)) {
    throw new Error("the staged dictionary title changed unexpectedly");
  }
  const index = readDictionaryIndex(currentPath);
  if (index?.title !== currentTitle) {
    throw new Error("the staged dictionary index does not match its directory");
  }
  moveDictionaryFiles(currentPath, nextPath, true);
  index.title = nextTitle;
  writeDictionaryIndex(nextPath, index);
}

async function cleanupCommittedDictionaries() {
  try {
    const { state } = await requestDictionaryStorage();
    if (state === null) {
      return;
    }
    const retained = await ask("hd_backup_auto_roots");
    if (!retained.ok) throw new Error(retained.error || "Could not read automatic backup roots.");
    if (retained.complete !== true) {
      console.warn("hoshidicts: automatic backup metadata is corrupt; retaining unreferenced dictionary generations");
      return;
    }
    if (!Array.isArray(retained.dictionaries)) {
      throw new TypeError("The automatic backup root list is invalid.");
    }
    await cleanupUnreferencedDictionaries([
      ...state.dictionaries,
      ...retained.dictionaries,
      ...(preparedBackup?.dictionaries ?? []),
    ]);
  } catch (error) {
    console.warn(`hoshidicts: could not remove unreferenced dictionaries: ${describeErrorMessageOrJson(error)}`);
  }
}

// `request` is the prepared import request; `target` names the profile the
// package joins, and whether it joins even when it was installed already.
async function commitImportedGeneration(generationRoot, report, request, target) {
  const { recommendedSource, managedSource, expectedRevision, importDecision } = request;
  const { profileId, joins: joinsProfile } = target;
  let generated = await packageFromIndex(`${generationRoot}/${dictionaryFolderName(report.title)}`);
  if (generated.title !== report.title) {
    throw new Error("the imported dictionary title changed while it was being committed");
  }
  const importedIdentity = importedIdentityFromIndex(generated.path);
  if (importDecision !== null
      && !sameImportedIdentity(importedIdentity, importDecision.identity)) {
    throw new Error("the imported dictionary metadata did not match the reviewed archive");
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
  if (isPersonalDictionaryTitle(generated.title)) {
    throw new Error(`${generated.title} is reserved for the managed custom dictionary`);
  }
  let candidateTitle = generated.title;
  const committed = await commitDictionaryCandidate(async (snapshot) => {
    const stored = snapshot.state?.dictionaries ?? [];
    if (importDecision === null) {
      return withImport(stored, generated, recommendedSource, managedSource);
    }
    if (importDecision.action === "install") {
      if (storedImportIdentityIndex(stored, importDecision.identity) >= 0) {
        throw new Error("the dictionary library changed; review this import again");
      }
      return [...stored, generated];
    }
    const existingIndex = interactiveTargetIndex(stored, importDecision);
    if (importDecision.action === "replace") {
      return withInteractiveReplacement(stored, generated, existingIndex);
    }
    const nextTitle = await separateDictionaryTitle(importDecision.identity.title, stored);
    if (candidateTitle !== nextTitle) {
      retitleImportedPackage(generationRoot, candidateTitle, nextTitle);
      candidateTitle = nextTitle;
      await persistFilesystem();
      generated = await packageFromIndex(`${generationRoot}/${dictionaryFolderName(candidateTitle)}`);
    }
    return [...stored, generated];
  }, { profileId, joining: joinsProfile ? () => generated.path : null });
  report.title = generated.title;
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
      console.warn(`hoshidicts: could not discard failed dictionary generations: ${describeErrorMessageOrJson(error)}`);
    }
  }
  if (restoreError !== null) {
    throw new Error(`${describeErrorMessageOrJson(failure)}; dictionary rollback failed: ${describeErrorMessageOrJson(restoreError)}`);
  }
}

function rollbackImportedGeneration(generationRoot, failure) {
  return rollbackImportedGenerations([generationRoot], failure);
}

// The engine matches a term bank `path` to a ZIP entry name byte for byte.
// Archives built on macOS store decomposed (NFD) Japanese names while the
// term bank keeps the composed (NFC) form, and some converters percent-encode
// the path; in both cases the same file is meant. Try the spelled path first,
// then those equivalents. Names in another byte encoding cannot be recovered
// here.
function mediaPathCandidates(path) {
  const candidates = [path];
  let decoded = path;
  if (path.includes("%")) {
    try {
      decoded = decodeURIComponent(path);
      candidates.push(decoded);
    } catch {
      // Not percent-encoded; keep the raw path only.
    }
  }
  for (const source of new Set([path, decoded])) {
    candidates.push(source.normalize("NFC"), source.normalize("NFD"));
  }
  return [...new Set(candidates)];
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

async function consumeResponse(response, consume, onProgress = null) {
  const reader = response.body?.getReader?.();
  const totalBytes = declaredResponseLength(response);
  const report = (receivedBytes) => {
    onProgress?.({ phase: "downloading", receivedBytes, totalBytes: totalBytes !== null && receivedBytes <= totalBytes ? totalBytes : null });
  };
  if (reader === undefined) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    consume(bytes);
    report(bytes.byteLength);
    return bytes.byteLength;
  }

  let received = 0;
  let reportedAt = -Infinity;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      if (bytes.byteLength === 0) continue;
      consume(bytes);
      received += bytes.byteLength;
      if (onProgress !== null && performance.now() - reportedAt >= PROGRESS_INTERVAL_MS) {
        reportedAt = performance.now();
        report(received);
      }
    }
  } finally {
    reader.releaseLock?.();
  }
  report(received);
  return received;
}

const PROT_READ_WRITE = 0x1 | 0x2;
const MAP_SHARED = 0x01;

function stagingMemoryError(bytes) {
  return Object.assign(new Error(`Could not allocate ${bytes} bytes to stage the archive.`), { errorCode: "import-memory" });
}

function mappedFileHeap(module, path, mapping, bytes) {
  // WasmFS can return an unsigned -ENOMEM pointer. It must never reach a
  // typed-array copy or munmap. Glue refreshes views after memory growth.
  if (!Number.isSafeInteger(mapping?.ptr) || mapping.ptr <= 0 || mapping.ptr + bytes > 0x100000000) {
    throw stagingMemoryError(bytes);
  }
  let heap = module.HEAPU8;
  if (heap.byteLength < mapping.ptr + bytes) {
    nativeImportCall(module, () => module.FS.stat(path));
    heap = module.HEAPU8;
  }
  if (mapping.ptr + bytes > heap.byteLength) throw stagingMemoryError(bytes);
  return heap;
}

function finishFileWrite(operation, failure) {
  try { operation(); }
  catch (error) { if (failure === null) throw error; }
}

function writeMappedFile(module, stream, path, data) {
  const { FS } = module;
  const call = (operation) => nativeImportCall(module, operation);
  call(() => FS.ftruncate(stream.fd, data.byteLength));
  const mapping = call(() => FS.mmap(stream, data.byteLength, 0, PROT_READ_WRITE, MAP_SHARED));
  const heap = mappedFileHeap(module, path, mapping, data.byteLength);
  let failure = null;
  try {
    heap.set(data, mapping.ptr);
    call(() => FS.msync(stream, mapping.ptr, 0, data.byteLength, MAP_SHARED));
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    finishFileWrite(() => call(() => FS.munmap(mapping.ptr, data.byteLength)), failure);
  }
}

// Writes one buffer as the whole file of `module`'s filesystem. WasmFS's
// FS.write copies from JavaScript
// one byte at a time (about 25 ns per byte: a full second for the 39 MiB
// Jitendex archive), and its FS.writeFile on the OPFS backend appends to an
// existing file and leaves it undeletable until the next start. A shared
// writable mapping gives a single typed-array copy and one write-back through
// the OPFS proxy. The legacy FS (single-thread IDBFS build) has no munmap and
// its FS.write is already a typed-array copy, so it takes the direct path.
function writeFileBytes(module, path, data) {
  const { FS } = module;
  const call = (operation) => nativeImportCall(module, operation);
  const stream = call(() => FS.open(path, "w+"));
  let failure = null;
  try {
    if (data.byteLength === 0 || typeof FS.mmap !== "function" || typeof FS.munmap !== "function") {
      for (let offset = 0; offset < data.byteLength;) {
        const written = call(() => FS.write(stream, data, offset, data.byteLength - offset));
        if (!(written > 0)) {
          throw new Error(`could not write ${path}`);
        }
        offset += written;
      }
      return;
    }
    writeMappedFile(module, stream, path, data);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    finishFileWrite(() => call(() => FS.close(stream)), failure);
  }
}

// The stream is collected and written once; the importer maps the whole file
// into the heap anyway, so holding the bytes in JavaScript until the stream ends
// does not change the largest archive that can be imported.
function concatenateParts(parts, byteLength) {
  if (parts.length === 1) {
    return parts[0];
  }
  const data = new Uint8Array(byteLength);
  let offset = 0;
  for (const part of parts) {
    data.set(part, offset);
    offset += part.byteLength;
  }
  parts.length = 0;
  return data;
}

async function collectResponse(response, onProgress = null) {
  const parts = [];
  let byteLength = 0;
  await consumeResponse(
    response,
    (bytes) => {
      parts.push(bytes);
      byteLength += bytes.byteLength;
    },
    onProgress,
  );
  return { bytes: concatenateParts(parts, byteLength), byteLength };
}

// `source` is a Response, or bytes already collected by stageImportArchive.
export async function streamResponseToFile(module, source, path, onProgress = null) {
  if (source instanceof Uint8Array) {
    writeFileBytes(module, path, source);
    return source.byteLength;
  }
  const { bytes, byteLength } = await collectResponse(source, onProgress);
  writeFileBytes(module, path, bytes);
  return byteLength;
}

// The archive is collected into one buffer outside the engine's serialised
// section and handed to the import as-is. Staging it as a Blob instead cost
// three more copies of the archive (chunk slices, the Blob, and reading the
// Blob back) for about 70 ms on a Jitendex import, and the concatenated buffer
// exists on the import path either way.
export async function stageImportArchive(response, onProgress = null) {
  return collectResponse(response, onProgress);
}

function removeStagedFile(module, path) {
  try {
    nativeImportCall(module, () => module.FS.unlink(path));
  } catch {
    // Never written, or already gone.
  }
}

// Where the archive is staged. A Yomitan ZIP has a fixed scratch name; an MDX
// keeps its own name inside IMPORT_MDX_DIR with its MDD files beside it.
function importStagingPaths(fileName, resources, diskRoot = null) {
  if (resources.length === 0 && !isMdxFileName(fileName)) {
    return { directory: diskRoot, archivePath: diskRoot === null ? IMPORT_ZIP : `${diskRoot}/.hdw-archive.zip`, resourcePaths: [] };
  }
  const directory = diskRoot === null ? IMPORT_MDX_DIR : `${diskRoot}/.hdw-mdx`;
  return {
    directory,
    archivePath: `${directory}/${fileName}`,
    resourcePaths: resources.map((resource) => `${directory}/${resource.fileName}`),
  };
}

// The generated index keeps the archive's frequencyMode, except that a list
// declaring occurrence counts whose values are ranks is stored as rank-based
// (#684), so its averages and Auto direction treat it as one.
async function correctRankFrequencyMode(module, archivePath, path) {
  const index = nativeImportCall(module, () => readDictionaryIndex(path, module.FS));
  if (index?.frequencyMode !== "occurrence-based") return;
  if (!await archiveHoldsRanks(nativeImportCall(module, () => module.FS.readFile(archivePath)))) return;
  nativeImportCall(module, () => writeDictionaryIndex(path, { ...index, frequencyMode: "rank-based" }, module.FS));
}

// Stages the archive in `module`'s scratch filesystem and runs its native
// importer into `generationRoot`. Shared with the isolated import worker, whose
// module is a second engine instance on the same OPFS root.
export async function importDictionaryArchive(
  module,
  archiveSource,
  generationRoot,
  importLowRam,
  fileName,
  expectedArchiveBytes = null,
  { resources = [], backend = "memory" } = {},
) {
  const { FS } = module;
  const diskRoot = importLowRam && backend === "opfs" ? generationRoot : null;
  const { directory, archivePath, resourcePaths } = importStagingPaths(fileName, resources, diskRoot);
  let phase = "staging the archive";
  try {
    if (directory !== null) {
      nativeImportCall(module, () => FS.mkdirTree(directory));
    }
    const archiveBytes = await streamResponseToFile(module, archiveSource, archivePath);
    if (archiveBytes === 0) {
      throw new Error(`${fileName} is empty`);
    }
    if (expectedArchiveBytes !== null && archiveBytes !== expectedArchiveBytes) {
      throw new Error(`${fileName} changed while it was staged`);
    }
    resources.forEach((resource, index) => {
      phase = `staging ${resource.fileName}`;
      writeFileBytes(module, resourcePaths[index], resource.bytes);
    });
    phase = "compiling dictionary banks";
    const report = normaliseReport(
      parseJson(
        nativeImportCall(module, () => module.ccall(
          "hdw_import",
          "string",
          ["string", "string", "number"],
          [archivePath, generationRoot, importLowRam ? 1 : 0],
        )),
        "hdw_import",
      ),
    );
    if (report.success && report.title === "") {
      // hdw_import refuses an empty title, so this is unreachable; without a
      // title there is nothing to register, and a row with an empty title
      // would poison reconcile().
      report.success = false;
      report.error = `${fileName} declares no dictionary title`;
    }
    if (!report.success) {
      report.error = dictionaryImportError(report.error || "The engine returned no import error.", fileName, phase).message;
    } else {
      phase = "checking the frequency mode";
      await correctRankFrequencyMode(module, archivePath, `${generationRoot}/${dictionaryFolderName(report.title)}`);
    }
    return report;
  } catch (error) {
    throw dictionaryImportError(error, fileName, phase);
  } finally {
    removeStagedFile(module, archivePath);
    for (const path of resourcePaths) removeStagedFile(module, path);
    if (directory !== null) {
      try {
        nativeImportCall(module, () => FS.rmdir(directory));
      } catch {
        // Never created, or already gone.
      }
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

function plainFileName(value) {
  return typeof value === "string" && value !== "" && value !== "." && value !== ".."
    && !/[/\\\0]/u.test(value);
}

function isMdxFileName(fileName) {
  return /\.mdx$/iu.test(fileName);
}

// The MDD resource files chosen with an .mdx: staged next to it under their own
// names so the engine's sibling discovery (`<stem>.mdd`, `<stem>.1.mdd`, ...)
// sees them. Only an ordinary local import of an .mdx can carry them.
function importResources(message, remote, fileName) {
  const value = message.resources;
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new TypeError("the import request carried an invalid resource list");
  }
  if (value.length === 0) return [];
  if (remote || !isMdxFileName(fileName)) {
    throw new Error("only a local .mdx import can carry resource files");
  }
  const names = new Set([fileName]);
  return value.map((resource) => {
    const name = resource?.fileName;
    const blobUrl = text(resource?.blobUrl);
    if (!plainFileName(name) || !/\.mdd$/iu.test(name) || blobUrl === "") {
      throw new Error("the import request carried an invalid resource file");
    }
    if (names.has(name)) {
      throw new Error(`the import request lists ${name} twice`);
    }
    names.add(name);
    return { fileName: name, blobUrl };
  });
}

function exactNullableString(value, label, { empty = false } = {}) {
  if (value === null) return null;
  if (typeof value !== "string" || (!empty && value === "")) {
    throw new Error(`the import decision carried an invalid ${label}`);
  }
  return value;
}

function exactRequiredString(value, label) {
  if (typeof value !== "string" || value === "") {
    throw new Error(`the import decision carried an invalid ${label}`);
  }
  return value;
}

function importDecisionIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("the import decision carried no archive identity");
  }
  return {
    title: exactRequiredString(value.title, "dictionary title"),
    revision: exactNullableString(value.revision, "dictionary revision", { empty: true }),
    indexUrl: exactNullableString(value.indexUrl, "dictionary index URL"),
    downloadUrl: exactNullableString(value.downloadUrl, "dictionary download URL"),
  };
}

function importDecisionTarget(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || typeof value.id !== "string" || value.id === ""
      || typeof value.title !== "string" || value.title === ""
      || typeof value.path !== "string" || value.path === ""
      || typeof value.revision !== "string"
      || !["string", "object"].includes(typeof value.sourceId)
      || !["string", "object"].includes(typeof value.indexUrl)
      || !["string", "object"].includes(typeof value.downloadUrl)
      || typeof value.isUpdatable !== "boolean") {
    throw new Error("the import decision carried an invalid replacement target");
  }
  return {
    ...dictionaryImportTarget(value),
    sourceId: exactNullableString(value.sourceId, "target source ID"),
    indexUrl: exactNullableString(value.indexUrl, "target index URL"),
    downloadUrl: exactNullableString(value.downloadUrl, "target download URL"),
  };
}

function interactiveImportDecision(value, remote, managedSource, recommendedSource) {
  if (value === undefined) return null;
  if (remote || managedSource !== null || recommendedSource !== null) {
    throw new Error("only an ordinary local import can carry an interactive decision");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)
      || !["install", "replace", "separate"].includes(value.action)) {
    throw new Error("the import decision carried an invalid action");
  }
  const identity = importDecisionIdentity(value.identity);
  if (value.action === "install") {
    if (value.target !== null || value.matchKind !== null) {
      throw new Error("a new import decision cannot name a replacement target");
    }
    return { action: value.action, identity, target: null, matchKind: null };
  }
  if (!["title", "source"].includes(value.matchKind)) {
    throw new Error("the import decision carried an invalid target match");
  }
  return {
    action: value.action,
    identity,
    target: importDecisionTarget(value.target),
    matchKind: value.matchKind,
  };
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
  const importDecision = interactiveImportDecision(
    message.importDecision,
    remote,
    managedSource,
    recommendedSource,
  );
  const fileName = text(message.fileName) || recommendedSource?.archiveName || "the archive";
  return {
    archiveUrl,
    expectedRevision,
    fileName,
    importDecision,
    importLowRam,
    managedSource,
    recommendedSource,
    remote,
    resources: importResources(message, remote, fileName),
  };
}

function samePreparedImport(left, right) {
  return left.archiveUrl === right.archiveUrl
    && left.expectedRevision === right.expectedRevision
    && left.fileName === right.fileName
    && left.importLowRam === right.importLowRam
    && left.remote === right.remote
    && JSON.stringify(left.importDecision) === JSON.stringify(right.importDecision)
    && JSON.stringify(left.resources) === JSON.stringify(right.resources)
    && left.recommendedSource?.sourceId === right.recommendedSource?.sourceId
    && left.managedSource?.checkedAt === right.managedSource?.checkedAt
    && JSON.stringify(left.managedSource?.fingerprint ?? null)
      === JSON.stringify(right.managedSource?.fingerprint ?? null);
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

// The MDD files are read like the archive, one at a time, and held as bytes
// until the import stages them next to the .mdx.
async function stageImportResources(request) {
  const staged = [];
  for (const resource of request.resources) {
    const response = await fetch(resource.blobUrl, { credentials: "omit" });
    if (!response.ok) {
      throw new Error(`could not read ${resource.fileName}: HTTP ${response.status}`);
    }
    const { bytes, byteLength } = await collectResponse(response);
    if (byteLength === 0) {
      throw new Error(`${resource.fileName} is empty`);
    }
    staged.push({ fileName: resource.fileName, bytes });
  }
  return staged;
}

// After a successful native import into `generationRoot`: flush it, then
// `commit` loads and publishes it. A failed commit restores the committed set
// and discards the generation.
async function commitImportedRoot(generationRoot, report, commit) {
  try {
    await persistFilesystem();
    await commit(generationRoot, report);
  } catch (error) {
    if (error instanceof UnknownDictionaryStateCommitError) {
      // Storage may already reference the new path. Neither generation is safe
      // to delete until an authoritative read succeeds.
      reloadError = error;
      throw error;
    }
    await rollbackImportedGeneration(generationRoot, error);
    throw error;
  }
  return report;
}

// Imports inside this engine. The loaded dictionaries are mapped into the same
// 32-bit address space the importer needs, so they are unloaded first and the
// offscreen bridge refuses reads until the commit (or the rollback) reloads
// them. The custom dictionary always compiles this way; hd_import does only
// when the runtime has no isolated importer.
async function runImportTransaction(
  archiveSource,
  fileName,
  importLowRam,
  commit,
  expectedArchiveBytes = null,
  resources = [],
) {
  const generationRoot = createGenerationRoot();
  // Public count/generation state is not changed until either the candidate or
  // the committed state is loaded.
  resetEngine();

  // The archive is scratch: staging it in MEMFS instead of OPFS saves the
  // proxied write, read-back mapping, and unlink (about 50 ms of hdw_import for
  // Jitendex) and writes nothing to disk that the importer does not keep. The
  // heap holds one extra copy of the archive for the duration of the import.
  let report;
  try {
    report = await importDictionaryArchive(
      engine,
      archiveSource,
      generationRoot,
      importLowRam,
      fileName,
      expectedArchiveBytes,
      { resources, backend: storageBackend },
    );
  } catch (error) {
    await rollbackImportedGeneration(generationRoot, error);
    throw error;
  }
  if (!report.success) {
    await rollbackImportedGeneration(
      generationRoot,
      new Error(report.error || `${fileName} could not be imported`),
    );
    return report;
  }
  return commitImportedRoot(generationRoot, report, commit);
}

// Imports through the isolated importer while this engine keeps answering
// lookups from the committed generations, then swaps the new generation in
// under the engine queue: `commit` removes the replaced package and adds the
// new one in place (loadDictionariesIncrementally), a few milliseconds during
// which lookups wait rather than fail. Only the swap runs inside serialise().
async function runIsolatedImportTransaction(
  archive,
  fileName,
  importLowRam,
  commit,
  expectedArchiveBytes,
  resources,
) {
  const generationRoot = createGenerationRoot();
  importingRoots.add(generationRoot);
  let report;
  try {
    report = await isolatedImport({
      archive,
      fileName,
      generationRoot,
      lowRam: importLowRam,
      expectedArchiveBytes,
      resources,
    });
    if (!report || typeof report.success !== "boolean") {
      throw new Error("The import worker returned no valid import report.");
    }
  } catch (error) {
    await serialise(() => discardImportingRoot(generationRoot));
    throw error;
  }
  return serialise(async () => {
    requireEngine();
    if (!report.success) {
      await discardImportingRoot(generationRoot);
      return report;
    }
    importingRoots.delete(generationRoot);
    return commitImportedRoot(generationRoot, report, commit);
  });
}

// The engine never loaded anything from a root the isolated importer wrote, so
// a failed import only has to remove the files.
async function discardImportingRoot(generationRoot) {
  importingRoots.delete(generationRoot);
  try {
    await discardGeneration(generationRoot);
  } catch (error) {
    console.warn(`hoshidicts: could not discard the failed dictionary generation: ${describeErrorMessageOrJson(error)}`);
  }
}

async function importAttempt({ request, staged, resources, installing, reducedMemory, revalidate, commit }) {
  if (isolatedImport !== null) {
    await reportProgress?.(installing);
    return runIsolatedImportTransaction(
      staged.bytes, request.fileName, reducedMemory,
      async (root, report) => commit(await revalidate())(root, report),
      staged.byteLength, resources,
    );
  }
  return serialise(async () => {
    requireEngine();
    const checked = await revalidate();
    // Acknowledge the read lock before resetting the live engine.
    await reportProgress?.({ ...installing, fallback: "memory" });
    return runImportTransaction(staged.bytes, request.fileName, reducedMemory, commit(checked), staged.byteLength, resources);
  });
}

function canRetryImport(failure, reducedMemory) {
  return !reducedMemory && isImportMemoryError(failure)
    && !(failure instanceof UnknownDictionaryStateCommitError) && reloadError === null;
}

async function importAttemptOutcome(options) {
  try {
    const report = await importAttempt(options);
    return { report, failure: report.success ? null : report };
  } catch (error_) {
    return { failure: error_ };
  }
}

function finishImportOutcome({ report, failure }, fileName, retried) {
  if (failure === null) return report;
  const phase = retried ? "retrying with reduced memory" : "importing the dictionary";
  const error = dictionaryImportError(failure, fileName, phase);
  if (retried) error.message += " The reduced-memory retry also failed.";
  if (report === undefined) throw error;
  report.error = error.message;
  report.errorCode = error.errorCode;
  return report;
}

async function importWithRecovery(options) {
  const { request, staged, onDownload } = options;
  const reducedMemory = request.importLowRam;
  const first = await importAttemptOutcome({ ...options, reducedMemory });
  if (!canRetryImport(first.failure, reducedMemory)) {
    return finishImportOutcome(first, request.fileName, false);
  }
  // The failed transaction has rolled back. OPFS retries once in a fresh
  // worker with one importer thread and disk-backed input staging.
  if (staged.bytes.byteLength === 0) {
    staged.bytes = (await stageImportArchive(await fetchImportArchive(request), onDownload)).bytes;
    if (staged.bytes.byteLength !== staged.byteLength) throw new Error(`${request.fileName} changed before the import retry`);
  }
  const resources = options.resources.some(resource => resource.bytes.byteLength === 0)
    ? await stageImportResources(request) : options.resources;
  const retry = await importAttemptOutcome({ ...options, resources,
    installing: { ...options.installing, retry: true }, reducedMemory: true });
  return finishImportOutcome(retry, request.fileName, true);
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

async function commitCustomSourceOnly(initial, source, semanticRevision, custom) {
  let snapshot = initial;
  for (let attempt = 0; attempt < STORAGE_ATTEMPTS; attempt += 1) {
    if (snapshot.document.revision !== initial.document.revision) {
      return customStaleReply(snapshot);
    }
    const reply = await commitCustomStorage(snapshot, source, semanticRevision, undefined, custom);
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
      throw new Error(`${describeErrorMessageOrJson(error)}; custom dictionary rollback failed: ${describeErrorMessageOrJson(restoreError)}`);
    }
  }
  throw error;
}

function customRemovalLoadedCount(dictionaries, removesPackage) {
  if (!removesPackage) return dictionaryCount;
  return loadDictionaries(dictionaries, { committed: dictionaries });
}

async function commitCustomRemoval(initial, source, semanticRevision, custom) {
  let snapshot = initial;
  for (let attempt = 0; attempt < STORAGE_ATTEMPTS; attempt += 1) {
    if (snapshot.document.revision !== initial.document.revision) {
      return customStaleReply(snapshot);
    }
    const dictionaries = snapshot.state.dictionaries.filter(
      (dictionary) => dictionary?.id !== custom.identity.id,
    );
    const removesPackage = dictionaries.length !== snapshot.state.dictionaries.length;
    try {
      const loadedCount = customRemovalLoadedCount(dictionaries, removesPackage);
      const reply = await commitCustomStorage(
        snapshot,
        source,
        semanticRevision,
        removesPackage ? dictionaries : undefined,
        custom,
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
  custom,
) {
  const { identity } = custom;
  const generated = await packageFromIndex(`${generationRoot}/${dictionaryFolderName(report.title)}`);
  if (report.title !== identity.title
      || generated.title !== identity.title) {
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
    const dictionaries = withCustomDictionary(snapshot.state.dictionaries, generated, identity, Boolean(snapshot.state.stored));
    const loadedCount = loadDictionaries(dictionaries, { committed: snapshot.state.dictionaries });
    const reply = await commitCustomStorage(snapshot, source, semanticRevision, dictionaries, custom);
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

async function saveCustomDictionary(snapshot, source, custom = JAPANESE_CUSTOM) {
  const { identity } = custom;
  const parsed = parseCustomDictionary(source, identity);
  const semanticRevision = await customDictionarySemanticRevision(parsed.entries, identity);
  if (parsed.entries.length === 0) {
    const removed = await commitCustomRemoval(snapshot, source, semanticRevision, custom);
    return { ...removed, errors: parsed.errors };
  }
  if (snapshot.state.dictionaries.some((dictionary) =>
    dictionary?.id !== identity.id
      && dictionary?.title === identity.title)) {
    throw new Error(`a dictionary named ${identity.title} is already installed`);
  }
  if (semanticRevision === snapshot.document.semanticRevision
      && await customPackageSatisfies(snapshot.state, semanticRevision, parsed.entries.length, identity)) {
    const saved = await commitCustomSourceOnly(snapshot, source, semanticRevision, custom);
    return { ...saved, errors: parsed.errors, rebuilt: false, removed: false };
  }

  const archive = buildCustomDictionaryZip(parsed.entries, semanticRevision, identity);
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
          custom,
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
// Exported archive URLs, each with the name of its temporary OPFS file or null.
const backupUrls = new Map();
const dictionaryDownloads = new Map();
let dictionaryDownloadCounter = 0;

// On direct OPFS a backup archive is an OPFS file: an export is written into
// one that Chrome downloads, and a chosen backup is copied into one that the
// restore reads in place. Neither is held in memory or browser Blob storage,
// whose limits broke large backups (#577). A file is removed once its export
// is released or its restore prepared; the engine's start removes any a
// closed browser left.
async function backupFileDirectory(create = false) {
  return (await navigator.storage.getDirectory()).getDirectoryHandle(BACKUP_FILE_DIRECTORY, { create });
}

async function writeBackupFile(write) {
  const directory = await backupFileDirectory(true);
  const name = `${globalThis.crypto.randomUUID()}.zip`;
  const handle = await directory.getFileHandle(name, { create: true });
  const output = await handle.createWritable();
  try {
    await write(output);
    return { name, file: await handle.getFile() };
  } catch (error) {
    await output.abort().catch(() => {});
    await directory.removeEntry(name).catch(() => {});
    throw error;
  }
}

async function removeBackupFile(name) {
  await (await backupFileDirectory()).removeEntry(name);
}

async function readBackupStorage(raw = false) {
  const reply = await ask(raw ? "hd_backup_base_read" : "hd_backup_read");
  if (!reply.ok) throw new Error(reply.error || "Could not read the complete Hachidori state.");
  return reply;
}

// A dictionary file for an archive. A Blob-backed IDBFS file is already that
// Blob (only the classic FS has the node to ask; WasmFS has no lookupPath).
// Any other file is read as the archive is written: copying the library into
// Blobs first held it twice in browser Blob storage and broke large exports
// (#577).
function backupFileData(path, size) {
  const FS = engine.FS;
  if (storageBackend === "idbfs") {
    const { blob } = FS.lookupPath(path).node;
    if (blob instanceof Blob && blob.size === size) return blob;
  }
  return {
    size,
    readUint8Array(offset, length) {
      const input = FS.open(path, "r");
      try {
        const bytes = new Uint8Array(length);
        if (FS.read(input, bytes, 0, length, offset) !== length) {
          throw new Error(`Could not read the complete dictionary file: ${path}`);
        }
        return bytes;
      } finally {
        FS.close(input);
      }
    },
  };
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
    else if ((stat.mode & 0o170000) === 0o100000) output.push({ path, data: backupFileData(absolute, stat.size) });
    else throw new Error(`Dictionary generation contains a non-file entry: ${path}`);
  }
}

async function discardPreparedBackup() {
  const previous = preparedBackup;
  preparedBackup = null;
  if (previous) await discardGenerations(previous.roots);
  if (previous?.retained === true) await cleanupCommittedDictionaries();
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
    const next = { ...dictionary, path: `${root}/${dictionaryFolderName(text(dictionary.title))}` };
    assertBackupDictionaryPath(next, "The backup contains an invalid dictionary title.");
    return next;
  });
  for (const file of prepared.files) {
    const [, ordinal, ...relative] = file.path.split("/");
    const dictionary = dictionaries[Number(ordinal)];
    if (!dictionary) throw new Error(`The backup file has no dictionary: ${file.path}`);
    const path = `${dictionary.path}/${relative.join("/")}`;
    engine.FS.mkdirTree(path.slice(0, path.lastIndexOf("/")));
    await streamResponseToFile(engine, new Response(file.data), path);
  }
  for (const dictionary of dictionaries) await validateBackupDictionaryFiles(dictionary);
  await persistFilesystem();
  return dictionaries;
}

// The packages a version 4 restore loads (docs/languages.md 17.2): the
// archived ones staged above, and every other language's personal package
// rebuilt from its document; one entry per package, enabled when a restored
// profile enables it.
async function stageBackupLanguages(backupState, plan, staged, roots) {
  const fresh = new Map(staged.map(row => [row.id, row]));
  for (const entry of plan.personal) {
    fresh.set(entry.identity.id, await rebuildBackupPersonalPackage(entry, roots)); // NOSONAR: one engine import at a time
  }
  if (plan.personal.length > 0) await persistFilesystem();
  return backupState.backupEngineDictionaries(plan, fresh);
}

// What the restore preview shows: the packages, every restored language's
// personal entries and, where languages are involved, their lines (17.2, 17.6).
function backupPreview(backupState, current, plan, dictionaries, snapshot) {
  const notes = backupState.restorePreviewNotes(current, plan);
  return {
    dictionaries: dictionaries.map(({ title, enabled }) => ({ title, enabled })),
    customEntryCount: plan === null ? parseCustomDictionary(snapshot.document.text).entries.length
      : backupState.personalEntryCount(snapshot, plan),
    ...(notes.length === 0 ? {} : { languageNotes: notes }),
  };
}

// The packs of the restored profiles load before the restore publishes
// (docs/languages.md 9.2); a pack that fails is reported as at a start.
async function adoptRestoredLanguages(options) {
  const { hasProfiles, profiles } = globalThis.HDReaderOptions;
  profileRecords = hasProfiles(options);
  recordLanguages = profileRecords ? [...new Set(profiles(options).map(profile => profile.language))] : [];
  setDebugLogLanguages(recordLanguages);
  if (profileRecords) await loadLanguagePacks(recordLanguages, { all: true });
  else languageFailures = [];
}

function assertBackupDictionaryPath(dictionary, message = "The backup contains an invalid dictionary path.") {
  if (dictionaryRoot(dictionary) === null) {
    throw new Error(message);
  }
}

function assertBackupDictionaryPaths(dictionaries) {
  for (const dictionary of dictionaries) assertBackupDictionaryPath(dictionary);
}

async function validateBackupDictionaryFiles(dictionary) {
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
  // Every language's personal package keeps the managed-package invariants.
  const personal = personalDictionaryLanguage(dictionary);
  if (personal !== null && !customDictionaryMetadataMatches(generated, dictionary.revision, dictionary.termCount,
    personalDictionaryIdentity(personal))) {
    throw new Error("The backup custom dictionary files do not satisfy the managed package invariants.");
  }
}

// A version 4 archive does not carry other languages' personal packages; the
// restore compiles each from its document into a fresh generation, as a save
// in Settings would (docs/languages.md 17.2), keeping the package's name and
// favourite from the backup.
async function rebuildBackupPersonalPackage({ identity, row, document }, roots) {
  const parsed = parseCustomDictionary(document.text, identity);
  const semanticRevision = await customDictionarySemanticRevision(parsed.entries, identity);
  const root = createGenerationRoot();
  roots.push(root);
  resetEngine();
  const report = await importDictionaryArchive(engine, new Response(buildCustomDictionaryZip(parsed.entries, semanticRevision, identity)),
    root, lowRam, "the custom dictionary archive", null, { backend: storageBackend });
  if (!report.success) throw new Error(report.error || `${identity.title} could not be rebuilt from its document.`);
  const generated = await packageFromIndex(`${root}/${dictionaryFolderName(report.title)}`);
  if (!customDictionaryMetadataMatches(generated, semanticRevision, parsed.entries.length, identity)) {
    throw new Error("The rebuilt custom dictionary does not satisfy the managed package invariants.");
  }
  return {
    ...generated, id: identity.id, title: identity.title,
    displayName: typeof row.displayName === "string" ? row.displayName : null,
    favorite: row.favorite === true, isUpdatable: false, indexUrl: null, downloadUrl: null, lastUpdateCheck: null,
  };
}

async function commitBackupSnapshot(current, snapshot, lookupStatsRows, languageLookupStatsRows) {
  try {
    return await ask("hd_backup_cas", { base: current, snapshot, lookupStatsRows,
      ...(languageLookupStatsRows === undefined ? {} : { languageLookupStatsRows }) });
  } catch (commitError) {
    let readback;
    try { readback = (await readBackupStorage(true)).snapshot; }
    catch (readError) { throw new UnknownDictionaryStateCommitError(commitError, readError, "backup restore"); }
    if (sameJsonValue(readback, snapshot)) return { ok: true, snapshot };
    if (!sameJsonValue(readback, current)) {
      throw new UnknownDictionaryStateCommitError(commitError,
        new Error("readback did not match the exact complete restore transaction"), "backup restore");
    }
    return { ok: false, error: describeErrorMessageOrJson(commitError) };
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
    const { restoredBackupSnapshot, restoredLanguageRows } = await import("./backup-state.js");
    const current = (await readBackupStorage(true)).snapshot;
    if (!sameJsonValue(current, prepared.current)) {
      throw new Error("Hachidori changed since this backup was prepared. Prepare it again before restoring.");
    }
    const plan = prepared.plan ?? null;
    const snapshot = restoredBackupSnapshot(current, prepared.snapshot, prepared.dictionaries, { overlay: OVERLAY_MODE, plan });
    // Records with profiles load every package once, as the engine reads them.
    const loadedCount = loadDictionaries(plan === null ? prepared.dictionaries : engineState(snapshot.state).dictionaries);
    const reply = await commitBackupSnapshot(current, snapshot, prepared.lookupStatsRows,
      plan === null ? undefined : restoredLanguageRows(plan, snapshot));
    if (!reply.ok) throw new Error(reply.error || "Could not commit the backup restore.");
    if (plan !== null || profileRecords) await adoptRestoredLanguages(snapshot.options);
    publishLoadedDictionaries(loadedCount);
    reloadError = null;
    await cleanupCommittedDictionaries();
    const notes = [prepared.settingsWarning, reply.warning];
    try {
      const cleanup = await ask("hd_lookup_stats_cleanup");
      if (!cleanup.ok) throw new Error(cleanup.error);
    } catch (error) {
      notes.push(`Old lookup statistics could not be cleaned up: ${describeErrorMessageOrJson(error)}`);
    }
    const warning = notes.some(Boolean) ? ["Restored successfully.", ...notes].filter(Boolean).join(" ") : null;
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
  if (target.id === CUSTOM_DICTIONARY_ID || personalDictionaryLanguage(target) !== null) {
    throw new Error("the managed custom dictionary can only be removed by saving an empty source");
  }
  return target;
}

// An hd_remove that names no profile comes from an older client (section
// 5.2): it may not delete a package that a profile other than Japanese uses.
function assertLegacyRemoval(state, message, target) {
  if (!state.stored || message.profileId !== undefined) return;
  const user = Object.entries(state.stored.profiles).find(([id, profile]) => id !== JAPANESE_PROFILE_ID
    && profile.dictionaries.some((entry) => entry.id === target.id));
  if (user) throw new Error(`This dictionary is used by ${languageName(user[0])} on the linked Hachidori. Remove it there.`);
}

const HANDLERS = {
  async hd_backup_export() {
    await ensureLoaded();
    const [{ createBackupArchive, assertBackupPath }, { assertBackupProfiles, assertBackupSnapshot }] = await Promise.all([
      import("./backup-archive.js"), import("./backup-state.js"),
    ]);
    const { snapshot, lookupStatsRows, profiles } = await readBackupStorage();
    await assertBackupSnapshot(snapshot);
    // Records with profiles make a version 4 archive (docs/languages.md 17.2).
    if (profiles !== undefined) await assertBackupProfiles(snapshot, profiles);
    const files = [];
    for (const [index, dictionary] of snapshot.state.dictionaries.entries()) {
      if (dictionaryRoot(dictionary) === null) throw new Error("Cannot back up an invalid dictionary path.");
      collectBackupFiles(dictionary.path, `dictionaries/${index}`, assertBackupPath, files);
    }
    const exported = storageBackend === "opfs"
      ? await writeBackupFile(output => createBackupArchive(snapshot, files, lookupStatsRows, undefined, output, profiles))
      : { name: null, file: await createBackupArchive(snapshot, files, lookupStatsRows, undefined, undefined, profiles) };
    const blobUrl = URL.createObjectURL(exported.file);
    backupUrls.set(blobUrl, exported.name);
    return { blobUrl, size: exported.file.size };
  },

  async hd_backup_release(message) {
    const name = backupUrls.get(message.blobUrl);
    if (backupUrls.delete(message.blobUrl)) {
      URL.revokeObjectURL(message.blobUrl);
      if (name !== null) await removeBackupFile(name);
    }
    return {};
  },

  // The relay's dictionary download: one dictionary as the backup archive the
  // host's own restore accepts, built while this turn holds the queue so no
  // cleanup can remove the generation under it, then served by offset.
  async hd_api_dictionary_open(message) {
    await ensureLoaded();
    const [{ createBackupArchive, assertBackupPath }, { assertBackupSnapshot }, { emptyCustomDictionaryDocument }] = await Promise.all([
      import("./backup-archive.js"), import("./backup-state.js"), import("./custom-dictionary.js"),
    ]);
    const { snapshot } = await readBackupStorage();
    const dictionary = snapshot.state.dictionaries.find(entry => entry?.id === message.id);
    if (!dictionary) throw new Error("unknown dictionary");
    if (dictionaryRoot(dictionary) === null) throw new Error("Cannot export an invalid dictionary path.");
    // Like the lookup counts below, the words marked as known or ignored are
    // the reader's own and stay out of a dictionary's archive.
    const single = {
      ...snapshot,
      state: { ...snapshot.state, dictionaries: [dictionary],
        groups: globalThis.HDDictionaryGroups.normaliseDictionaryGroups(snapshot.state.groups, [dictionary]) },
      document: dictionary.id === CUSTOM_DICTIONARY_ID ? snapshot.document : emptyCustomDictionaryDocument(),
      wordStatusOverrides: globalThis.HDWordStatusOverrides.emptyWordStatusOverrides(),
    };
    await assertBackupSnapshot(single);
    const files = [];
    collectBackupFiles(dictionary.path, "dictionaries/0", assertBackupPath, files);
    const archive = await createBackupArchive(single, files, []);
    const token = `dl-${++dictionaryDownloadCounter}`;
    dictionaryDownloads.set(token, archive);
    return { token, size: archive.size };
  },

  async hd_api_dictionary_read(message) {
    const archive = dictionaryDownloads.get(message.token);
    if (!archive) throw new Error("unknown download token");
    const offset = Number(message.offset), length = Number(message.length);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
      throw new Error("a dictionary read needs a non-negative offset and length");
    }
    const end = Math.min(archive.size, offset + length);
    const bytes = new Uint8Array(await archive.slice(offset, end).arrayBuffer());
    return { data: encodeBase64(bytes), eof: end >= archive.size };
  },

  hd_api_dictionary_close(message) {
    dictionaryDownloads.delete(message.token);
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
    const [{ openBackupArchive }, backupState] = await Promise.all([
      import("./backup-archive.js"), import("./backup-state.js"),
    ]);
    const { prepareBackupSnapshot } = backupState;
    if (typeof message.blobUrl !== "string" || !message.blobUrl.startsWith("blob:")) {
      throw new Error("Choose a local Hachidori backup archive.");
    }
    const response = await fetch(message.blobUrl);
    if (!response.ok) throw new Error("Could not read the selected backup.");
    // On direct OPFS the restore reads its own OPFS copy in place.
    const copy = storageBackend === "opfs" ? await writeBackupFile(output => response.body.pipeTo(output)) : null;
    try {
      const prepared = await openBackupArchive(copy?.file ?? await response.blob());
      const { snapshot, warning: viewWarning } = await prepareBackupSnapshot(prepared.snapshot);
      prepared.snapshot = snapshot;
      const plan = prepared.profiles === undefined ? null : await backupState.prepareBackupProfiles(snapshot, prepared.profiles);
      const settingsWarning = plan === null ? viewWarning : plan.warning;
      const roots = [];
      try {
        let dictionaries = await stageBackupFiles(prepared, roots);
        if (plan !== null) dictionaries = await stageBackupLanguages(backupState, plan, dictionaries, roots);
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
        preparedBackup = { token, current, roots, dictionaries, snapshot, plan, settingsWarning, lookupStatsRows: prepared.lookupStatsRows };
        return { token, warning: [settingsWarning, warning].filter(Boolean).join(" ") || null,
          createdAt: prepared.createdAt, ...backupPreview(backupState, current, plan, dictionaries, prepared.snapshot) };
      } catch (error) {
        try { await restoreCommittedDictionaries(null, { publish: false }); }
        catch (restoreError) { reloadError = asError(restoreError); }
        // Prepare never publishes these paths, even when the old state is broken.
        await discardGenerations(roots);
        throw error;
      }
    } finally {
      if (copy) await removeBackupFile(copy.name).catch(() => {});
    }
  },

  async hd_backup_auto_prepare(message) {
    requireEngine();
    if (typeof message.token !== "string" || message.token === "") {
      throw new Error("Automatic backup preparation requires its Settings cancellation token.");
    }
    if (typeof message.id !== "string" || message.id === "") {
      throw new Error("Choose an automatic backup to restore.");
    }
    await discardPreparedBackup();
    const current = (await readBackupStorage(true)).snapshot;
    const [{ backup: prepared }, backupState] = await Promise.all([
      ask("hd_backup_auto_get", { id: message.id }),
      import("./backup-state.js"),
    ]);
    if (!prepared) throw new Error("This automatic backup is corrupt or no longer retained.");
    const { snapshot, warning: viewWarning } = await backupState.prepareBackupSnapshot(prepared.snapshot);
    // A snapshot with profiles names its packages in place, other languages'
    // personal packages included, whose roots it kept (docs/languages.md 17.2).
    const plan = prepared.profiles === undefined ? null : await backupState.prepareBackupProfiles(snapshot, prepared.profiles);
    const settingsWarning = plan === null ? viewWarning : plan.warning;
    const dictionaries = plan === null ? prepared.snapshot.state.dictionaries : backupState.backupEngineDictionaries(plan);
    assertBackupDictionaryPaths(dictionaries);
    try {
      for (const dictionary of dictionaries) await validateBackupDictionaryFiles(dictionary);
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
      preparedBackup = {
        token,
        current,
        retained: true,
        roots: [],
        dictionaries,
        snapshot,
        plan,
        settingsWarning,
        lookupStatsRows: prepared.lookupStatsRows,
      };
      return {
        token,
        warning: [settingsWarning, warning].filter(Boolean).join(" ") || null,
        createdAt: prepared.createdAt,
        ...backupPreview(backupState, current, plan, dictionaries, prepared.snapshot),
      };
    } catch (error) {
      try { await restoreCommittedDictionaries(null, { publish: false }); }
      catch (restoreError) { reloadError = asError(restoreError); }
      throw error;
    }
  },

  async hd_backup_auto_cleanup() {
    requireEngine();
    await cleanupCommittedDictionaries();
    return {};
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
    const reply = withDefinitionTags(withoutPersonalDictionary(termLookupReply(json, "hdw_lookup"), message));
    return kanaRuby(message) ? withFurigana(reply) : reply;
  },

  // Segment a batch of text chunks into the words a hover would show (#520).
  // Each chunk is one engine turn through serialise(), so a reader's queued
  // hd_lookup runs between chunks rather than waiting for the whole page: a
  // batch yields the engine as often as it has chunks. The handler is UNQUEUED
  // so it never holds the queue while awaiting its own per-chunk turns.
  async hd_segment(message) {
    requireEngine();
    const scanLength = clampInt(message.scanLength, 1, 64, DEFAULT_SCAN_LENGTH);
    // A hover with the personal dictionary off drops its results
    // (withoutPersonalDictionary), so the split leaves its words out as well.
    const options = lookupOptionsJson(message.options, {
      ...(message.options?.personalDictionary === false ? { excludedDictionary: personalTitle(message) } : {}),
      ...languageLookupOptions(message),
    });
    // Every chunk is checked before the first engine turn. A lone surrogate (a
    // pair split across two text nodes) becomes U+FFFD, one code unit for one,
    // so the spans' offsets still index the text the page sent.
    const chunks = (Array.isArray(message.chunks) ? message.chunks : []).map((chunk) => ({
      id: chunk?.id ?? null,
      text: boundedText(chunk?.text, "segment text", MAX_LOOKUP_TEXT_BYTES).toWellFormed(),
    }));
    const segments = [];
    for (const [index, { id, text: chunkText }] of chunks.entries()) {
      // A message that reached the engine during the previous chunk, such as
      // a hover's hd_lookup, takes its turn before this chunk's.
      if (index > 0) await yieldToMessages(); // NOSONAR: per-chunk yield is intentional
      // One chunk per serialised turn: a queued hd_lookup waiting behind this
      // batch gets the engine between chunks (the engine is not reentrant), so
      // the sequential await is the point rather than an accident.
      const spans = await serialise(async () => { // NOSONAR: per-chunk yield is intentional
        await ensureLoaded();
        if (chunkText === "") return [];
        const json = engine.ccall("hdw_segment", "string", ["string", "number", "string"], [chunkText, scanLength, options]);
        throwIfEngineFailed("hdw_segment");
        const parsed = parseJson(json, "hdw_segment");
        if (!Array.isArray(parsed?.spans)) throw new Error("hdw_segment returned a malformed response");
        return parsed.spans;
      });
      segments.push({ id, spans });
    }
    return { segments };
  },

  async hd_lookup_dictionary(message) {
    await ensureLoaded();
    const args = lookupArguments(message);
    const title = text(message.dictionary);
    // The loaded set is the authority on what the selected route can query: a
    // disabled, missing or unloaded package answers nothing, without a storage
    // round trip per request. A clicked-kanji group sends one request per term
    // member, so that trip would repeat for every member.
    const entry = (loadedPackages ?? []).find((candidate) =>
      candidate.title === title && candidate.kinds.split(",").includes("term"));
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
    const reply = withDefinitionTags(withoutPersonalDictionary(termLookupReply(json, "hdw_lookup_dictionary"), message));
    return kanaRuby(message) ? withFurigana(reply) : reply;
  },

  async hd_kanji(message) {
    await ensureLoaded();
    const character = boundedText(message.character, "kanji text", MAX_LOOKUP_TEXT_BYTES);
    if (character === "") {
      return { kanji: null };
    }
    // A character lookup of a profile reads only its dictionaries.
    const json = message.language === undefined
      ? engine.ccall("hdw_kanji", "string", ["string"], [character])
      : engine.ccall("hdw_kanji_with_options", "string", ["string", "string"],
        [character, JSON.stringify(languageLookupOptions(message))]);
    throwIfEngineFailed(message.language === undefined ? "hdw_kanji" : "hdw_kanji_with_options");
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
    let length = 0;
    for (const candidate of mediaPathCandidates(path)) {
      length = engine.ccall("hdw_media", "number", ["string", "string"], [dictionary, candidate]);
      throwIfEngineFailed("hdw_media");
      if (length > 0) break;
    }
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
    return { dataUrl: `data:${mediaType(path)};base64,${encodeBase64(bytes)}` };
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
    const custom = customRequest(message);
    const snapshot = await readCustomStorage(custom.language);
    if (message.baseDocumentRevision !== snapshot.document.revision) {
      return withPublicState(customStaleReply(snapshot));
    }
    return withPublicState(await saveCustomDictionary(snapshot, message.text, custom));
  },

  async hd_custom_append(message) {
    requireEngine();
    // This read deliberately happens inside the engine mutation queue. A Note
    // submitted behind a Settings save must append to that newly committed
    // source rather than the document that existed when the click was sent.
    const custom = customRequest(message);
    const snapshot = await readCustomStorage(custom.language);
    const source = appendCustomDictionaryEntry(snapshot.document.text, message?.entry, custom.identity);
    return withPublicState(await saveCustomDictionary(snapshot, source, custom));
  },

  async hd_import(message) {
    requireEngine();
    if (stagingImports > 0) {
      throw new Error("another dictionary import is already in progress");
    }
    stagingImports += 1;
    const requestId = message.requestId ?? null;
    let phase = "checking the import request";
    let name = text(message.fileName) || "The dictionary archive";
    try {
      const stagedRequest = await prepareImportRequest(message);
      name = stagedRequest.fileName;
      phase = "reading the archive";
      const response = await fetchImportArchive(stagedRequest);
      const onDownload = reportProgress === null ? null : (event) => {
        try {
          Promise.resolve(reportProgress({ requestId, ...event })).catch((error) => {
            console.warn(`hoshidicts: could not report import progress: ${describeErrorMessageOrJson(error)}`);
          });
        } catch (error) {
          console.warn(`hoshidicts: could not report import progress: ${describeErrorMessageOrJson(error)}`);
        }
      };
      const staged = await stageImportArchive(response, onDownload);
      if (staged.byteLength === 0) {
        throw new Error(`${stagedRequest.fileName} is empty`);
      }
      const stagedResources = await stageImportResources(stagedRequest);
      const { fileName } = stagedRequest;
      const installing = {
        requestId,
        phase: "installing",
        receivedBytes: staged.byteLength,
        totalBytes: staged.byteLength,
      };
      // The commit re-reads the request: a managed package can change while
      // its archive downloads or installs.
      const revalidate = async () => {
        const request = await prepareImportRequest(message);
        if (!samePreparedImport(stagedRequest, request)) {
          throw new Error("the dictionary import request changed while its archive was downloading");
        }
        return request;
      };
      // An import adds its package to the profile it was requested for
      // (docs/languages.md 5.2), a reimport too when that profile lacks it
      // (14); one that names none means Japanese, and managed updates name
      // none, so they leave every profile's list as it is.
      const commit = (request) => (generationRoot, importedReport) =>
        commitImportedGeneration(generationRoot, importedReport, request, typeof message.profileId === "string"
          ? { profileId: message.profileId, joins: true } : { profileId: JAPANESE_PROFILE_ID, joins: false });
      const replyFor = (report) => (report.success
        ? { report }
        : { ok: false, error: report.error || `${fileName} could not be imported`, report,
          errorCode: report.errorCode || (isImportMemoryError(report) ? "import-memory" : "import-failed") });

      phase = "importing the dictionary";
      return replyFor(await importWithRecovery({ request: stagedRequest, staged, resources: stagedResources,
        installing, revalidate, commit, onDownload }));
    } catch (error) {
      throw dictionaryImportError(error, name, phase);
    } finally {
      stagingImports -= 1;
    }
  },

  async hd_apply_state(message) {
    requireEngine();
    if (!Number.isInteger(message?.baseRevision) || message.baseRevision < 0) {
      throw new Error("the dictionary state change carried no valid base revision");
    }
    if (!Array.isArray(message?.dictionaries)) {
      throw new TypeError("the dictionary state change carried no dictionary list");
    }
    if (message.profileId !== undefined || profileRecords) {
      const applied = await applyProfileState(message);
      if (applied !== null) return applied;
    }

    let restorationAttempted = false;
    try {
      const loadedCount = reorderLoadedDictionaries(message.dictionaries) ?? loadDictionaries(message.dictionaries, {
        committed: await readStoredDictionaries(),
      });
      const loadPath = lastLoadPath;
      const reply = await commitDictionaryState(message.baseRevision, message.dictionaries);
      if (reply.ok === true) {
        publishLoadedDictionaries(loadedCount, { warm: loadPath !== "order-only" });
        reloadError = null;
        return { state: reply.state, loadPath };
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
        const { state } = await requestDictionaryStorage();
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

  hd_profile_add: addProfile,
  hd_profile_remove: removeProfile,

  async hd_remove(message) {
    requireEngine();
    const title = text(message.title);
    const id = optionalText(message.id);
    const legacyRemovalRoot = title === ".hdw-remove" && hasDictionaryMarker(REMOVAL_ROOT);
    if (!usableDictionaryTitle(title) && !legacyRemovalRoot) {
      throw new Error("the remove request carried an unusable dictionary title");
    }
    const snapshot = await requestDictionaryStorage();
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
    assertLegacyRemoval(snapshot.state, message, target);
    const remaining = snapshot.state.dictionaries.filter(
      (dictionary) => dictionary?.id !== target.id,
    );

    let loadedCount;
    let reply;
    try {
      loadedCount = loadDictionaries(remaining, { committed: remaining });
      // A removal removes the package from every profile.
      reply = await commitDictionaryState(snapshot.state.revision, remaining,
        snapshot.state.stored ? { stored: snapshot.state.stored } : null);
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
        throw new Error(`${describeErrorMessageOrJson(error)}; removal rollback failed: ${describeErrorMessageOrJson(restoreError)}`);
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
        + `removal rollback failed: ${describeErrorMessageOrJson(restoreError)}`,
      );
    }
    return {
      ok: false,
      conflict: reply.conflict === true,
      error: reply.error || "the dictionary removal could not be saved",
      state: publicState(reply.state),
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
      error: failure === null ? null : describeErrorMessageOrJson(failure),
      ready,
      loading: busy > 0 || stagingImports > 0,
      dictionaryCount,
      registeredKindCount: dictionaryCount,
      packageCount: (loadedPackages ?? []).length,
      failedDictionaries: loadFailures,
      lastLoadPath,
      generation,
      // Once the records have profiles, packs that could not be loaded.
      ...(profileRecords ? { failedLanguages: languageFailures } : {}),
      storageBackend,
      threaded,
      // Which worker is serving: the low-memory one imports single-threaded
      // inside the small pool and reads dictionary entries from disk on
      // demand (docs/memory.md).
      lowMemory: threaded && lowRam,
      pagedDictionaries,
      dictionaryEntryStorage,
      dictionaryIndexStorage,
      useLessRamByDefault,
      hashIndexStorage: indexPolicy(),
      residentHashBudgetBytes: indexBudget(),
    };
  },

  // Emscripten's mmap copies each mapped file into linear memory, so a loaded
  // package's resident bytes are the sizes of the files hoshidicts maps for
  // it, once however many kinds it loads as (the kinds share them). Media is
  // read from disk when shown, and a paged package's entries as they are
  // looked up, through a page cache of pageCacheBytes. The heap itself never
  // shrinks, so heapBytes also keeps whatever an import or rebuild peaked at.
  // The log of the context this engine runs in, for Get debug info.
  async hd_debug_log() {
    return { log: await readDebugLog(globalThis) };
  },

  hd_memory() {
    requireEngine();
    const dictionaries = (loadedPackages ?? []).map((entry) => ({
      id: entry.id,
      title: entry.title,
      path: entry.path,
      ...residentFiles(entry),
      paged: entry.paged,
      hashIndexStorage: entry.indexPaged ? "paged" : "resident",
    }));
    // Growth on an engine pthread reaches this thread's HEAPU8 view only once
    // some glue touches the heap; a stat does (see writeFileBytes).
    exists("/dicts");
    return {
      heapBytes: engine.HEAPU8.byteLength,
      pageCacheBytes: engine.ccall("hdw_page_cache_bytes", "number", [], []),
      ...JSON.parse(engine.ccall("hdw_memory_stats", "string", [], [])),
      dictionaryIndexStorage,
      useLessRamByDefault,
      hashIndexStorage: indexPolicy(),
      residentHashBudgetBytes: indexBudget(),
      packageCount: dictionaries.length,
      registeredKindCount: dictionaryCount,
      dictionaries,
    };
  },
};

// The files query.cpp keeps in the heap for a loaded package: its index, which
// every probe reads, resident hash tables, and blobs.bin unless the package is paged. dict.zstd is
// read into a zstd dictionary, which holds the same bytes, and scan.idx is
// mapped only for a package loaded as a term dictionary.
const INDEX_FILES = ["bloom.filter", "media.idx", "dict.zstd"];

function indexPolicy() {
  return actualIndexPolicy(dictionaryIndexStorage, storageBackend, threaded && lowRam, useLessRamByDefault);
}

function indexBudget() {
  return indexPolicy() === "budget" ? residentHashBudgetBytes(threaded && lowRam) : null;
}

function fileBytes(path, name) {
  const file = `${path}/${name}`;
  return exists(file) ? engine.FS.stat(file).size : 0;
}

function hashTableBytes(path) { return fileBytes(path, "hash.table"); }

function residentFiles(entry) {
  const names = [...INDEX_FILES];
  if (entry.kinds.split(",").includes("term")) names.push("scan.idx");
  const otherResidentBytes = names.reduce((bytes, name) => bytes + fileBytes(entry.path, name), 0);
  const hashBytes = hashTableBytes(entry.path);
  const residentHashBytes = entry.indexPaged ? 0 : hashBytes;
  const residentEntryBytes = entry.paged ? 0 : fileBytes(entry.path, "blobs.bin");
  return { hashBytes, residentHashBytes, otherResidentBytes, residentEntryBytes,
    bytes: residentHashBytes + otherResidentBytes + residentEntryBytes };
}

function failurePayload(type) {
  switch (type) {
    case "hd_lookup":
    case "hd_lookup_dictionary":
      return { results: [], dictionaryCount: 0 };
    case "hd_segment":
      return { segments: [] };
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
  const description = describeErrorMessageOrJson(error);
  recordDebugFailure(globalThis, type, description);
  let errorCode = error === bootError ? "engine-start-failed" : error?.errorCode ?? null;
  if (errorCode === null && description === "the dictionary engine is still starting") {
    errorCode = "engine-starting";
  }
  return boundResponseFailure({
    type: `${type}_result`, requestId, ok: false, error: description,
    ...(errorCode === null ? {} : { errorCode }),
    generation, ...failurePayload(type),
    ...(type === "hd_import" ? { report: emptyReport(description) } : {}),
  });
}

// Why a bounded request cannot be answered: an id a reply cannot carry, or a
// failure reply that would not fit the response limit; null when it can.
function boundedRequestRefusal(type, requestId) {
  if (!validResponseRequestId(requestId)) return "request ID must be a string, finite number, or null";
  if (!responseFits({ type: `${type}_result`, requestId, ok: false,
    error: responseLimitError(type), generation, ...failurePayload(type) })) return responseLimitError(type);
  return null;
}

// The import of the profile code runs in the request's own turn, so the
// queue keeps the order requests arrive in.
function engineJob(type, message, handler) {
  return readsProfileCode(type, message) ? () => loadProfileCode().then(() => handler(message)) : () => handler(message);
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
    const refusal = bounded ? boundedRequestRefusal(type, requestId) : null;
    if (refusal !== null) {
      requestId = null;
      throw new Error(refusal);
    }
    const job = engineJob(type, message, HANDLERS[type]);
    const run = UNQUEUED.has(type) ? Promise.resolve().then(job) : serialise(job);
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
  // boot() never rejects: a failed start is latched in bootError, which
  // hd_status and every request needing the engine report.
  const booted = serialise(boot);
  // The first lookup's own import reports a failure (withFurigana).
  importKanjiReadings().catch(() => {});
  return booted;
}
