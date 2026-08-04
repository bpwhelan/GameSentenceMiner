"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  HoshiDictsManifestError,
  HoshiDictsManifestStore,
  resolveStoreRelativePath,
  validateManifest,
} = require("./hoshidicts_manifest.js");

const DICTIONARY_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const REQUIRED_INDEX_FILES = Object.freeze([
  ".hoshidicts_1",
  "index.json",
  "hash.table",
  "blobs.bin",
]);
const MAX_INDEX_FILES = 100_000;

class HoshiDictsStoreError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "HoshiDictsStoreError";
    this.code = code;
  }
}

function storeError(code, message, cause) {
  return new HoshiDictsStoreError(code, message, cause ? { cause } : undefined);
}

async function requireDirectoryNoSymlink(directory, label) {
  let stat;
  try {
    stat = await fs.promises.lstat(directory);
  } catch (error) {
    throw storeError("STORE_PATH_UNSAFE", `${label} is unavailable`, error);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw storeError(
      "STORE_PATH_UNSAFE",
      `${label} must be a non-symlink directory`,
    );
  }
}

async function ensureDirectoryChain(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw storeError("STORE_PATH_UNSAFE", "Directory path escapes the HoshiDicts store");
  }

  await requireDirectoryNoSymlink(resolvedRoot, "HoshiDicts store directory");
  let current = resolvedRoot;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      await fs.promises.mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (!error || error.code !== "EEXIST") {
        throw error;
      }
    }
    await requireDirectoryNoSymlink(current, "HoshiDicts store directory");
  }
}

async function verifyExistingDirectoryChain(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw storeError("STORE_PATH_UNSAFE", "Dictionary path escapes the HoshiDicts store");
  }
  await requireDirectoryNoSymlink(resolvedRoot, "HoshiDicts store directory");
  let current = resolvedRoot;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    await requireDirectoryNoSymlink(current, "Dictionary index directory");
  }
}

function validateOpaqueId(id, label) {
  if (typeof id !== "string" || !DICTIONARY_ID_PATTERN.test(id)) {
    throw storeError("INVALID_ID", `${label} must be an opaque UUID`);
  }
  return id;
}

function sanitizeQuarantineLabel(value) {
  return String(value || "unknown")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .slice(0, 80);
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

async function writeJsonDurably(filePath, value) {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  const handle = await fs.promises.open(
    temporaryPath,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await fs.promises.rm(temporaryPath, { force: true });
    throw error;
  }
  await handle.close();
  try {
    await fs.promises.rename(temporaryPath, filePath);
    await syncDirectory(directory);
  } catch (error) {
    await fs.promises.rm(temporaryPath, { force: true });
    throw error;
  }
}

async function inspectOutputTree(rootPath) {
  let fileCount = 0;
  let sizeBytes = 0;

  async function visit(directory) {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      fileCount += 1;
      if (fileCount > MAX_INDEX_FILES) {
        throw storeError("INDEX_FILE_LIMIT", "Imported index contains too many files");
      }
      const candidate = path.join(directory, entry.name);
      const stat = await fs.promises.lstat(candidate);
      if (stat.isSymbolicLink()) {
        throw storeError("INDEX_SYMLINK", "Imported index contains a symbolic link");
      }
      if (stat.isDirectory()) {
        await visit(candidate);
      } else if (stat.isFile()) {
        sizeBytes += stat.size;
        if (!Number.isSafeInteger(sizeBytes)) {
          throw storeError("INDEX_TOO_LARGE", "Imported index size is unsupported");
        }
      } else {
        throw storeError("INDEX_SPECIAL_FILE", "Imported index contains a special file");
      }
    }
  }

  const rootStat = await fs.promises.lstat(rootPath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw storeError("INDEX_INVALID", "Native import output is not a directory");
  }
  for (const filename of REQUIRED_INDEX_FILES) {
    const candidate = path.join(rootPath, filename);
    let stat;
    try {
      stat = await fs.promises.lstat(candidate);
    } catch (error) {
      throw storeError("INDEX_INCOMPLETE", `Native index is missing ${filename}`, error);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw storeError("INDEX_INCOMPLETE", `Native index file ${filename} is invalid`);
    }
  }
  await visit(rootPath);
  return { fileCount, sizeBytes };
}

