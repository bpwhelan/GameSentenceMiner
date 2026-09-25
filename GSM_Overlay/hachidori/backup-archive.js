// Hachidori's own stored ZIP64 format; loaded only for explicit backup work.
// SPDX-License-Identifier: GPL-3.0-or-later
import { BlobReader, BlobWriter, ZipReader, ZipWriter } from "./vendor/zip.js";
import { assertLookupStatsRows, emptyLookupStats } from "./lookup-stats.js";

const MANIFEST = "hachidori-backup.json";
const ZIP_OPTIONS = {
  useWebWorkers: false,
  level: 0,
  zip64: true,
  extendedTimestamp: false,
  lastModDate: new Date(1980, 0, 1),
};

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

export async function createBackupArchive(snapshot, files, lookupStatsRows, createdAt = new Date().toISOString()) {
  const entries = files.map(({ path, data }) => ({ path, size: data.size }));
  assertFileList(entries);
  assertLookupStatsRows(snapshot?.lookupStats, lookupStatsRows);
  const manifest = { format: "hachidori-backup", version: 2, createdAt, snapshot, lookupStatsRows, files: entries };
  /** @type {{add(name: string, reader: object): Promise<unknown>, close(): Promise<Blob>}} */
  const writer = new ZipWriter(new BlobWriter("application/zip"), ZIP_OPTIONS);
  await writer.add(MANIFEST, new BlobReader(new Blob([JSON.stringify(manifest)])));
  for (const file of files) await writer.add(file.path, new BlobReader(file.data));
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

function readEntry(entry) {
  return entry.getData(new BlobWriter(), {
    useWebWorkers: false, checkSignature: true, checkOverlappingEntry: true, checkAmbiguity: true,
  });
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
    if (manifest?.format !== "hachidori-backup" || ![1, 2].includes(manifest.version)
        || typeof manifest.createdAt !== "string" || Number.isNaN(Date.parse(manifest.createdAt))) {
      throw new Error("The selected archive is not a supported Hachidori backup.");
    }
    const snapshot = manifest.version === 1 ? { ...manifest.snapshot, lookupStats: emptyLookupStats() } : manifest.snapshot;
    // Older backups include the retired external corpus integration. Drop only
    // those fields before the complete snapshot contract validates the restore.
    delete snapshot?.options?.corpusSeenEnabled;
    delete snapshot?.options?.corpusSeenUrl;
    const lookupStatsRows = manifest.version === 1 ? [] : manifest.lookupStatsRows;
    assertLookupStatsRows(snapshot?.lookupStats, lookupStatsRows);
    assertFileList(manifest.files);
    if (entries.length !== manifest.files.length + 1) throw new Error("The backup contains unlisted or missing files.");
    const files = [];
    for (const file of manifest.files) {
      const entry = byPath.get(file.path);
      if (!entry) throw new Error(`The backup is missing ${file.path}`);
      if (entry.uncompressedSize !== file.size) throw new Error(`Incorrect backup file size: ${file.path}`);
      const data = await readEntry(entry);
      if (data.size !== file.size) throw new Error(`Incorrect extracted backup file size: ${file.path}`);
      files.push({ path: file.path, data });
    }
    return { snapshot, lookupStatsRows, createdAt: manifest.createdAt, files };
  } finally {
    await reader.close();
  }
}
