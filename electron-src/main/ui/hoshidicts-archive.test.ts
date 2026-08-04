import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const requireModule = createRequire(import.meta.url);
const {
  HoshiDictsArchiveError,
  inspectDictionaryArchive,
} = requireModule("../../../GSM_Overlay/hoshidicts_archive.js");

type ZipEntry = {
  name: string;
  data?: Buffer | string;
  method?: number;
  compressedSize?: number;
  uncompressedSize?: number;
  externalAttributes?: number;
  versionMadeBy?: number;
  versionNeeded?: number;
  flags?: number;
  extra?: Buffer;
};

function writeUInt16(value: number) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function writeUInt32(value: number) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
}

function createZip(filePath: string, entries: ZipEntry[]) {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(entry.data ?? "", "utf8");
    const extra = entry.extra ?? Buffer.alloc(0);
    const compressedSize = entry.compressedSize ?? data.length;
    const uncompressedSize = entry.uncompressedSize ?? data.length;
    const method = entry.method ?? 0;
    const flags = entry.flags ?? 0x800;
    const versionNeeded = entry.versionNeeded ?? 20;

    const localHeader = Buffer.concat([
      writeUInt32(0x04034b50),
      writeUInt16(versionNeeded),
      writeUInt16(flags),
      writeUInt16(method),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt32(0),
      writeUInt32(compressedSize),
      writeUInt32(uncompressedSize),
      writeUInt16(name.length),
      writeUInt16(extra.length),
      name,
      extra,
      data,
    ]);
    localParts.push(localHeader);

    const centralHeader = Buffer.concat([
      writeUInt32(0x02014b50),
      writeUInt16(entry.versionMadeBy ?? 0x0314),
      writeUInt16(versionNeeded),
      writeUInt16(flags),
      writeUInt16(method),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt32(0),
      writeUInt32(compressedSize),
      writeUInt32(uncompressedSize),
      writeUInt16(name.length),
      writeUInt16(extra.length),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt32(entry.externalAttributes ?? 0),
      writeUInt32(localOffset),
      name,
      extra,
    ]);
    centralParts.push(centralHeader);
    localOffset += localHeader.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.concat([
    writeUInt32(0x06054b50),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt16(entries.length),
    writeUInt16(entries.length),
    writeUInt32(centralDirectory.length),
    writeUInt32(localOffset),
    writeUInt16(0),
  ]);
  fs.writeFileSync(filePath, Buffer.concat([...localParts, centralDirectory, end]));
}

function baseEntries(): ZipEntry[] {
  return [
    { name: "index.json", data: "{}" },
    { name: "term_bank_1.json", data: "[]" },
    { name: "term_meta_bank_1.json", data: "[]" },
    { name: "kanji_bank_1.json", data: "[]" },
    { name: "styles.css", data: "body{}" },
  ];
}

