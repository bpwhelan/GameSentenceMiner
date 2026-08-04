import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const requireModule = createRequire(import.meta.url);
const {
  HoshiDictsManifestError,
  HoshiDictsManifestStore,
  createEmptyManifest,
  resolveStoreRelativePath,
  validateManifest,
} = requireModule("../../../GSM_Overlay/hoshidicts_manifest.js");

const SOURCE_COMMIT = "81e293cde156751e7f38cb040c86eb2c644ee4d2";

function dictionaryEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "01234567-89ab-4def-8123-456789abcdef",
    title: "Fixture dictionary",
    types: ["term", "kanji"],
    formatRevision: 3,
    sourceSha256: "a".repeat(64),
    sourceFilename: "fixture.zip",
    importedAt: "2026-08-04T00:00:00.000Z",
    hostVersion: "0.1.0",
    hoshidictsCommit: SOURCE_COMMIT,
    relativePath:
      "dictionaries/01234567-89ab-4def-8123-456789abcdef/current/import-1",
    sizeBytes: 1234,
    health: "ready",
    ...overrides,
  };
}

describe("HoshiDicts manifest validation", () => {
  it("accepts a complete manifest and returns a detached normalized copy", () => {
    const source = {
      schemaVersion: 1,
      revision: 7,
      dictionaries: [dictionaryEntry()],
    };

    const validated = validateManifest(source);

    expect(validated).toEqual(source);
    expect(validated).not.toBe(source);
    expect(validated.dictionaries).not.toBe(source.dictionaries);
  });

  it.each([
    "../outside",
    "dictionaries/../outside",
    "/absolute/path",
    "C:/outside",
    "\\\\server\\share",
    "dictionaries\\id\\current",
    "dictionaries//id",
    "dictionaries/./id",
    "",
  ])("rejects unsafe relative paths: %s", (relativePath) => {
    const manifest = {
      schemaVersion: 1,
      revision: 1,
      dictionaries: [dictionaryEntry({ relativePath })],
    };

    expect(() => validateManifest(manifest)).toThrow(HoshiDictsManifestError);
  });

  it("rejects duplicate IDs, duplicate types, and malformed source hashes", () => {
    const duplicateId = {
      schemaVersion: 1,
      revision: 1,
      dictionaries: [dictionaryEntry(), dictionaryEntry({ title: "Other" })],
    };
    expect(() => validateManifest(duplicateId)).toThrow(/dictionary ids must be unique/i);

    const duplicateType = {
      schemaVersion: 1,
      revision: 1,
      dictionaries: [dictionaryEntry({ types: ["term", "term"] })],
    };
    expect(() => validateManifest(duplicateType)).toThrow(/types must be unique/i);

    const malformedHash = {
      schemaVersion: 1,
      revision: 1,
      dictionaries: [dictionaryEntry({ sourceSha256: "../../secret" })],
    };
    expect(() => validateManifest(malformedHash)).toThrow(/sha256/i);
  });

  it("resolves only normalized paths contained by the store", () => {
    const root = path.resolve(os.tmpdir(), "hoshidicts-store-root");
    expect(resolveStoreRelativePath(root, "dictionaries/id/current")).toBe(
      path.join(root, "dictionaries", "id", "current"),
    );
    expect(() => resolveStoreRelativePath(root, "../outside")).toThrow(
      HoshiDictsManifestError,
    );
  });
});

