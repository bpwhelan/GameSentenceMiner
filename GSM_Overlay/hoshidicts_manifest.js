"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MANIFEST_SCHEMA_VERSION = 1;
const MANIFEST_FILENAME = "manifest.json";
const MANIFEST_BACKUP_FILENAME = "manifest.json.backup";
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_DICTIONARIES = 1024;
const DICTIONARY_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const DRIVE_PREFIX_PATTERN = /^[a-zA-Z]:/;
const SUPPORTED_TYPES = new Set(["term", "frequency", "pitch", "kanji"]);
const SUPPORTED_HEALTH = new Set(["ready", "reindex-required", "quarantined"]);
const ENTRY_KEYS = new Set([
  "id",
  "title",
  "types",
  "formatRevision",
  "sourceSha256",
  "sourceFilename",
  "importedAt",
  "hostVersion",
  "hoshidictsCommit",
  "relativePath",
  "sizeBytes",
  "health",
]);

class HoshiDictsManifestError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "HoshiDictsManifestError";
    this.code = code;
    this.committed = Boolean(options.committed);
  }
}

function manifestError(message) {
  return new HoshiDictsManifestError("MANIFEST_INVALID", message);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requirePlainObject(value, label) {
  if (!isPlainObject(value)) {
    throw manifestError(`${label} must be an object`);
  }
}

function requireExactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw manifestError(`${label} contains unsupported field ${key}`);
    }
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) {
      throw manifestError(`${label} is missing field ${key}`);
    }
  }
}

function requireBoundedString(value, field, maxBytes, { allowEmpty = false } = {}) {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    Buffer.byteLength(value, "utf8") > maxBytes ||
    value.includes("\0")
  ) {
    throw manifestError(`${field} is invalid`);
  }
  return value;
}

function normalizeStoreRelativePath(relativePath) {
  requireBoundedString(relativePath, "dictionary relative path", 1024);
  if (
    relativePath.startsWith("/") ||
    relativePath.startsWith("\\\\") ||
    DRIVE_PREFIX_PATTERN.test(relativePath) ||
    relativePath.includes("\\")
  ) {
    throw manifestError("dictionary relative path must be a portable relative path");
  }

  const components = relativePath.split("/");
  if (
    components.some(
      (component) => component.length === 0 || component === "." || component === "..",
    )
  ) {
    throw manifestError("dictionary relative path contains an unsafe component");
  }
  const normalized = path.posix.normalize(relativePath);
  if (normalized !== relativePath || normalized === "." || normalized.startsWith("../")) {
    throw manifestError("dictionary relative path is not normalized");
  }
  return normalized;
}

function resolveStoreRelativePath(storeRoot, relativePath) {
  const normalized = normalizeStoreRelativePath(relativePath);
  const root = path.resolve(storeRoot);
  const resolved = path.resolve(root, ...normalized.split("/"));
  const containment = path.relative(root, resolved);
  if (
    containment === "" ||
    containment === ".." ||
    containment.startsWith(`..${path.sep}`) ||
    path.isAbsolute(containment)
  ) {
    throw manifestError("dictionary path escapes the HoshiDicts store");
  }
  return resolved;
}

function validateDictionaryEntry(source) {
  requirePlainObject(source, "dictionary entry");
  requireExactKeys(source, ENTRY_KEYS, "dictionary entry");

  const id = requireBoundedString(source.id, "dictionary id", 64);
  if (!DICTIONARY_ID_PATTERN.test(id)) {
    throw manifestError("dictionary id must be an opaque lowercase UUID");
  }

  const title = requireBoundedString(source.title, "dictionary title", 512);
  if (!Array.isArray(source.types) || source.types.length === 0) {
    throw manifestError("dictionary types must be a non-empty array");
  }
  const types = source.types.map((type) => {
    requireBoundedString(type, "dictionary type", 32);
    if (!SUPPORTED_TYPES.has(type)) {
      throw manifestError(`dictionary type ${type} is unsupported`);
    }
    return type;
  });
  if (new Set(types).size !== types.length) {
    throw manifestError("dictionary types must be unique");
  }

  if (
    !Number.isSafeInteger(source.formatRevision) ||
    source.formatRevision <= 0 ||
    source.formatRevision > 100
  ) {
    throw manifestError("dictionary format revision is invalid");
  }
  if (typeof source.sourceSha256 !== "string" || !SHA256_PATTERN.test(source.sourceSha256)) {
    throw manifestError("dictionary source SHA256 is invalid");
  }

  const sourceFilename = requireBoundedString(
    source.sourceFilename,
    "dictionary source filename",
    255,
  );
  if (
    sourceFilename === "." ||
    sourceFilename === ".." ||
    sourceFilename.includes("/") ||
    sourceFilename.includes("\\")
  ) {
    throw manifestError("dictionary source filename must not contain a path");
  }

  const importedAt = requireBoundedString(source.importedAt, "dictionary import time", 64);
  const importedTimestamp = Date.parse(importedAt);
  if (!Number.isFinite(importedTimestamp)) {
    throw manifestError("dictionary import time is invalid");
  }

  const hostVersion = requireBoundedString(source.hostVersion, "host version", 128);
  if (
    typeof source.hoshidictsCommit !== "string" ||
    !COMMIT_PATTERN.test(source.hoshidictsCommit)
  ) {
    throw manifestError("HoshiDicts commit is invalid");
  }

  const relativePath = normalizeStoreRelativePath(source.relativePath);
  const dictionaryPrefix = `dictionaries/${id}/`;
  if (!relativePath.startsWith(dictionaryPrefix)) {
    throw manifestError("dictionary relative path is not owned by its opaque id");
  }
  if (!Number.isSafeInteger(source.sizeBytes) || source.sizeBytes < 0) {
    throw manifestError("dictionary size is invalid");
  }
  if (typeof source.health !== "string" || !SUPPORTED_HEALTH.has(source.health)) {
    throw manifestError("dictionary health is invalid");
  }

  return {
    id,
    title,
    types: [...types],
    formatRevision: source.formatRevision,
    sourceSha256: source.sourceSha256,
    sourceFilename,
    importedAt,
    hostVersion,
    hoshidictsCommit: source.hoshidictsCommit,
    relativePath,
    sizeBytes: source.sizeBytes,
    health: source.health,
  };
}

