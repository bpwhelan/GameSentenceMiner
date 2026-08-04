import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requireModule = createRequire(import.meta.url);
const {
  HoshiDictsImportManager,
  HoshiDictsImportError,
  copySourceNoFollow,
} = requireModule("../../../GSM_Overlay/hoshidicts_import_manager.js");
const {
  HoshiDictsClient,
} = requireModule("../../../GSM_Overlay/hoshidicts_client.js");
const {
  HoshiDictsStore,
} = requireModule("../../../GSM_Overlay/hoshidicts_store.js");

const SOURCE_COMMIT = "81e293cde156751e7f38cb040c86eb2c644ee4d2";
const JOB_ID = "01234567-89ab-4def-8123-456789abcdef";

function writeNativeOutput(outputPath: string, marker = "native") {
  fs.mkdirSync(outputPath, { recursive: true });
  fs.writeFileSync(path.join(outputPath, ".hoshidicts_1"), "");
  fs.writeFileSync(
    path.join(outputPath, "index.json"),
    JSON.stringify({ title: "Imported Dictionary", format: 3 }),
  );
  fs.writeFileSync(path.join(outputPath, "hash.table"), `hash-${marker}`);
  fs.writeFileSync(path.join(outputPath, "blobs.bin"), `blobs-${marker}`);
}

class FakeImportClient extends EventEmitter {
  forceKilled = false;
  shutdownCalled = false;
  importCalls = 0;
  probeCalls = 0;
  pendingReject: ((error: Error) => void) | null = null;

  constructor(
    private readonly behavior: "success" | "hang" | "crash" | "bad-probe" = "success",
  ) {
    super();
  }

  async start() {
    return {
      protocol: { major: 1, minor: 0 },
      hostVersion: "0.1.0",
      hoshidictsCommit: SOURCE_COMMIT,
      capabilities: ["import", "probe"],
    };
  }

  request(method: string, params: Record<string, unknown>) {
    if (method === "dictionary.import") {
      this.importCalls += 1;
      this.emit("host-event", {
        event: "import.progress",
        jobId: params.jobId,
        phase: "native-import",
        completed: 0,
        total: 1,
      });
      if (this.behavior === "hang") {
        return new Promise((_resolve, reject) => {
          this.pendingReject = reject;
        });
      }
      if (this.behavior === "crash") {
        return Promise.reject(Object.assign(new Error("worker crashed"), { code: "HOST_EXITED" }));
      }
      writeNativeOutput(String(params.outputPath));
      return Promise.resolve({
        jobId: params.jobId,
        title: "Imported Dictionary",
        types: ["term", "kanji"],
        formatRevision: 3,
        outputPath: params.outputPath,
        termCount: 1,
        metadataCount: 0,
        kanjiCount: 1,
        mediaCount: 0,
        probeTerm: "食べる",
        probeKanji: "食",
      });
    }
    if (method === "dictionary.probe") {
      this.probeCalls += 1;
      return Promise.resolve({
        loaded: this.behavior !== "bad-probe",
        termProbeMatched: this.behavior !== "bad-probe",
        kanjiProbeMatched: this.behavior !== "bad-probe",
      });
    }
    throw new Error(`unexpected method ${method}`);
  }

  async shutdown() {
    this.shutdownCalled = true;
  }

  forceKill() {
    this.forceKilled = true;
    this.pendingReject?.(
      Object.assign(new Error("worker killed"), { code: "HOST_EXITED" }),
    );
    this.pendingReject = null;
  }
}

function successfulInspection() {
  return {
    archiveSizeBytes: 128,
    entryCount: 2,
    compressedSizeBytes: 64,
    expandedSizeBytes: 256,
    requiredFreeBytes: 1024,
    hasIndex: true,
    types: ["term", "kanji"],
  };
}

