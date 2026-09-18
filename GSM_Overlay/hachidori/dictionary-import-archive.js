/*
 * Reads only Yomitan index.json for an interactive import decision. The engine
 * still imports and validates the complete archive before anything is published.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BlobReader, Writer, ZipReader } from "./vendor/zip.js";
import { dictionaryArchiveIdentity } from "./dictionary-import.js";

export const MAX_PREFLIGHT_INDEX_BYTES = 1024 * 1024;

export class BoundedIndexWriter extends Writer {
  constructor(limit) {
    super();
    this.limit = limit;
    this.length = 0;
    this.parts = [];
  }

  writeUint8Array(bytes) {
    if (this.length + bytes.byteLength > this.limit) {
      throw new Error(`The selected archive's index.json exceeds ${this.limit} bytes.`);
    }
    this.parts.push(bytes.slice());
    this.length += bytes.byteLength;
  }

  getData() {
    const data = new Uint8Array(this.length);
    let offset = 0;
    for (const part of this.parts) {
      data.set(part, offset);
      offset += part.byteLength;
    }
    return new TextDecoder().decode(data);
  }
}

function assertRegularIndex(entry) {
  const kind = entry.unixMode === undefined ? 0 : entry.unixMode & 0o170000;
  if (entry.directory || entry.symlink || (kind !== 0 && kind !== 0o100000)) {
    throw new Error("The selected archive's index.json is not a regular file.");
  }
  if (entry.encrypted) {
    throw new Error("The selected archive's index.json is encrypted.");
  }
}

export async function readDictionaryArchiveIdentity(blob) {
  const reader = new ZipReader(new BlobReader(blob), {
    useWebWorkers: false,
    checkAmbiguity: true,
  });
  try {
    const entries = await reader.getEntries();
    const indexes = entries.filter(entry => entry.filename === "index.json");
    if (indexes.length !== 1) {
      throw new Error(indexes.length === 0
        ? "The selected archive has no index.json."
        : "The selected archive has more than one index.json.");
    }
    const entry = indexes[0];
    assertRegularIndex(entry);
    if (entry.uncompressedSize > MAX_PREFLIGHT_INDEX_BYTES) {
      throw new Error(`The selected archive's index.json exceeds ${MAX_PREFLIGHT_INDEX_BYTES} bytes.`);
    }
    const data = await entry.getData(new BoundedIndexWriter(MAX_PREFLIGHT_INDEX_BYTES), {
      useWebWorkers: false,
      checkSignature: true,
      checkOverlappingEntry: true,
      checkAmbiguity: true,
    });
    let index;
    try {
      index = JSON.parse(data);
    } catch (error) {
      throw new Error(`The selected archive's index.json is malformed: ${error.message || String(error)}`);
    }
    return dictionaryArchiveIdentity(index);
  } finally {
    await reader.close();
  }
}