function validateManifest(source) {
  requirePlainObject(source, "manifest");
  requireExactKeys(
    source,
    new Set(["schemaVersion", "revision", "dictionaries"]),
    "manifest",
  );
  if (source.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw manifestError("manifest schema version is unsupported");
  }
  if (!Number.isSafeInteger(source.revision) || source.revision < 0) {
    throw manifestError("manifest revision is invalid");
  }
  if (!Array.isArray(source.dictionaries) || source.dictionaries.length > MAX_DICTIONARIES) {
    throw manifestError("manifest dictionary list is invalid");
  }

  const dictionaries = source.dictionaries.map(validateDictionaryEntry);
  const ids = new Set();
  for (const dictionary of dictionaries) {
    if (ids.has(dictionary.id)) {
      throw manifestError("manifest dictionary ids must be unique");
    }
    ids.add(dictionary.id);
  }

  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    revision: source.revision,
    dictionaries,
  };
}

function createEmptyManifest() {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    revision: 0,
    dictionaries: [],
  };
}

function serializeManifest(manifest) {
  return `${JSON.stringify(validateManifest(manifest), null, 2)}\n`;
}

function isMissing(error) {
  return error && error.code === "ENOENT";
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

async function writeDurableTemporary(directory, filename, contents) {
  const temporaryPath = path.join(
    directory,
    `.${filename}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  const handle = await fs.promises.open(
    temporaryPath,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
    0o600,
  );
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await fs.promises.rm(temporaryPath, { force: true });
    throw error;
  }
  await handle.close();
  return temporaryPath;
}

class HoshiDictsManifestStore {
  constructor(storeRoot, options = {}) {
    this.storeRoot = path.resolve(storeRoot);
    this.manifestPath = path.join(this.storeRoot, MANIFEST_FILENAME);
    this.backupPath = path.join(this.storeRoot, MANIFEST_BACKUP_FILENAME);
    this.quarantinePath = path.join(this.storeRoot, "quarantine");
    this.faultInjector =
      typeof options.faultInjector === "function" ? options.faultInjector : null;
    this.commitTail = Promise.resolve();
  }

  async #ensureLayout() {
    await fs.promises.mkdir(this.storeRoot, { recursive: true, mode: 0o700 });
    await fs.promises.mkdir(this.quarantinePath, { recursive: true, mode: 0o700 });
  }

  async #inject(point) {
    if (this.faultInjector) {
      await this.faultInjector(point);
    }
  }

  async #readValidated(filePath, label) {
    let stat;
    try {
      stat = await fs.promises.lstat(filePath);
    } catch (error) {
      if (isMissing(error)) {
        return { exists: false, manifest: null, error: null };
      }
      return { exists: true, manifest: null, error };
    }
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size <= 0 ||
      stat.size > MAX_MANIFEST_BYTES
    ) {
      return {
        exists: true,
        manifest: null,
        error: new HoshiDictsManifestError(
          "MANIFEST_CORRUPT",
          `${label} is not a bounded regular file`,
        ),
      };
    }

    let contents;
    try {
      contents = await fs.promises.readFile(filePath, "utf8");
    } catch (error) {
      return { exists: true, manifest: null, error };
    }

    try {
      return {
        exists: true,
        manifest: validateManifest(JSON.parse(contents)),
        error: null,
      };
    } catch (error) {
      return {
        exists: true,
        manifest: null,
        error: new HoshiDictsManifestError(
          "MANIFEST_CORRUPT",
          `${label} is corrupt`,
          { cause: error },
        ),
      };
    }
  }

  async #replacePrimary(manifest) {
    const temporaryPath = await writeDurableTemporary(
      this.storeRoot,
      MANIFEST_FILENAME,
      serializeManifest(manifest),
    );
    try {
      await fs.promises.rename(temporaryPath, this.manifestPath);
      await syncDirectory(this.storeRoot);
    } catch (error) {
      await fs.promises.rm(temporaryPath, { force: true });
      throw error;
    }
  }

  async load() {
    await this.#ensureLayout();
    const primary = await this.#readValidated(this.manifestPath, "manifest");
    if (primary.manifest) {
      return {
        manifest: primary.manifest,
        recoveredFromBackup: false,
      };
    }

    const backup = await this.#readValidated(this.backupPath, "manifest backup");
    if (!primary.exists && !backup.exists) {
      return {
        manifest: createEmptyManifest(),
        recoveredFromBackup: false,
      };
    }
    if (!backup.manifest) {
      throw new HoshiDictsManifestError(
        "MANIFEST_UNRECOVERABLE",
        "HoshiDicts manifest and backup are not recoverable",
        { cause: primary.error || backup.error },
      );
    }

    if (primary.exists) {
      const quarantineName = `manifest-corrupt-${Date.now()}-${crypto.randomUUID()}.json`;
      try {
        await fs.promises.rename(
          this.manifestPath,
          path.join(this.quarantinePath, quarantineName),
        );
        await syncDirectory(this.storeRoot);
        await syncDirectory(this.quarantinePath);
      } catch (error) {
        throw new HoshiDictsManifestError(
          "MANIFEST_RECOVERY_FAILED",
          "Unable to quarantine the corrupt HoshiDicts manifest",
          { cause: error },
        );
      }
    }

    try {
      await this.#replacePrimary(backup.manifest);
    } catch (error) {
      throw new HoshiDictsManifestError(
        "MANIFEST_RECOVERY_FAILED",
        "Unable to restore the validated HoshiDicts manifest backup",
        { cause: error },
      );
    }
    return {
      manifest: backup.manifest,
      recoveredFromBackup: true,
    };
  }

  async #commitValidated(candidate, options) {
    const loaded = await this.load();
    const current = loaded.manifest;
    const expectedRevision = options.expectedRevision;
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision !== current.revision ||
      candidate.revision !== current.revision + 1
    ) {
      throw new HoshiDictsManifestError(
        "MANIFEST_REVISION_CONFLICT",
        "Manifest revision does not advance the active revision",
      );
    }

    const candidateTemporary = await writeDurableTemporary(
      this.storeRoot,
      MANIFEST_FILENAME,
      serializeManifest(candidate),
    );
    let backupTemporary = null;
    let committed = false;
    try {
      backupTemporary = await writeDurableTemporary(
        this.storeRoot,
        MANIFEST_BACKUP_FILENAME,
        serializeManifest(current),
      );
      await this.#inject("before-backup-rename");
      await fs.promises.rename(backupTemporary, this.backupPath);
      backupTemporary = null;
      await this.#inject("after-backup-rename");
      await syncDirectory(this.storeRoot);

      await this.#inject("before-primary-rename");
      await fs.promises.rename(candidateTemporary, this.manifestPath);
      committed = true;
      await this.#inject("after-primary-rename");
      await syncDirectory(this.storeRoot);
      return candidate;
    } catch (error) {
      if (committed) {
        throw new HoshiDictsManifestError(
          "MANIFEST_COMMIT_DURABILITY_UNKNOWN",
          "Manifest was published but its durability could not be confirmed",
          { cause: error, committed: true },
        );
      }
      throw error;
    } finally {
      await fs.promises.rm(candidateTemporary, { force: true }).catch(() => {});
      if (backupTemporary) {
        await fs.promises.rm(backupTemporary, { force: true }).catch(() => {});
      }
    }
  }

  async commit(source, options = {}) {
    const candidate = validateManifest(source);
    const operation = this.commitTail.then(
      () => this.#commitValidated(candidate, options),
      () => this.#commitValidated(candidate, options),
    );
    this.commitTail = operation.catch(() => {});
    return operation;
  }
}

module.exports = {
  HoshiDictsManifestError,
  HoshiDictsManifestStore,
  MANIFEST_BACKUP_FILENAME,
  MANIFEST_FILENAME,
  MANIFEST_SCHEMA_VERSION,
  SUPPORTED_HEALTH,
  SUPPORTED_TYPES,
  createEmptyManifest,
  normalizeStoreRelativePath,
  resolveStoreRelativePath,
  validateManifest,
};