describe("HoshiDictsImportManager", () => {
  let dataPath: string;
  let sourcePath: string;

  beforeEach(() => {
    dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "gsm-hoshi-import-"));
    sourcePath = path.join(dataPath, "selected.zip");
    fs.writeFileSync(sourcePath, "selected archive bytes");
  });

  afterEach(() => {
    fs.rmSync(dataPath, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("copies, hashes, inspects, imports, probes, and publishes without retaining the ZIP", async () => {
    const store = new HoshiDictsStore(dataPath);
    const client = new FakeImportClient();
    const inspectArchive = vi.fn(async (stagedPath: string) => {
      expect(path.basename(stagedPath)).toBe("source.zip");
      expect(fs.readFileSync(stagedPath, "utf8")).toBe("selected archive bytes");
      return successfulInspection();
    });
    const manager = new HoshiDictsImportManager({
      store,
      createClient: () => client,
      inspectArchive,
      statfs: async () => ({ bavail: 10_000n, bsize: 4096n }),
    });
    const progress: Array<Record<string, unknown>> = [];
    manager.on("progress", (event: Record<string, unknown>) => progress.push(event));

    const result = await manager.importDictionary(sourcePath, { jobId: JOB_ID });

    expect(result.status).toBe("imported");
    expect(result.entry.sourceSha256).toBe(
      crypto.createHash("sha256").update("selected archive bytes").digest("hex"),
    );
    expect(result.entry.sourceFilename).toBe("selected.zip");
    expect(client.importCalls).toBe(1);
    expect(client.probeCalls).toBe(1);
    expect(client.shutdownCalled).toBe(true);
    expect(inspectArchive).toHaveBeenCalledOnce();
    expect(progress.map((event) => event.phase)).toEqual(
      expect.arrayContaining(["copy", "inspect", "native-import", "probe", "publish"]),
    );
    expect(
      fs.existsSync(path.join(store.rootPath, "staging", JOB_ID, "source.zip")),
    ).toBe(false);
  });

  it("rejects insufficient free space before spawning the native worker", async () => {
    const store = new HoshiDictsStore(dataPath);
    const createClient = vi.fn(() => new FakeImportClient());
    const manager = new HoshiDictsImportManager({
      store,
      createClient,
      inspectArchive: async () => ({ ...successfulInspection(), requiredFreeBytes: 5000 }),
      statfs: async () => ({ bavail: 1n, bsize: 1000n }),
    });

    await expect(
      manager.importDictionary(sourcePath, { jobId: JOB_ID }),
    ).rejects.toMatchObject({
      name: "HoshiDictsImportError",
      code: "IMPORT_OUT_OF_SPACE",
    });
    expect(createClient).not.toHaveBeenCalled();
    expect((await store.getManifest()).dictionaries).toEqual([]);
  });

  it("offers duplicate reuse without rerunning the native import", async () => {
    const store = new HoshiDictsStore(dataPath);
    const firstClient = new FakeImportClient();
    const first = new HoshiDictsImportManager({
      store,
      createClient: () => firstClient,
      inspectArchive: async () => successfulInspection(),
      statfs: async () => ({ bavail: 10_000n, bsize: 4096n }),
    });
    const imported = await first.importDictionary(sourcePath, { jobId: JOB_ID });

    const secondClient = new FakeImportClient();
    const second = new HoshiDictsImportManager({
      store,
      createClient: () => secondClient,
      inspectArchive: async () => successfulInspection(),
      statfs: async () => ({ bavail: 10_000n, bsize: 4096n }),
    });
    const reused = await second.importDictionary(sourcePath, {
      jobId: "11234567-89ab-4def-8123-456789abcdef",
      duplicatePolicy: "reuse",
    });

    expect(reused).toMatchObject({
      status: "reused",
      entry: { id: imported.entry.id },
    });
    expect(secondClient.importCalls).toBe(0);
  });

  it("kills only the dedicated worker on cancellation and preserves the catalog", async () => {
    const store = new HoshiDictsStore(dataPath);
    const client = new FakeImportClient("hang");
    const manager = new HoshiDictsImportManager({
      store,
      createClient: () => client,
      inspectArchive: async () => successfulInspection(),
      statfs: async () => ({ bavail: 10_000n, bsize: 4096n }),
    });
    let reachedWorker = () => {};
    const workerStarted = new Promise<void>((resolve) => {
      reachedWorker = resolve;
    });
    manager.on("progress", (event: { phase: string }) => {
      if (event.phase === "native-import") {
        reachedWorker();
      }
    });

    const pending = manager.importDictionary(sourcePath, { jobId: JOB_ID });
    await workerStarted;
    expect(manager.cancel(JOB_ID)).toBe(true);

    await expect(pending).rejects.toMatchObject({ code: "IMPORT_CANCELLED" });
    expect(client.forceKilled).toBe(true);
    expect((await store.getManifest()).dictionaries).toEqual([]);
    expect(manager.getActiveImports()).toEqual([]);
  });

  it.each(["crash", "bad-probe"] as const)(
    "quarantines staging and preserves the manifest after %s",
    async (behavior) => {
      const store = new HoshiDictsStore(dataPath);
      const manager = new HoshiDictsImportManager({
        store,
        createClient: () => new FakeImportClient(behavior),
        inspectArchive: async () => successfulInspection(),
        statfs: async () => ({ bavail: 10_000n, bsize: 4096n }),
      });

      await expect(
        manager.importDictionary(sourcePath, { jobId: JOB_ID }),
      ).rejects.toBeInstanceOf(HoshiDictsImportError);

      expect((await store.getManifest()).dictionaries).toEqual([]);
      expect(
        fs
          .readdirSync(path.join(store.rootPath, "quarantine"))
          .some((name) => name.includes(JOB_ID)),
      ).toBe(true);
    },
  );

  it("rejects a selected symlink before copying or inspecting it", async () => {
    const target = path.join(dataPath, "target.zip");
    fs.writeFileSync(target, "target");
    const symlink = path.join(dataPath, "symlink.zip");
    fs.symlinkSync(target, symlink);
    const inspectArchive = vi.fn(async () => successfulInspection());
    const manager = new HoshiDictsImportManager({
      store: new HoshiDictsStore(dataPath),
      createClient: () => new FakeImportClient(),
      inspectArchive,
      statfs: async () => ({ bavail: 10_000n, bsize: 4096n }),
    });

    await expect(manager.importDictionary(symlink, { jobId: JOB_ID })).rejects.toMatchObject(
      { code: "SOURCE_PATH_UNSAFE" },
    );
    expect(inspectArchive).not.toHaveBeenCalled();
  });

  it("rejects a regular file replaced after canonical-path validation", async () => {
    const destinationPath = path.join(dataPath, "staged.zip");
    const originalPath = path.join(dataPath, "original.zip");
    const originalOpen = fs.promises.open.bind(fs.promises);
    let replaced = false;
    vi.spyOn(fs.promises, "open").mockImplementation(
      (async (filePath: fs.PathLike, ...args: unknown[]) => {
        if (!replaced && path.resolve(String(filePath)) === path.resolve(sourcePath)) {
          replaced = true;
          fs.renameSync(sourcePath, originalPath);
          fs.writeFileSync(sourcePath, "replacement archive bytes");
        }
        return originalOpen(filePath, ...(args as [number, number?]));
      }) as typeof fs.promises.open,
    );

    await expect(
      copySourceNoFollow(sourcePath, destinationPath),
    ).rejects.toMatchObject({
      code: "SOURCE_CHANGED",
    });
  });
});

const realHostCandidates = [
  process.env.GSM_HOSHIDICTS_HOST_PATH,
  path.resolve("build/hoshidicts-goal2/hoshidicts-host"),
  path.resolve("build/hoshidicts-provenance/hoshidicts-host"),
].filter((candidate): candidate is string => Boolean(candidate));
const realHostPath = realHostCandidates.find((candidate) => fs.existsSync(candidate));
const fixtureCandidates = [
  path.resolve("build/hoshidicts-goal2/fixtures/gsm-hoshi-fixture.zip"),
  path.resolve("build/hoshidicts-provenance/fixtures/gsm-hoshi-fixture.zip"),
];
const fixturePath = fixtureCandidates.find((candidate) => fs.existsSync(candidate));

it.skipIf(!realHostPath || !fixturePath)(
  "imports and probes the generated fixture through the real native worker",
  async () => {
    const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "gsm-hoshi-real-import-"));
    try {
      const selectedPath = path.join(dataPath, "fixture.zip");
      fs.copyFileSync(fixturePath!, selectedPath);
      const store = new HoshiDictsStore(dataPath);
      const manager = new HoshiDictsImportManager({
        store,
        createClient: () =>
          new HoshiDictsClient({
            executablePath: realHostPath,
            clientVersion: "vitest",
          }),
      });

      const imported = await manager.importDictionary(selectedPath, {
        jobId: JOB_ID,
        lowRam: true,
      });

      expect(imported).toMatchObject({
        status: "imported",
        entry: {
          title: "GSM Hoshi Fixture",
          types: ["term", "frequency", "pitch", "kanji"],
          formatRevision: 3,
          health: "ready",
        },
      });
    } finally {
      fs.rmSync(dataPath, { recursive: true, force: true });
    }
  },
);