class HoshiDictsStore {
  constructor(dataPath, options = {}) {
    this.dataPath = path.resolve(dataPath);
    this.rootPath = path.join(this.dataPath, "hoshidicts");
    this.dictionariesPath = path.join(this.rootPath, "dictionaries");
    this.stagingPath = path.join(this.rootPath, "staging");
    this.quarantinePath = path.join(this.rootPath, "quarantine");
    this.logsPath = path.join(this.rootPath, "logs");
    this.randomUUID = options.randomUUID || crypto.randomUUID;
    this.now = options.now || (() => new Date());
    this.manifestStore =
      options.manifestStore ||
      new HoshiDictsManifestStore(this.rootPath, options.manifestOptions);
  }

  async #ensureLayout() {
    await fs.promises.mkdir(this.rootPath, { recursive: true, mode: 0o700 });
    await requireDirectoryNoSymlink(this.rootPath, "HoshiDicts store root");
    for (const directory of [
      this.dictionariesPath,
      this.stagingPath,
      this.quarantinePath,
      this.logsPath,
    ]) {
      await ensureDirectoryChain(this.rootPath, directory);
    }
  }

  #jobPaths(jobId) {
    validateOpaqueId(jobId, "import job id");
    const rootPath = path.join(this.stagingPath, jobId);
    return {
      id: jobId,
      rootPath,
      sourcePath: path.join(rootPath, "source.zip"),
      outputPath: path.join(rootPath, "index"),
    };
  }

  async initialize(options = {}) {
    await this.#ensureLayout();
    const activeJobIds = new Set(options.activeJobIds || []);
    for (const id of activeJobIds) {
      validateOpaqueId(id, "active import job id");
    }

    const cleanedJobIds = [];
    const entries = await fs.promises.readdir(this.stagingPath, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (activeJobIds.has(entry.name)) {
        continue;
      }
      const quarantineName = `abandoned-import-${sanitizeQuarantineLabel(
        entry.name,
      )}-${this.randomUUID()}`;
      await fs.promises.rename(
        path.join(this.stagingPath, entry.name),
        path.join(this.quarantinePath, quarantineName),
      );
      cleanedJobIds.push(entry.name);
    }
    if (cleanedJobIds.length > 0) {
      await syncDirectory(this.stagingPath);
      await syncDirectory(this.quarantinePath);
    }
    const loaded = await this.manifestStore.load();
    return {
      ...loaded,
      cleanedJobIds,
    };
  }

  async createImportJob(options = {}) {
    await this.#ensureLayout();
    const jobId = options.jobId || this.randomUUID();
    const job = this.#jobPaths(jobId);
    try {
      await fs.promises.mkdir(job.rootPath, { mode: 0o700 });
      await syncDirectory(this.stagingPath);
    } catch (error) {
      if (error && error.code === "EEXIST") {
        throw storeError("IMPORT_JOB_EXISTS", "Import job already exists", error);
      }
      throw error;
    }
    return job;
  }

  async getManifest() {
    return (await this.manifestStore.load()).manifest;
  }

  async #quarantinePath(sourcePath, label) {
    const quarantinePath = path.join(
      this.quarantinePath,
      `${sanitizeQuarantineLabel(label)}-${this.randomUUID()}`,
    );
    try {
      await fs.promises.rename(sourcePath, quarantinePath);
      await syncDirectory(path.dirname(sourcePath));
      await syncDirectory(this.quarantinePath);
      return quarantinePath;
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async quarantineImport(jobId, reason = "failed") {
    const job = this.#jobPaths(jobId);
    return this.#quarantinePath(
      job.rootPath,
      `import-${jobId}-${sanitizeQuarantineLabel(reason)}`,
    );
  }

  async publishImport(jobId, metadata, options = {}) {
    await this.#ensureLayout();
    const job = this.#jobPaths(jobId);
    const loaded = await this.manifestStore.load();
    const current = loaded.manifest;

    let dictionaryId;
    let previousEntry = null;
    if (options.dictionaryId !== undefined) {
      dictionaryId = validateOpaqueId(options.dictionaryId, "dictionary id");
      previousEntry = current.dictionaries.find((entry) => entry.id === dictionaryId);
      if (!previousEntry) {
        throw storeError("DICTIONARY_NOT_FOUND", "Dictionary to reimport was not found");
      }
    } else {
      dictionaryId = this.randomUUID();
      validateOpaqueId(dictionaryId, "generated dictionary id");
      if (current.dictionaries.some((entry) => entry.id === dictionaryId)) {
        throw storeError(
          "DICTIONARY_ID_COLLISION",
          "Generated dictionary ID already exists",
        );
      }
    }

    if (!metadata || typeof metadata !== "object") {
      throw storeError("IMPORT_METADATA_INVALID", "Import metadata is invalid");
    }
    if (
      typeof metadata.sourceSha256 !== "string" ||
      !SHA256_PATTERN.test(metadata.sourceSha256)
    ) {
      throw storeError("IMPORT_METADATA_INVALID", "Import source SHA256 is invalid");
    }
    await inspectOutputTree(job.outputPath);

    const importedAt =
      typeof metadata.importedAt === "string"
        ? metadata.importedAt
        : this.now().toISOString();
    const sourceMetadata = {
      schemaVersion: 1,
      sourceSha256: metadata.sourceSha256,
      sourceFilename: metadata.sourceFilename,
      importedAt,
      title: metadata.title,
      types: metadata.types,
      formatRevision: metadata.formatRevision,
      hostVersion: metadata.hostVersion,
      hoshidictsCommit: metadata.hoshidictsCommit,
    };
    await writeJsonDurably(path.join(job.outputPath, "source.json"), sourceMetadata);
    const outputStats = await inspectOutputTree(job.outputPath);

    const relativePath = path.posix.join(
      "dictionaries",
      dictionaryId,
      "current",
      jobId,
    );
    const destinationPath = resolveStoreRelativePath(this.rootPath, relativePath);

    const entry = {
      id: dictionaryId,
      title: metadata.title,
      types: metadata.types,
      formatRevision: metadata.formatRevision,
      sourceSha256: metadata.sourceSha256,
      sourceFilename: metadata.sourceFilename,
      importedAt,
      hostVersion: metadata.hostVersion,
      hoshidictsCommit: metadata.hoshidictsCommit,
      relativePath,
      sizeBytes: outputStats.sizeBytes,
      health: "ready",
    };
    const dictionaries = previousEntry
      ? current.dictionaries.map((candidate) =>
          candidate.id === dictionaryId ? entry : candidate,
        )
      : [...current.dictionaries, entry];
    const candidateManifest = validateManifest({
      schemaVersion: 1,
      revision: current.revision + 1,
      dictionaries,
    });

    let durabilityWarning = null;
    let destinationPublished = false;
    try {
      await ensureDirectoryChain(this.dictionariesPath, path.dirname(destinationPath));
      try {
        await fs.promises.lstat(destinationPath);
        throw storeError(
          "PUBLICATION_DESTINATION_EXISTS",
          "Dictionary publication destination already exists",
        );
      } catch (error) {
        if (!error || error.code !== "ENOENT") {
          throw error;
        }
      }
      await fs.promises.rename(job.outputPath, destinationPath);
      destinationPublished = true;
      await syncDirectory(path.dirname(destinationPath));

      await this.manifestStore.commit(candidateManifest, {
        expectedRevision: current.revision,
      });
    } catch (error) {
      if (error instanceof HoshiDictsManifestError && error.committed) {
        const active = await this.getManifest();
        const activeEntry = active.dictionaries.find(
          (candidate) =>
            candidate.id === entry.id && candidate.relativePath === entry.relativePath,
        );
        if (!activeEntry) {
          throw error;
        }
        durabilityWarning = error;
      } else {
        if (destinationPublished) {
          try {
            await this.#quarantinePath(
              destinationPath,
              `failed-publication-${dictionaryId}-${jobId}`,
            );
          } catch (cleanupError) {
            if (error && typeof error === "object") {
              error.cleanupError = cleanupError;
            }
          }
        }
        throw error;
      }
    }

    const cleanupWarnings = [];
    if (previousEntry && previousEntry.relativePath !== entry.relativePath) {
      const previousPath = resolveStoreRelativePath(
        this.rootPath,
        previousEntry.relativePath,
      );
      try {
        await this.#quarantinePath(
          previousPath,
          `replaced-dictionary-${dictionaryId}`,
        );
      } catch (error) {
        cleanupWarnings.push(error);
      }
    }
    try {
      await fs.promises.rm(job.rootPath, { recursive: true, force: true });
      await syncDirectory(this.stagingPath);
    } catch (error) {
      cleanupWarnings.push(error);
    }
    return {
      entry,
      manifest: candidateManifest,
      previousEntry,
      durabilityWarning,
      cleanupWarnings,
    };
  }

  async findBySourceHash(sourceSha256) {
    if (typeof sourceSha256 !== "string" || !SHA256_PATTERN.test(sourceSha256)) {
      throw storeError("SOURCE_HASH_INVALID", "Source SHA256 is invalid");
    }
    const manifest = await this.getManifest();
    return manifest.dictionaries.filter(
      (dictionary) => dictionary.sourceSha256 === sourceSha256,
    );
  }

  async listDictionaries() {
    const manifest = await this.getManifest();
    const titleCounts = new Map();
    for (const dictionary of manifest.dictionaries) {
      titleCounts.set(dictionary.title, (titleCounts.get(dictionary.title) || 0) + 1);
    }
    return manifest.dictionaries.map((dictionary) => ({
      ...dictionary,
      displayTitle:
        titleCounts.get(dictionary.title) > 1
          ? `${dictionary.title} (${dictionary.id.slice(0, 8)})`
          : dictionary.title,
    }));
  }

  async getStorageUsage() {
    const manifest = await this.getManifest();
    return {
      activeBytes: manifest.dictionaries.reduce(
        (total, dictionary) => total + dictionary.sizeBytes,
        0,
      ),
      dictionaryCount: manifest.dictionaries.length,
    };
  }

  async buildCatalog(options = {}) {
    const manifest = await this.getManifest();
    const byId = new Map(
      manifest.dictionaries.map((dictionary) => [dictionary.id, dictionary]),
    );
    const orderedIds = [];
    const seen = new Set();
    for (const id of Array.isArray(options.order) ? options.order : []) {
      if (typeof id === "string" && byId.has(id) && !seen.has(id)) {
        seen.add(id);
        orderedIds.push(id);
      }
    }
    for (const dictionary of manifest.dictionaries) {
      if (!seen.has(dictionary.id)) {
        seen.add(dictionary.id);
        orderedIds.push(dictionary.id);
      }
    }

    const dictionaries = [];
    const reindexRequired = [];
    for (const id of orderedIds) {
      const dictionary = byId.get(id);
      if (
        dictionary.health !== "ready" ||
        dictionary.hostVersion !== options.hostVersion ||
        dictionary.hoshidictsCommit !== options.hoshidictsCommit
      ) {
        reindexRequired.push(id);
        continue;
      }
      if (!options.enabled || options.enabled[id] !== true) {
        continue;
      }
      const dictionaryPath = resolveStoreRelativePath(
        this.rootPath,
        dictionary.relativePath,
      );
      await verifyExistingDirectoryChain(this.rootPath, dictionaryPath);
      dictionaries.push({
        id,
        title: dictionary.title,
        displayTitle: dictionary.title,
        path: dictionaryPath,
        types: [...dictionary.types],
        priority: dictionaries.length,
      });
    }
    return {
      dictionaries,
      reindexRequired,
      manifestRevision: manifest.revision,
    };
  }

  async removeDictionary(dictionaryId) {
    validateOpaqueId(dictionaryId, "dictionary id");
    const current = await this.getManifest();
    const removed = current.dictionaries.find(
      (dictionary) => dictionary.id === dictionaryId,
    );
    if (!removed) {
      throw storeError("DICTIONARY_NOT_FOUND", "Dictionary was not found");
    }
    const candidate = {
      schemaVersion: 1,
      revision: current.revision + 1,
      dictionaries: current.dictionaries.filter(
        (dictionary) => dictionary.id !== dictionaryId,
      ),
    };
    await this.manifestStore.commit(candidate, {
      expectedRevision: current.revision,
    });

    const dictionaryRoot = path.join(this.dictionariesPath, dictionaryId);
    let quarantinePath = null;
    let pendingDeletion = false;
    try {
      quarantinePath = await this.#quarantinePath(
        dictionaryRoot,
        `removed-dictionary-${dictionaryId}`,
      );
    } catch {
      pendingDeletion = true;
    }
    return {
      entry: removed,
      quarantinePath,
      pendingDeletion,
    };
  }
}

module.exports = {
  HoshiDictsStore,
  HoshiDictsStoreError,
  REQUIRED_INDEX_FILES,
  inspectOutputTree,
};
