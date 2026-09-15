/*
 * Shared source and archive rules for Hachidori's managed custom dictionary.
 *
 * This module deliberately has no Chrome or engine dependencies so Settings,
 * the background worker, and both engine runtimes use the same representation.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const CUSTOM_DICTIONARY_ID = "e4c2e20a1a964b6cbd4ae3f87643c1f0";
export const CUSTOM_DICTIONARY_TITLE = "Hachidori Custom Dictionary";
export const CUSTOM_DICTIONARY_SOURCE_KEY = "customDictionarySource";
export const CUSTOM_DICTIONARY_SOURCE_SCHEMA_VERSION = 1;
export const EMPTY_CUSTOM_DICTIONARY_SEMANTIC_REVISION =
  "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";

export function customDictionaryMetadataMatches(value, semanticRevision, entryCount) {
  return value?.title === CUSTOM_DICTIONARY_TITLE && value.revision === semanticRevision
    && value.termCount === entryCount
    && ["frequencyCount", "pitchCount", "kanjiCount", "mediaCount"].every(key => value[key] === 0)
    && value.isUpdatable === false && value.indexUrl === null && value.downloadUrl === null && value.language === "ja";
}

export function assertCustomDictionaryCommit(dictionaries) {
  const customIndexes = dictionaries.flatMap((dictionary, index) =>
    dictionary?.id === CUSTOM_DICTIONARY_ID ? [index] : []);
  if (customIndexes.length > 1) {
    throw new Error("the custom dictionary state contains duplicate managed packages");
  }
  if (customIndexes.length === 0) return;
  const custom = dictionaries[customIndexes[0]];
  if (customIndexes[0] !== 0
      || custom?.title !== CUSTOM_DICTIONARY_TITLE
      || custom?.enabled !== true) {
    throw new Error("the managed custom dictionary must stay enabled and first");
  }
  if (dictionaries.some((dictionary, index) =>
    index !== customIndexes[0] && dictionary?.title === CUSTOM_DICTIONARY_TITLE)) {
    throw new Error(`a dictionary named ${CUSTOM_DICTIONARY_TITLE} is already installed`);
  }
}

export function assertCustomSourceState(dictionaries, semanticRevision, entryCount) {
  const custom = dictionaries.filter((dictionary) => dictionary?.id === CUSTOM_DICTIONARY_ID);
  if (entryCount === 0) {
    if (custom.length !== 0) {
      throw new Error("a zero-entry custom source cannot retain its managed package");
    }
    return;
  }
  assertCustomDictionaryCommit(dictionaries);
  const entry = custom[0];
  if (custom.length !== 1
      || !customDictionaryMetadataMatches(entry, semanticRevision, entryCount)) {
    throw new Error("the custom dictionary package does not match its source semantics");
  }
}

const TERM_BANK_SIZE = 1_000;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_STORE = 0;
const ZIP_DATE = 0x21;
const ZIP_VERSION = 20;
const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xff_ff_ff_ff;
const encoder = new TextEncoder();

function sourceText(value) {
  if (typeof value !== "string") {
    throw new TypeError("the custom dictionary source must be text");
  }
  return value;
}

export function emptyCustomDictionaryDocument() {
  return {
    schemaVersion: CUSTOM_DICTIONARY_SOURCE_SCHEMA_VERSION,
    revision: 0,
    semanticRevision: EMPTY_CUSTOM_DICTIONARY_SEMANTIC_REVISION,
    text: "",
  };
}

export function normaliseCustomDictionaryDocument(value) {
  if (value === null || value === undefined) {
    return emptyCustomDictionaryDocument();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("the custom dictionary document is invalid");
  }
  if (value.schemaVersion !== CUSTOM_DICTIONARY_SOURCE_SCHEMA_VERSION) {
    throw new Error(`unsupported custom dictionary source schema ${String(value.schemaVersion)}`);
  }
  if (!Number.isInteger(value.revision) || value.revision < 0) {
    throw new TypeError("the custom dictionary document revision is invalid");
  }
  if (typeof value.text !== "string"
      || typeof value.semanticRevision !== "string"
      || !/^[0-9a-f]{64}$/u.test(value.semanticRevision)) {
    throw new TypeError("the custom dictionary document content is invalid");
  }
  return {
    schemaVersion: CUSTOM_DICTIONARY_SOURCE_SCHEMA_VERSION,
    revision: value.revision,
    semanticRevision: value.semanticRevision,
    text: value.text,
  };
}

function decodeDefinition(value) {
  if (!value.includes("\\")) return value;
  let decoded = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\\" || index + 1 >= value.length) {
      decoded += character;
      continue;
    }
    const next = value[index + 1];
    if (next === "\\") {
      decoded += "\\";
      index += 1;
    } else if (next === "n") {
      decoded += "\n";
      index += 1;
    } else {
      decoded += character;
    }
  }
  return decoded;
}

function normaliseEntry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("the custom dictionary entry must be an object");
  }
  const term = typeof value.term === "string" ? value.term.trim() : "";
  const reading = typeof value.reading === "string" ? value.reading.trim() : "";
  const definition = typeof value.definition === "string"
    ? value.definition.trim().replace(/\r\n?|\n/gu, "\n")
    : "";
  if (term === "") throw new TypeError("the custom dictionary term is empty");
  if (term.startsWith("#")) {
    throw new TypeError("the custom dictionary term cannot begin with #");
  }
  if (term.includes(",") || /[\r\n]/u.test(term)) {
    throw new TypeError("the custom dictionary term cannot contain a comma or newline");
  }
  if (reading === "") throw new TypeError("the custom dictionary reading is empty");
  if (reading.includes(",") || /[\r\n]/u.test(reading)) {
    throw new TypeError("the custom dictionary reading cannot contain a comma or newline");
  }
  if (definition === "") throw new TypeError("the custom dictionary definition is empty");
  return { term, reading, definition };
}

export function parseCustomDictionary(value) {
  const source = sourceText(value);
  const parsedSource = source.startsWith("\ufeff") ? source.slice(1) : source;
  const entries = [];
  const errors = [];
  const lines = parsedSource.split(/\r\n|\r|\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed === "" || line.trimStart().startsWith("#")) continue;

    const firstComma = line.indexOf(",");
    const secondComma = firstComma < 0 ? -1 : line.indexOf(",", firstComma + 1);
    if (firstComma < 0 || secondComma < 0) {
      errors.push({ lineNumber: index + 1, reason: "expected two commas" });
      continue;
    }
    const term = line.slice(0, firstComma).trim();
    const reading = line.slice(firstComma + 1, secondComma).trim();
    const encodedDefinition = line.slice(secondComma + 1).trim();
    const definition = decodeDefinition(encodedDefinition);
    if (term === "") {
      errors.push({ lineNumber: index + 1, reason: "term is empty" });
    } else if (reading === "") {
      errors.push({ lineNumber: index + 1, reason: "reading is empty" });
    } else if (definition.trim() === "") {
      errors.push({ lineNumber: index + 1, reason: "definition is empty" });
    } else {
      entries.push({ term, reading, definition });
    }
  }
  return { entries, errors };
}

export function serializeCustomDictionaryEntry(value) {
  const { term, reading, definition } = normaliseEntry(value);
  const encodedDefinition = definition
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", String.raw`\n`);
  return `${term}, ${reading}, ${encodedDefinition}`;
}

export function appendCustomDictionaryEntry(value, entry) {
  const source = sourceText(value);
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const separator = source === "" || /[\r\n]$/u.test(source) ? "" : newline;
  return `${source}${separator}${serializeCustomDictionaryEntry(entry)}${newline}`;
}

export async function customDictionarySemanticRevision(values) {
  if (!Array.isArray(values)) {
    throw new TypeError("the custom dictionary entries must be a list");
  }
  const bytes = encoder.encode(JSON.stringify(values.map(normaliseEntry)));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 0
        ? value >>> 1
        : 0xed_b8_83_20 ^ (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = UINT32_MAX;
  let index = 0;
  while (index < bytes.length) {
    crc = crcTable[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
    index += 1;
  }
  return (crc ^ UINT32_MAX) >>> 0;
}

function zipFile(name, value) {
  const nameBytes = encoder.encode(name);
  const data = encoder.encode(JSON.stringify(value));
  if (nameBytes.byteLength > UINT16_MAX || data.byteLength > UINT32_MAX) {
    throw new RangeError("the custom dictionary exceeds the classic ZIP representation");
  }
  return { nameBytes, data, crc: crc32(data), localOffset: 0 };
}

function checkedZipSize(value) {
  if (!Number.isSafeInteger(value) || value > UINT32_MAX) {
    throw new RangeError("the custom dictionary exceeds the classic ZIP representation");
  }
  return value;
}

function writeLocalHeader(view, offset, file) {
  view.setUint32(offset, 0x04_03_4b_50, true);
  view.setUint16(offset + 4, ZIP_VERSION, true);
  view.setUint16(offset + 6, ZIP_UTF8_FLAG, true);
  view.setUint16(offset + 8, ZIP_STORE, true);
  view.setUint16(offset + 10, 0, true);
  view.setUint16(offset + 12, ZIP_DATE, true);
  view.setUint32(offset + 14, file.crc, true);
  view.setUint32(offset + 18, file.data.byteLength, true);
  view.setUint32(offset + 22, file.data.byteLength, true);
  view.setUint16(offset + 26, file.nameBytes.byteLength, true);
  view.setUint16(offset + 28, 0, true);
}

function writeCentralHeader(view, offset, file) {
  view.setUint32(offset, 0x02_01_4b_50, true);
  view.setUint16(offset + 4, ZIP_VERSION, true);
  view.setUint16(offset + 6, ZIP_VERSION, true);
  view.setUint16(offset + 8, ZIP_UTF8_FLAG, true);
  view.setUint16(offset + 10, ZIP_STORE, true);
  view.setUint16(offset + 12, 0, true);
  view.setUint16(offset + 14, ZIP_DATE, true);
  view.setUint32(offset + 16, file.crc, true);
  view.setUint32(offset + 20, file.data.byteLength, true);
  view.setUint32(offset + 24, file.data.byteLength, true);
  view.setUint16(offset + 28, file.nameBytes.byteLength, true);
  view.setUint16(offset + 30, 0, true);
  view.setUint16(offset + 32, 0, true);
  view.setUint16(offset + 34, 0, true);
  view.setUint16(offset + 36, 0, true);
  view.setUint32(offset + 38, (0o100644 << 16) >>> 0, true);
  view.setUint32(offset + 42, file.localOffset, true);
}

function writeEndRecord(view, offset, entryCount, centralSize, centralOffset) {
  view.setUint32(offset, 0x06_05_4b_50, true);
  view.setUint16(offset + 4, 0, true);
  view.setUint16(offset + 6, 0, true);
  view.setUint16(offset + 8, entryCount, true);
  view.setUint16(offset + 10, entryCount, true);
  view.setUint32(offset + 12, centralSize, true);
  view.setUint32(offset + 16, centralOffset, true);
  view.setUint16(offset + 20, 0, true);
}

export function buildCustomDictionaryZip(values, revision) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError("the custom dictionary needs at least one entry");
  }
  if (typeof revision !== "string" || revision === "") {
    throw new TypeError("the custom dictionary needs a semantic revision");
  }
  const entries = values.map(normaliseEntry);
  const files = [zipFile("index.json", {
    title: CUSTOM_DICTIONARY_TITLE,
    format: 3,
    revision,
    sequenced: true,
    author: "Hachidori",
    description: "Personal entries managed by Hachidori",
    sourceLanguage: "ja",
    targetLanguage: "en",
  })];
  for (let offset = 0; offset < entries.length; offset += TERM_BANK_SIZE) {
    const rows = entries.slice(offset, offset + TERM_BANK_SIZE).map((entry, index) => [
      entry.term,
      entry.reading,
      "",
      "",
      0,
      [entry.definition],
      offset + index + 1,
      "",
    ]);
    files.push(zipFile(`term_bank_${files.length}.json`, rows));
  }
  if (files.length > UINT16_MAX) {
    throw new RangeError("the custom dictionary exceeds the classic ZIP representation");
  }

  let localSize = 0;
  for (const file of files) {
    file.localOffset = localSize;
    localSize = checkedZipSize(localSize + 30 + file.nameBytes.byteLength + file.data.byteLength);
  }
  const centralSize = checkedZipSize(files.reduce(
    (size, file) => size + 46 + file.nameBytes.byteLength,
    0,
  ));
  const totalSize = checkedZipSize(localSize + centralSize + 22);
  const bytes = new Uint8Array(totalSize);
  const view = new DataView(bytes.buffer);

  let cursor = 0;
  for (const file of files) {
    writeLocalHeader(view, cursor, file);
    cursor += 30;
    bytes.set(file.nameBytes, cursor);
    cursor += file.nameBytes.byteLength;
    bytes.set(file.data, cursor);
    cursor += file.data.byteLength;
  }
  for (const file of files) {
    writeCentralHeader(view, cursor, file);
    cursor += 46;
    bytes.set(file.nameBytes, cursor);
    cursor += file.nameBytes.byteLength;
  }
  writeEndRecord(view, cursor, files.length, centralSize, localSize);
  return bytes;
}
