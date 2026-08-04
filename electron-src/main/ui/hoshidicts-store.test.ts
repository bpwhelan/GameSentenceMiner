import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const requireModule = createRequire(import.meta.url);
const {
  HoshiDictsStore,
  HoshiDictsStoreError,
} = requireModule("../../../GSM_Overlay/hoshidicts_store.js");

const SOURCE_COMMIT = "81e293cde156751e7f38cb040c86eb2c644ee4d2";

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    title: "Fixture Dictionary",
    types: ["term", "kanji"],
    formatRevision: 3,
    sourceSha256: "a".repeat(64),
    sourceFilename: "fixture.zip",
    hostVersion: "0.1.0",
    hoshidictsCommit: SOURCE_COMMIT,
    ...overrides,
  };
}

function writeNativeOutput(outputPath: string, marker = "first") {
  fs.mkdirSync(outputPath, { recursive: true });
  fs.writeFileSync(path.join(outputPath, ".hoshidicts_1"), "");
  fs.writeFileSync(
    path.join(outputPath, "index.json"),
    JSON.stringify({ title: "Fixture Dictionary", format: 3 }),
  );
  fs.writeFileSync(path.join(outputPath, "hash.table"), `hash-${marker}`);
  fs.writeFileSync(path.join(outputPath, "blobs.bin"), `blobs-${marker}`);
}