describe("inspectDictionaryArchive", () => {
  let directory: string;
  let archivePath: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "gsm-hoshi-archive-"));
    archivePath = path.join(directory, "dictionary.zip");
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("reports bounded archive metadata without extracting", async () => {
    createZip(archivePath, baseEntries());

    const inspection = await inspectDictionaryArchive(archivePath);

    expect(inspection).toMatchObject({
      entryCount: 5,
      types: ["term", "frequency", "pitch", "kanji"],
      hasIndex: true,
    });
    expect(inspection.compressedSizeBytes).toBeGreaterThan(0);
    expect(inspection.expandedSizeBytes).toBeGreaterThan(0);
    expect(inspection.requiredFreeBytes).toBeGreaterThan(inspection.expandedSizeBytes);
  });

  it.each([
    "../outside.json",
    "nested/../../outside.json",
    "/absolute.json",
    "C:/outside.json",
    "\\\\server\\share.json",
    "nested\\outside.json",
  ])("rejects an escaping entry path: %s", async (name) => {
    createZip(archivePath, [...baseEntries(), { name, data: "x" }]);

    await expect(inspectDictionaryArchive(archivePath)).rejects.toMatchObject({
      name: "HoshiDictsArchiveError",
      code: "ZIP_PATH_TRAVERSAL",
    });
  });

  it("rejects symlinks and duplicate normalized names", async () => {
    const symlinkMode = 0o120777 << 16;
    createZip(archivePath, [
      ...baseEntries(),
      {
        name: "media/link",
        data: "target",
        versionMadeBy: 0x0314,
        externalAttributes: symlinkMode,
      },
    ]);
    await expect(inspectDictionaryArchive(archivePath)).rejects.toMatchObject({
      code: "ZIP_SYMLINK",
    });

    createZip(archivePath, [
      ...baseEntries(),
      { name: "Media/Picture.png", data: "one" },
      { name: "media/picture.png", data: "two" },
    ]);
    await expect(inspectDictionaryArchive(archivePath)).rejects.toMatchObject({
      code: "ZIP_DUPLICATE_ENTRY",
    });
  });

  it("rejects an entry name large enough to consume excessive metadata memory", async () => {
    createZip(archivePath, [
      ...baseEntries(),
      { name: `media/${"a".repeat(5000)}.png`, data: "x" },
    ]);

    await expect(inspectDictionaryArchive(archivePath)).rejects.toMatchObject({
      code: "ZIP_PATH_TOO_LONG",
    });
  });

  it("rejects entry-count, per-entry, expanded-size, and compression-ratio bombs", async () => {
    createZip(archivePath, baseEntries());
    await expect(
      inspectDictionaryArchive(archivePath, { maxEntries: 4 }),
    ).rejects.toMatchObject({ code: "ZIP_ENTRY_LIMIT" });

    createZip(archivePath, [
      ...baseEntries(),
      {
        name: "media/giant.bin",
        data: "x",
        method: 8,
        compressedSize: 1,
        uncompressedSize: 5000,
      },
    ]);
    await expect(
      inspectDictionaryArchive(archivePath, {
        maxEntryBytes: 4000,
        maxExpandedBytes: 10_000,
        maxCompressionRatio: 10_000,
      }),
    ).rejects.toMatchObject({ code: "ZIP_ENTRY_TOO_LARGE" });
    await expect(
      inspectDictionaryArchive(archivePath, {
        maxEntryBytes: 10_000,
        maxExpandedBytes: 4000,
        maxCompressionRatio: 10_000,
      }),
    ).rejects.toMatchObject({ code: "ZIP_EXPANDED_TOO_LARGE" });
    await expect(
      inspectDictionaryArchive(archivePath, {
        maxEntryBytes: 10_000,
        maxExpandedBytes: 10_000,
        maxCompressionRatio: 100,
      }),
    ).rejects.toMatchObject({ code: "ZIP_COMPRESSION_RATIO" });
  });

  it("rejects encrypted, unsupported-compression, and ZIP64 entries", async () => {
    createZip(archivePath, [
      ...baseEntries(),
      {
        name: "encrypted.bin",
        data: Buffer.alloc(13),
        compressedSize: 13,
        uncompressedSize: 1,
        flags: 0x801,
      },
    ]);
    await expect(inspectDictionaryArchive(archivePath)).rejects.toMatchObject({
      code: "ZIP_ENCRYPTED",
    });

    createZip(archivePath, [
      ...baseEntries(),
      { name: "unsupported.bin", data: "x", method: 12 },
    ]);
    await expect(inspectDictionaryArchive(archivePath)).rejects.toMatchObject({
      code: "ZIP_COMPRESSION_UNSUPPORTED",
    });

    const zip64Extra = Buffer.concat([
      writeUInt16(0x0001),
      writeUInt16(8),
      Buffer.alloc(8),
    ]);
    createZip(archivePath, [
      ...baseEntries(),
      {
        name: "zip64.bin",
        data: "x",
        versionNeeded: 45,
        extra: zip64Extra,
      },
    ]);
    await expect(inspectDictionaryArchive(archivePath)).rejects.toMatchObject({
      code: "ZIP64_UNSUPPORTED",
    });
  });

  it("rejects archives without a root index or supported bank", async () => {
    createZip(archivePath, [{ name: "nested/index.json", data: "{}" }]);
    await expect(inspectDictionaryArchive(archivePath)).rejects.toBeInstanceOf(
      HoshiDictsArchiveError,
    );

    createZip(archivePath, [{ name: "index.json", data: "{}" }]);
    await expect(inspectDictionaryArchive(archivePath)).rejects.toMatchObject({
      code: "UNSUPPORTED_DICTIONARY_TYPE",
    });
  });
});
