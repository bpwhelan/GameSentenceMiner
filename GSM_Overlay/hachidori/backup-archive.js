// Hachidori's own stored ZIP64 format; loaded only for explicit backup work.
// SPDX-License-Identifier: GPL-3.0-or-later
import { BlobReader, Writer, ZipReader, ZipWriter } from "./vendor/zip.js";
import { assertLookupStatsRows, emptyLookupStats } from "./lookup-stats.js";
import "./word-status-overrides.js";

const MANIFEST = "hachidori-backup.json";
const ZIP_OPTIONS = {
  useWebWorkers: false,
  level: 0,
  zip64: true,
  extendedTimestamp: false,
  lastModDate: new Date(1980, 0, 1),
};

// BlobWriter consumes a Response stream, whose cancellation in Chromium workers
// can surface as zip.js's "setting outputSize" error. Snapshot each chunk into
// a Blob instead, without flattening a ZIP64 archive into one typed array.
class BackupBlobWriter extends Writer {
  constructor(type = "") {
    super();
    this.type = type;
    this.parts = [];
  }

  writeUint8Array(bytes) {
    this.parts.push(new Blob([bytes]));
  }

  getData() {
    return new Blob(this.parts, { type: this.type });
  }
}

export function assertBackupPath(path) {
  if (typeof path !== "string" || /[\\\u0000-\u001f\u007f]/u.test(path)
      || path.split("/").some(part => part === "" || part === "." || part === "..")) {
    throw new Error(`Invalid backup file path: ${String(path)}`);
  }
}

function assertPayloadPath(path) {
  assertBackupPath(path);
  if (!/^dictionaries\/(?:0|[1-9]\d*)\/.+/u.test(path)) {
    throw new Error(`Unexpected backup payload path: ${path}`);
  }
}

function assertFileList(files) {
  if (!Array.isArray(files)) throw new Error("The backup has no file list.");
  const paths = new Set();
  for (const file of files) {
    assertPayloadPath(file?.path);
    if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error("Invalid backup file size.");
    if (paths.has(file.path)) throw new Error(`Duplicate backup file: ${file.path}`);
    paths.add(file.path);
  }
  for (const path of paths) {
    const components = path.split("/");
    components.pop();
    while (components.length > 0) {
      if (paths.has(components.join("/"))) throw new Error(`Backup file is also a directory: ${path}`);
      components.pop();
    }
  }
}

// Each file's data is a Blob or a zip.js reader ({ size, readUint8Array }) read
// while the archive is written. `output` is a Writer or a WritableStream. A
// backup of records with profiles is version 4: `profiles` sits beside the
// version 3 snapshot of their Japanese view (docs/languages.md 17.2), and the
// files are those of the packages that view lists.
export async function createBackupArchive(snapshot, files, lookupStatsRows, createdAt = new Date().toISOString(),
  output = new BackupBlobWriter("application/zip"), profiles = undefined) {
  const entries = files.map(({ path, data }) => ({ path, size: data.size }));
  assertFileList(entries);
  assertLookupStatsRows(snapshot?.lookupStats, lookupStatsRows);
  const manifest = profiles === undefined
    ? { format: "hachidori-backup", version: 3, createdAt, snapshot, lookupStatsRows, files: entries }
    : { format: "hachidori-backup", version: 4, createdAt, snapshot, lookupStatsRows, files: entries, profiles };
  /** @type {{add(name: string, reader: object): Promise<unknown>, close(): Promise<Blob>}} */
  const writer = new ZipWriter(output, ZIP_OPTIONS);
  await writer.add(MANIFEST, new BlobReader(new Blob([JSON.stringify(manifest)])));
  for (const { path, data } of files) {
    await writer.add(path, data instanceof Blob ? new BlobReader(data) : data); // NOSONAR: entries stream into one archive in order
  }
  return writer.close();
}

function assertRegularEntry(entry) {
  assertBackupPath(entry.filename);
  const kind = entry.unixMode === undefined ? 0 : entry.unixMode & 0o170000;
  if (entry.directory || entry.symlink || (kind !== 0 && kind !== 0o100000)) {
    throw new Error(`The backup entry is not a regular file: ${entry.filename}`);
  }
  if (entry.encrypted || entry.compressionMethod !== 0) {
    throw new Error("Hachidori backups contain only unencrypted, stored ZIP entries.");
  }
}

function readEntry(entry, writer = new BackupBlobWriter()) {
  return entry.getData(writer, {
    useWebWorkers: false, checkSignature: true, checkOverlappingEntry: true, checkAmbiguity: true,
  });
}

