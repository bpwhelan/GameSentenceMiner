"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { HoshiDictsClient } = require("./hoshidicts_client.js");
const { inspectDictionaryArchive } = require("./hoshidicts_archive.js");

const COPY_BUFFER_BYTES = 1024 * 1024;
const SUPPORTED_TYPES = new Set(["term", "frequency", "pitch", "kanji"]);

class HoshiDictsImportError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "HoshiDictsImportError";
    this.code = code;
    this.jobId = options.jobId || null;
    this.details = options.details || null;
  }
}

function importError(code, message, options) {
  return new HoshiDictsImportError(code, message, options);
}

function pathsEqual(left, right) {
  const normalize = (value) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
  };
  return normalize(left) === normalize(right);
}

function throwIfAborted(signal, jobId) {
  if (signal?.aborted) {
    throw importError("IMPORT_CANCELLED", "Dictionary import was cancelled", {
      jobId,
    });
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.promises.open(directory, "r");
    await handle.sync();
  } catch (error) {
    const unsupported =
      process.platform === "win32" &&
      ["EACCES", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"].includes(error && error.code);
    if (!unsupported) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

async function copySourceNoFollow(sourcePath, destinationPath, options = {}) {
  const jobId = options.jobId || null;
  throwIfAborted(options.signal, jobId);
  const resolvedSource = path.resolve(sourcePath);
  let sourceStat;
  let canonicalSource;
  try {
    sourceStat = await fs.promises.lstat(resolvedSource);
    canonicalSource = await fs.promises.realpath(resolvedSource);
  } catch (error) {
    throw importError("SOURCE_UNREADABLE", "Selected dictionary ZIP cannot be read", {
      cause: error,
      jobId,
    });
  }
  if (
    !sourceStat.isFile() ||
    sourceStat.isSymbolicLink() ||
    !pathsEqual(resolvedSource, canonicalSource)
  ) {
    throw importError(
      "SOURCE_PATH_UNSAFE",
      "Selected dictionary ZIP must be a non-symlink regular file",
      { jobId },
    );
  }

  const sourceFilename = path.basename(resolvedSource);
  if (
    !sourceFilename ||
    sourceFilename === "." ||
    sourceFilename === ".." ||
    Buffer.byteLength(sourceFilename, "utf8") > 255
  ) {
    throw importError("SOURCE_FILENAME_INVALID", "Dictionary ZIP filename is invalid", {
      jobId,
    });
  }

  const noFollow = fs.constants.O_NOFOLLOW || 0;
  let sourceHandle;
  let destinationHandle;
  let copiedBytes = 0;
  const hash = crypto.createHash("sha256");
  try {
    sourceHandle = await fs.promises.open(
      resolvedSource,
      fs.constants.O_RDONLY | noFollow,
    );
    const openedStat = await sourceHandle.stat();
    if (
      !openedStat.isFile() ||
      openedStat.dev !== sourceStat.dev ||
      openedStat.ino !== sourceStat.ino ||
      openedStat.size !== sourceStat.size ||
      openedStat.mtimeMs !== sourceStat.mtimeMs
    ) {
      throw importError(
        "SOURCE_CHANGED",
        "Selected dictionary ZIP changed before it could be copied",
        { jobId },
      );
    }
    destinationHandle = await fs.promises.open(
      destinationPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o600,
    );

    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    options.onProgress?.(0, openedStat.size);
    while (copiedBytes < openedStat.size) {
      throwIfAborted(options.signal, jobId);
      const toRead = Math.min(buffer.length, openedStat.size - copiedBytes);
      const { bytesRead } = await sourceHandle.read(
        buffer,
        0,
        toRead,
        copiedBytes,
      );
      if (bytesRead <= 0) {
        throw importError(
          "SOURCE_CHANGED",
          "Selected dictionary ZIP changed while it was being copied",
          { jobId },
        );
      }
      let written = 0;
      while (written < bytesRead) {
        const result = await destinationHandle.write(
          buffer,
          written,
          bytesRead - written,
          copiedBytes + written,
        );
        if (result.bytesWritten <= 0) {
          throw importError("COPY_FAILED", "Unable to stage the dictionary ZIP", {
            jobId,
          });
        }
        written += result.bytesWritten;
      }
      hash.update(buffer.subarray(0, bytesRead));
      copiedBytes += bytesRead;
      options.onProgress?.(copiedBytes, openedStat.size);
    }
    await destinationHandle.sync();

    const finalStat = await sourceHandle.stat();
    if (
      finalStat.size !== openedStat.size ||
      finalStat.mtimeMs !== openedStat.mtimeMs ||
      finalStat.ino !== openedStat.ino ||
      finalStat.dev !== openedStat.dev
    ) {
      throw importError(
        "SOURCE_CHANGED",
        "Selected dictionary ZIP changed while it was being copied",
        { jobId },
      );
    }
  } catch (error) {
    if (error instanceof HoshiDictsImportError) {
      throw error;
    }
    if (error && ["ELOOP", "EMLINK"].includes(error.code)) {
      throw importError("SOURCE_PATH_UNSAFE", "Selected dictionary ZIP is a symlink", {
        cause: error,
        jobId,
      });
    }
    throw importError("COPY_FAILED", "Unable to stage the dictionary ZIP", {
      cause: error,
      jobId,
    });
  } finally {
    await destinationHandle?.close();
    await sourceHandle?.close();
  }

  await syncDirectory(path.dirname(destinationPath));
  return {
    copiedBytes,
    sourceFilename,
    sourceSha256: hash.digest("hex"),
  };
}

function availableBytes(stat) {
  const blocks = stat?.bavail ?? stat?.bfree;
  const blockSize = stat?.bsize;
  if (blocks === undefined || blockSize === undefined) {
    throw importError(
      "FREE_SPACE_UNAVAILABLE",
      "Unable to determine free space for dictionary import",
    );
  }
  try {
    return BigInt(blocks) * BigInt(blockSize);
  } catch (error) {
    throw importError(
      "FREE_SPACE_UNAVAILABLE",
      "Unable to determine free space for dictionary import",
      { cause: error },
    );
  }
}

function validateNativeResult(result, job, jobId) {
  if (!result || typeof result !== "object") {
    throw importError("IMPORT_PROTOCOL_INVALID", "Native import result is invalid", {
      jobId,
    });
  }
  if (result.jobId !== jobId || !pathsEqual(result.outputPath, job.outputPath)) {
    throw importError(
      "PATH_OUTSIDE_STORE",
      "Native import returned an unexpected output path",
      { jobId },
    );
  }
  if (
    typeof result.title !== "string" ||
    result.title.length === 0 ||
    Buffer.byteLength(result.title, "utf8") > 512 ||
    !Number.isSafeInteger(result.formatRevision) ||
    result.formatRevision <= 0 ||
    !Array.isArray(result.types) ||
    result.types.length === 0
  ) {
    throw importError("IMPORT_PROTOCOL_INVALID", "Native import metadata is invalid", {
      jobId,
    });
  }
  const types = [];
  const seen = new Set();
  for (const type of result.types) {
    if (typeof type !== "string" || !SUPPORTED_TYPES.has(type) || seen.has(type)) {
      throw importError("IMPORT_PROTOCOL_INVALID", "Native dictionary types are invalid", {
        jobId,
      });
    }
    seen.add(type);
    types.push(type);
  }
  return {
    ...result,
    types,
    probeTerm: typeof result.probeTerm === "string" ? result.probeTerm : "",
    probeKanji: typeof result.probeKanji === "string" ? result.probeKanji : "",
  };
}

function validateProbeResult(result, imported, jobId) {
  if (!result || result.loaded !== true) {
    throw importError("CATALOG_LOAD_FAILED", "Imported dictionary failed validation", {
      jobId,
    });
  }
  if (imported.types.includes("term") && result.termProbeMatched !== true) {
    throw importError("CATALOG_LOAD_FAILED", "Imported term probe failed", {
      jobId,
    });
  }
  if (imported.types.includes("kanji") && result.kanjiProbeMatched !== true) {
    throw importError("CATALOG_LOAD_FAILED", "Imported kanji probe failed", {
      jobId,
    });
  }
}

function normalizeFailure(error, state) {
  if (state.cancelled || state.controller.signal.aborted) {
    return importError("IMPORT_CANCELLED", "Dictionary import was cancelled", {
      cause: error,
      jobId: state.jobId,
    });
  }
  if (error instanceof HoshiDictsImportError) {
    return error;
  }
  const sourceCode = typeof error?.code === "string" ? error.code : "";
  const stableCode =
    sourceCode === "HOST_EXITED" || sourceCode === "SPAWN_FAILED"
      ? "IMPORT_WORKER_EXITED"
      : sourceCode || "IMPORT_FAILED";
  return importError(stableCode, "Dictionary import failed", {
    cause: error,
    jobId: state.jobId,
  });
}

class HoshiDictsImportManager extends EventEmitter {
  constructor(options = {}) {
    super();
    if (!options.store) {
      throw new TypeError("HoshiDictsImportManager requires a store");
    }
    this.store = options.store;
    this.createClient =
      options.createClient ||
      (() =>
        new HoshiDictsClient({
          clientVersion: options.clientVersion || "unknown",
        }));
    this.inspectArchive = options.inspectArchive || inspectDictionaryArchive;
    this.statfs =
      options.statfs ||
      ((target) => fs.promises.statfs(target, { bigint: true }));
    this.onCatalogChanged =
      typeof options.onCatalogChanged === "function"
        ? options.onCatalogChanged
        : null;
    this.active = new Map();
  }

  #progress(state, phase, completed = null, total = null, details = null) {
    state.phase = phase;
    const event = {
      jobId: state.jobId,
      phase,
      completed,
      total,
      details,
    };
    this.emit("progress", event);
    return event;
  }

  getActiveImports() {
    return [...this.active.values()].map((state) => ({
      jobId: state.jobId,
      phase: state.phase,
      cancelled: state.cancelled,
    }));
  }

  cancel(jobId) {
    const state = this.active.get(String(jobId));
    if (!state) {
      return false;
    }
    state.cancelled = true;
    state.controller.abort();
    state.client?.forceKill();
    this.#progress(state, "cancelled");
    return true;
  }

  async importDictionary(sourcePath, options = {}) {
    const job = await this.store.createImportJob(
      options.jobId ? { jobId: options.jobId } : {},
    );
    const state = {
      jobId: job.id,
      job,
      phase: "created",
      cancelled: false,
      controller: new AbortController(),
      client: null,
    };
    this.active.set(job.id, state);

    const externalAbort = () => this.cancel(job.id);
    if (options.signal) {
      if (options.signal.aborted) {
        externalAbort();
      } else {
        options.signal.addEventListener("abort", externalAbort, { once: true });
      }
    }

    let published = false;
    try {
      this.#progress(state, "copy", 0, null);
      const copied = await copySourceNoFollow(sourcePath, job.sourcePath, {
        jobId: job.id,
        signal: state.controller.signal,
        onProgress: (completed, total) =>
          this.#progress(state, "copy", completed, total),
      });
      throwIfAborted(state.controller.signal, job.id);

      this.#progress(state, "inspect");
      const inspection = await this.inspectArchive(job.sourcePath, {
        signal: state.controller.signal,
      });
      throwIfAborted(state.controller.signal, job.id);

      const space = await this.statfs(this.store.rootPath, { bigint: true });
      if (availableBytes(space) < BigInt(inspection.requiredFreeBytes)) {
        throw importError(
          "IMPORT_OUT_OF_SPACE",
          "Not enough free space to import this dictionary",
          {
            jobId: job.id,
            details: {
              requiredFreeBytes: inspection.requiredFreeBytes,
            },
          },
        );
      }

      const duplicates = await this.store.findBySourceHash(copied.sourceSha256);
      if (!options.dictionaryId && duplicates.length > 0) {
        if (options.duplicatePolicy === "reuse") {
          await fs.promises.rm(job.rootPath, { recursive: true, force: true });
          this.#progress(state, "complete", 1, 1, { status: "reused" });
          return {
            status: "reused",
            entry: duplicates[0],
            duplicates,
          };
        }
        if (options.duplicatePolicy !== "new") {
          throw importError(
            "DUPLICATE_SOURCE",
            "This dictionary archive has already been imported",
            {
              jobId: job.id,
              details: { dictionaryIds: duplicates.map((entry) => entry.id) },
            },
          );
        }
      }

      const client = this.createClient();
      state.client = client;
      const onHostEvent = (event) => {
        if (event?.event === "import.progress" && event.jobId === job.id) {
          this.#progress(
            state,
            event.phase || "native-import",
            event.completed ?? null,
            event.total ?? null,
          );
        }
      };
      client.on?.("host-event", onHostEvent);
      let hello;
      let imported;
      try {
        hello = await client.start();
        if (
          !Array.isArray(hello.capabilities) ||
          !hello.capabilities.includes("import") ||
          !hello.capabilities.includes("probe")
        ) {
          throw importError(
            "PROTOCOL_MISMATCH",
            "Native host does not support dictionary import",
            { jobId: job.id },
          );
        }

        throwIfAborted(state.controller.signal, job.id);
        this.#progress(state, "native-import", 0, 1);
        const nativeResult = await client.request("dictionary.import", {
          jobId: job.id,
          zipPath: job.sourcePath,
          outputPath: job.outputPath,
          lowRam: options.lowRam !== false,
        });
        imported = validateNativeResult(nativeResult, job, job.id);
        for (const type of imported.types) {
          if (!inspection.types.includes(type)) {
            throw importError(
              "IMPORT_PROTOCOL_INVALID",
              "Native result conflicts with ZIP inspection",
              { jobId: job.id },
            );
          }
        }

        throwIfAborted(state.controller.signal, job.id);
        this.#progress(state, "probe", 0, 1);
        const probe = await client.request("dictionary.probe", {
          path: job.outputPath,
          types: imported.types,
          probeTerm: imported.probeTerm,
          probeKanji: imported.probeKanji,
        });
        validateProbeResult(probe, imported, job.id);
        this.#progress(state, "probe", 1, 1);
      } finally {
        client.removeListener?.("host-event", onHostEvent);
        await client.shutdown?.();
      }

      throwIfAborted(state.controller.signal, job.id);
      this.#progress(state, "publish", 0, 1);
      const publication = await this.store.publishImport(
        job.id,
        {
          title: imported.title,
          types: imported.types,
          formatRevision: imported.formatRevision,
          sourceSha256: copied.sourceSha256,
          sourceFilename: copied.sourceFilename,
          hostVersion: hello.hostVersion,
          hoshidictsCommit: hello.hoshidictsCommit,
        },
        options.dictionaryId
          ? { dictionaryId: options.dictionaryId }
          : undefined,
      );
      published = true;

      let catalogWarning = null;
      if (this.onCatalogChanged) {
        try {
          await this.onCatalogChanged(publication.manifest);
        } catch (error) {
          catalogWarning = error;
        }
      }
      this.#progress(state, "publish", 1, 1);
      this.#progress(state, "complete", 1, 1, { status: "imported" });
      return {
        status: "imported",
        ...publication,
        catalogWarning,
      };
    } catch (error) {
      const failure = normalizeFailure(error, state);
      if (!published) {
        try {
          await this.store.quarantineImport(job.id, failure.code);
        } catch {
          // The original import failure is authoritative.
        }
      }
      this.emit("failed", {
        jobId: job.id,
        code: failure.code,
      });
      throw failure;
    } finally {
      options.signal?.removeEventListener("abort", externalAbort);
      this.active.delete(job.id);
    }
  }
}

module.exports = {
  HoshiDictsImportError,
  HoshiDictsImportManager,
  availableBytes,
  copySourceNoFollow,
};