describe("HoshiDictsStore", () => {
  let dataPath: string;

  beforeEach(() => {
    dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "gsm-hoshi-store-"));
  });

  afterEach(() => {
    fs.rmSync(dataPath, { recursive: true, force: true });
  });

  it("roots all state under dataPath/hoshidicts and quarantines abandoned staging jobs", async () => {
    const store = new HoshiDictsStore(dataPath);
    const active = await store.createImportJob();
    const abandoned = await store.createImportJob();

    const initialized = await store.initialize({
      activeJobIds: new Set([active.id]),
    });

    expect(store.rootPath).toBe(path.join(dataPath, "hoshidicts"));
    expect(fs.existsSync(active.rootPath)).toBe(true);
    expect(fs.existsSync(abandoned.rootPath)).toBe(false);
    expect(initialized.cleanedJobIds).toEqual([abandoned.id]);
    expect(
      fs
        .readdirSync(path.join(store.rootPath, "quarantine"))
        .some((name) => name.includes(abandoned.id)),
    ).toBe(true);
  });

  it("publishes a validated output under an opaque ID and does not retain the ZIP", async () => {
    const store = new HoshiDictsStore(dataPath);
    const job = await store.createImportJob();
    fs.writeFileSync(job.sourcePath, "source archive");
    writeNativeOutput(job.outputPath);

    const published = await store.publishImport(job.id, metadata());
    const loaded = await store.getManifest();

    expect(published.entry.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(published.entry.relativePath).toContain(published.entry.id);
    expect(published.entry.relativePath).not.toContain("Fixture Dictionary");
    expect(loaded.revision).toBe(1);
    expect(loaded.dictionaries).toEqual([published.entry]);
    expect(fs.existsSync(job.sourcePath)).toBe(false);
    expect(fs.existsSync(path.join(store.rootPath, published.entry.relativePath))).toBe(
      true,
    );
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(store.rootPath, published.entry.relativePath, "source.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      sourceSha256: "a".repeat(64),
      sourceFilename: "fixture.zip",
    });
  });

  it("reimports with the stable ID and keeps the old version active until commit", async () => {
    let failPublication = false;
    const store = new HoshiDictsStore(dataPath, {
      manifestOptions: {
        faultInjector(point: string) {
          if (failPublication && point === "before-primary-rename") {
            throw new Error("injected commit failure");
          }
        },
      },
    });
    const firstJob = await store.createImportJob();
    writeNativeOutput(firstJob.outputPath, "first");
    const first = await store.publishImport(firstJob.id, metadata());
    const firstPath = path.join(store.rootPath, first.entry.relativePath);

    const failedJob = await store.createImportJob();
    writeNativeOutput(failedJob.outputPath, "failed");
    failPublication = true;
    await expect(
      store.publishImport(
        failedJob.id,
        metadata({ sourceSha256: "b".repeat(64) }),
        { dictionaryId: first.entry.id },
      ),
    ).rejects.toThrow(/injected commit failure/);
    failPublication = false;

    expect((await store.getManifest()).dictionaries[0]).toEqual(first.entry);
    expect(fs.existsSync(firstPath)).toBe(true);

    const secondJob = await store.createImportJob();
    writeNativeOutput(secondJob.outputPath, "second");
    const second = await store.publishImport(
      secondJob.id,
      metadata({ sourceSha256: "c".repeat(64) }),
      { dictionaryId: first.entry.id },
    );

    expect(second.entry.id).toBe(first.entry.id);
    expect(second.entry.relativePath).not.toBe(first.entry.relativePath);
    expect(fs.existsSync(firstPath)).toBe(false);
    expect(
      fs
        .readdirSync(path.join(store.rootPath, "quarantine"))
        .some((name) => name.includes(first.entry.id)),
    ).toBe(true);
    expect(
      fs.readFileSync(
        path.join(store.rootPath, second.entry.relativePath, "blobs.bin"),
        "utf8",
      ),
    ).toBe("blobs-second");
  });

  it("allows title collisions, detects duplicate hashes, and calculates usage from metadata", async () => {
    const store = new HoshiDictsStore(dataPath);
    const firstJob = await store.createImportJob();
    writeNativeOutput(firstJob.outputPath, "one");
    const first = await store.publishImport(firstJob.id, metadata());

    const secondJob = await store.createImportJob();
    writeNativeOutput(secondJob.outputPath, "two");
    const second = await store.publishImport(
      secondJob.id,
      metadata({ sourceSha256: "b".repeat(64) }),
    );

    expect(second.entry.id).not.toBe(first.entry.id);
    const listed = await store.listDictionaries();
    expect(listed.map((entry: { displayTitle: string }) => entry.displayTitle)).toEqual([
      expect.stringContaining(first.entry.id.slice(0, 8)),
      expect.stringContaining(second.entry.id.slice(0, 8)),
    ]);
    await expect(store.findBySourceHash("a".repeat(64))).resolves.toEqual([
      first.entry,
    ]);
    await expect(store.getStorageUsage()).resolves.toEqual({
      activeBytes: first.entry.sizeBytes + second.entry.sizeBytes,
      dictionaryCount: 2,
    });
  });

  it("builds an enabled ordered catalog and marks incompatible indexes for reimport", async () => {
    const store = new HoshiDictsStore(dataPath);
    const firstJob = await store.createImportJob();
    writeNativeOutput(firstJob.outputPath, "one");
    const first = await store.publishImport(firstJob.id, metadata());
    const secondJob = await store.createImportJob();
    writeNativeOutput(secondJob.outputPath, "two");
    const second = await store.publishImport(
      secondJob.id,
      metadata({ title: "Second", sourceSha256: "b".repeat(64) }),
    );

    const catalog = await store.buildCatalog({
      order: [second.entry.id, first.entry.id],
      enabled: { [first.entry.id]: true, [second.entry.id]: false },
      hostVersion: "0.1.0",
      hoshidictsCommit: SOURCE_COMMIT,
    });
    expect(catalog.dictionaries).toHaveLength(1);
    expect(catalog.dictionaries[0]).toMatchObject({
      id: first.entry.id,
      title: first.entry.title,
      priority: 0,
    });

    const incompatible = await store.buildCatalog({
      order: [first.entry.id],
      enabled: { [first.entry.id]: true },
      hostVersion: "99.0.0",
      hoshidictsCommit: SOURCE_COMMIT,
    });
    expect(incompatible.dictionaries).toEqual([]);
    expect(incompatible.reindexRequired).toEqual([
      first.entry.id,
      second.entry.id,
    ]);
  });

  it("removes manifest state before moving dictionary data to quarantine", async () => {
    const store = new HoshiDictsStore(dataPath);
    const job = await store.createImportJob();
    writeNativeOutput(job.outputPath);
    const published = await store.publishImport(job.id, metadata());

    const removed = await store.removeDictionary(published.entry.id);

    expect((await store.getManifest()).dictionaries).toEqual([]);
    expect(removed.pendingDeletion).toBe(false);
    expect(fs.existsSync(path.join(store.rootPath, published.entry.relativePath))).toBe(
      false,
    );
    expect(fs.existsSync(removed.quarantinePath)).toBe(true);
  });

  it("rejects unknown reimport IDs and incomplete native output", async () => {
    const store = new HoshiDictsStore(dataPath);
    const incomplete = await store.createImportJob();
    fs.mkdirSync(incomplete.outputPath);

    await expect(store.publishImport(incomplete.id, metadata())).rejects.toBeInstanceOf(
      HoshiDictsStoreError,
    );

    const complete = await store.createImportJob();
    writeNativeOutput(complete.outputPath);
    await expect(
      store.publishImport(complete.id, metadata(), {
        dictionaryId: "01234567-89ab-4def-8123-456789abcdef",
      }),
    ).rejects.toMatchObject({ code: "DICTIONARY_NOT_FOUND" });
  });

  it("validates manifest metadata before moving output into dictionaries", async () => {
    const store = new HoshiDictsStore(dataPath);
    const job = await store.createImportJob();
    writeNativeOutput(job.outputPath);

    await expect(
      store.publishImport(job.id, metadata({ sourceFilename: "../outside.zip" })),
    ).rejects.toThrow(/source filename/i);

    expect(fs.readdirSync(store.dictionariesPath)).toEqual([]);
    expect(fs.existsSync(job.outputPath)).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "rejects an internal dictionary-directory symlink before publication",
    async () => {
      const dictionaryId = "21234567-89ab-4def-8123-456789abcdef";
      const store = new HoshiDictsStore(dataPath, {
        randomUUID: () => dictionaryId,
      });
      const job = await store.createImportJob({
        jobId: "31234567-89ab-4def-8123-456789abcdef",
      });
      writeNativeOutput(job.outputPath);
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "gsm-hoshi-outside-"));
      fs.symlinkSync(outside, path.join(store.dictionariesPath, dictionaryId));

      try {
        await expect(store.publishImport(job.id, metadata())).rejects.toMatchObject({
          code: "STORE_PATH_UNSAFE",
        });
        expect(fs.readdirSync(outside)).toEqual([]);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    },
  );
});