// A stored entry is a range of the archive. zip.js checks its CRC without
// keeping the bytes, then the range is sliced from the archive itself, so a
// restore never copies the backup into memory or Blob storage (#577).
async function entryData(archive, entry) {
  await readEntry(entry, new Writer());
  const header = new DataView(await archive.slice(entry.offset, entry.offset + 30).arrayBuffer());
  const start = entry.offset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
  return archive.slice(start, start + entry.uncompressedSize);
}

// A manifest's snapshot and statistics rows in the current shape. Version 1
// has no lookup statistics and versions 1 and 2 no words marked as known or
// ignored; statistics or marked words this version cannot read are skipped
// the same way (#577). prepareBackupSnapshot reads the settings.
function currentSnapshot(manifest) {
  const { emptyWordStatusOverrides, normaliseWordStatusOverrides } = globalThis.HDWordStatusOverrides;
  const snapshot = { ...manifest.snapshot };
  if (manifest.version < 3) snapshot.wordStatusOverrides = emptyWordStatusOverrides();
  else if (snapshot.wordStatusOverrides !== undefined) {
    snapshot.wordStatusOverrides = normaliseWordStatusOverrides(snapshot.wordStatusOverrides);
  }
  try {
    assertLookupStatsRows(snapshot.lookupStats, manifest.lookupStatsRows);
    return { snapshot, lookupStatsRows: manifest.lookupStatsRows };
  } catch {
    return { snapshot: { ...snapshot, lookupStats: emptyLookupStats() }, lookupStatsRows: [] };
  }
}

// A version 4 manifest's `profiles` (docs/languages.md 17.2). Like the
// snapshot's, the lookup rows of a language this version cannot read are
// skipped and its marked words read as a stored record is; the rest is
// validated with the snapshot when the restore is prepared.
function currentProfiles(manifest) {
  if (manifest.version < 4 || manifest.profiles === undefined) return undefined;
  const { profiles } = manifest;
  const plain = value => value && typeof value === "object" && !Array.isArray(value);
  if (!plain(profiles) || !plain(profiles.languages)) return profiles;
  const { normaliseWordStatusOverrides } = globalThis.HDWordStatusOverrides;
  const languages = Object.fromEntries(Object.entries(profiles.languages).map(([code, part]) => {
    if (!plain(part)) return [code, part];
    const next = { ...part };
    if (next.lookupStatsRows !== undefined) {
      try {
        assertLookupStatsRows({ generation: code, revision: 0 }, next.lookupStatsRows);
      } catch {
        delete next.lookupStatsRows;
      }
    }
    if (next.wordStatusOverrides !== undefined) {
      const { known, ignored } = normaliseWordStatusOverrides(next.wordStatusOverrides);
      next.wordStatusOverrides = { known, ignored };
    }
    return [code, next];
  }));
  return { ...profiles, languages };
}

export async function openBackupArchive(blob) {
  const reader = new ZipReader(new BlobReader(blob), { useWebWorkers: false, checkAmbiguity: true });
  try {
    const entries = await reader.getEntries();
    const byPath = new Map();
    for (const entry of entries) {
      assertRegularEntry(entry);
      if (byPath.has(entry.filename)) throw new Error(`Duplicate backup file: ${entry.filename}`);
      byPath.set(entry.filename, entry);
    }
    const manifestEntry = byPath.get(MANIFEST);
    if (!manifestEntry) throw new Error("The selected archive is not a Hachidori backup.");
    const manifest = JSON.parse(await (await readEntry(manifestEntry)).text());
    // Any version: a newer one is read like this one, skipping what it added.
    if (manifest?.format !== "hachidori-backup" || !Number.isSafeInteger(manifest.version) || manifest.version < 1
        || typeof manifest.createdAt !== "string" || Number.isNaN(Date.parse(manifest.createdAt))) {
      throw new Error("The selected archive is not a supported Hachidori backup.");
    }
    const { snapshot, lookupStatsRows } = currentSnapshot(manifest);
    const profiles = currentProfiles(manifest);
    assertFileList(manifest.files);
    if (entries.length !== manifest.files.length + 1) throw new Error("The backup contains unlisted or missing files.");
    const files = [];
    for (const file of manifest.files) {
      const entry = byPath.get(file.path);
      if (!entry) throw new Error(`The backup is missing ${file.path}`);
      if (entry.uncompressedSize !== file.size) throw new Error(`Incorrect backup file size: ${file.path}`);
      const data = await entryData(blob, entry); // NOSONAR: one entry's CRC is checked at a time
      if (data.size !== file.size) throw new Error(`Incorrect extracted backup file size: ${file.path}`);
      files.push({ path: file.path, data });
    }
    return { snapshot, lookupStatsRows, createdAt: manifest.createdAt, files, ...(profiles === undefined ? {} : { profiles }) };
  } finally {
    await reader.close();
  }
}