describe("HoshiDictsManifestStore", () => {
  let storeRoot: string;

  beforeEach(() => {
    storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gsm-hoshi-manifest-"));
  });

  afterEach(() => {
    fs.rmSync(storeRoot, { recursive: true, force: true });
  });

  it("commits monotonic revisions and retains the prior manifest as backup", async () => {
    const store = new HoshiDictsManifestStore(storeRoot);
    await expect(store.load()).resolves.toMatchObject({
      manifest: createEmptyManifest(),
      recoveredFromBackup: false,
    });

    const first = {
      schemaVersion: 1,
      revision: 1,
      dictionaries: [dictionaryEntry()],
    };
    await store.commit(first, { expectedRevision: 0 });
    expect(
      JSON.parse(fs.readFileSync(path.join(storeRoot, "manifest.json.backup"), "utf8")),
    ).toEqual(createEmptyManifest());

    const second = {
      schemaVersion: 1,
      revision: 2,
      dictionaries: [
        dictionaryEntry({ sizeBytes: 5678, importedAt: "2026-08-04T01:00:00.000Z" }),
      ],
    };
    await store.commit(second, { expectedRevision: 1 });

    expect(JSON.parse(fs.readFileSync(path.join(storeRoot, "manifest.json"), "utf8"))).toEqual(
      second,
    );
    expect(
      JSON.parse(fs.readFileSync(path.join(storeRoot, "manifest.json.backup"), "utf8")),
    ).toEqual(first);

    await expect(store.commit(second, { expectedRevision: 1 })).rejects.toThrow(
      /revision/i,
    );
  });

  it("recovers a corrupt first manifest from the durable empty backup", async () => {
    const store = new HoshiDictsManifestStore(storeRoot);
    const first = {
      schemaVersion: 1,
      revision: 1,
      dictionaries: [dictionaryEntry()],
    };
    await store.commit(first, { expectedRevision: 0 });
    fs.writeFileSync(path.join(storeRoot, "manifest.json"), "{broken");

    await expect(store.load()).resolves.toMatchObject({
      manifest: createEmptyManifest(),
      recoveredFromBackup: true,
    });
  });

  it("serializes competing commits so the revision check cannot race", async () => {
    let releaseFirstCommit = () => {};
    let reportFirstCommitReady = () => {};
    const firstCommitReady = new Promise<void>((resolve) => {
      reportFirstCommitReady = resolve;
    });
    const firstCommitRelease = new Promise<void>((resolve) => {
      releaseFirstCommit = resolve;
    });
    let primaryRenameCount = 0;
    const store = new HoshiDictsManifestStore(storeRoot, {
      async faultInjector(point: string) {
        if (point === "before-primary-rename" && primaryRenameCount++ === 0) {
          reportFirstCommitReady();
          await firstCommitRelease;
        }
      },
    });
    const first = {
      schemaVersion: 1,
      revision: 1,
      dictionaries: [dictionaryEntry()],
    };
    const competing = {
      schemaVersion: 1,
      revision: 1,
      dictionaries: [dictionaryEntry({ sizeBytes: 4321 })],
    };

    const firstCommit = store.commit(first, { expectedRevision: 0 });
    await firstCommitReady;
    const competingCommit = store.commit(competing, { expectedRevision: 0 });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(primaryRenameCount).toBe(1);
    releaseFirstCommit();

    await expect(firstCommit).resolves.toEqual(first);
    await expect(competingCommit).rejects.toMatchObject({
      code: "MANIFEST_REVISION_CONFLICT",
    });
    await expect(store.load()).resolves.toMatchObject({ manifest: first });
  });

  it("recovers a corrupt primary only from a validated last-known-good backup", async () => {
    const store = new HoshiDictsManifestStore(storeRoot);
    const first = {
      schemaVersion: 1,
      revision: 1,
      dictionaries: [dictionaryEntry()],
    };
    const second = {
      schemaVersion: 1,
      revision: 2,
      dictionaries: [dictionaryEntry({ sizeBytes: 9999 })],
    };
    await store.commit(first, { expectedRevision: 0 });
    await store.commit(second, { expectedRevision: 1 });
    fs.writeFileSync(path.join(storeRoot, "manifest.json"), "{broken");

    const recovered = await store.load();

    expect(recovered).toMatchObject({
      manifest: first,
      recoveredFromBackup: true,
    });
    expect(JSON.parse(fs.readFileSync(path.join(storeRoot, "manifest.json"), "utf8"))).toEqual(
      first,
    );
    expect(
      fs.readdirSync(path.join(storeRoot, "quarantine")).some((name) =>
        name.startsWith("manifest-corrupt-"),
      ),
    ).toBe(true);
  });

  it("fails deterministically when both primary and backup are corrupt", async () => {
    fs.writeFileSync(path.join(storeRoot, "manifest.json"), "{broken");
    fs.writeFileSync(path.join(storeRoot, "manifest.json.backup"), "[]");
    const store = new HoshiDictsManifestStore(storeRoot);

    await expect(store.load()).rejects.toMatchObject({
      name: "HoshiDictsManifestError",
      code: "MANIFEST_UNRECOVERABLE",
    });
  });

  it("preserves the active manifest when publication fails before its rename", async () => {
    const stableStore = new HoshiDictsManifestStore(storeRoot);
    const stable = {
      schemaVersion: 1,
      revision: 1,
      dictionaries: [dictionaryEntry()],
    };
    await stableStore.commit(stable, { expectedRevision: 0 });

    const failingStore = new HoshiDictsManifestStore(storeRoot, {
      faultInjector(point: string) {
        if (point === "before-primary-rename") {
          throw new Error("injected publication failure");
        }
      },
    });
    const replacement = {
      schemaVersion: 1,
      revision: 2,
      dictionaries: [dictionaryEntry({ sizeBytes: 4321 })],
    };

    await expect(
      failingStore.commit(replacement, { expectedRevision: 1 }),
    ).rejects.toThrow(/injected publication failure/);
    await expect(stableStore.load()).resolves.toMatchObject({ manifest: stable });
  });
});
