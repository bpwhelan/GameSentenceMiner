"use strict";

const fs = require("node:fs");
const path = require("node:path");
const yauzl = require("yauzl");

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const DEFAULT_LIMITS = Object.freeze({
  maxArchiveBytes: 4 * GIB,
  maxEntries: 20_000,
  maxEntryBytes: 512 * MIB,
  maxExpandedBytes: 8 * GIB,
  maxCompressionRatio: 1000,
  expansionHeadroom: 2,
  freeSpaceReserveBytes: 512 * MIB,
});
const DRIVE_PREFIX_PATTERN = /^[a-zA-Z]:/;
const MAX_ENTRY_NAME_BYTES = 4096;
const UNIX_FILE_TYPE_MASK = 0o170000;
const UNIX_DIRECTORY = 0o040000;
const UNIX_REGULAR_FILE = 0o100000;
const UNIX_SYMLINK = 0o120000;

class HoshiDictsArchiveError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "HoshiDictsArchiveError";
    this.code = code;
  }
}

function archiveError(code, message, cause) {
  return new HoshiDictsArchiveError(code, message, cause ? { cause } : undefined);
}

function positiveLimit(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function normalizeLimits(options) {
  return {
    maxArchiveBytes: positiveLimit(
      options.maxArchiveBytes,
      DEFAULT_LIMITS.maxArchiveBytes,
    ),
    maxEntries: positiveLimit(options.maxEntries, DEFAULT_LIMITS.maxEntries),
    maxEntryBytes: positiveLimit(
      options.maxEntryBytes,
      DEFAULT_LIMITS.maxEntryBytes,
    ),
    maxExpandedBytes: positiveLimit(
      options.maxExpandedBytes,
      DEFAULT_LIMITS.maxExpandedBytes,
    ),
    maxCompressionRatio:
      Number.isFinite(options.maxCompressionRatio) && options.maxCompressionRatio > 0
        ? options.maxCompressionRatio
        : DEFAULT_LIMITS.maxCompressionRatio,
    expansionHeadroom:
      Number.isFinite(options.expansionHeadroom) && options.expansionHeadroom >= 1
        ? options.expansionHeadroom
        : DEFAULT_LIMITS.expansionHeadroom,
    freeSpaceReserveBytes: positiveLimit(
      options.freeSpaceReserveBytes,
      DEFAULT_LIMITS.freeSpaceReserveBytes,
    ),
  };
}

function cancellationError() {
  return archiveError("IMPORT_CANCELLED", "Dictionary archive inspection was cancelled");
}

function normalizeEntryName(fileName) {
  if (
    typeof fileName !== "string" ||
    fileName.length === 0 ||
    Buffer.byteLength(fileName, "utf8") > MAX_ENTRY_NAME_BYTES ||
    fileName.includes("\0") ||
    fileName.includes("\\") ||
    fileName.startsWith("/") ||
    fileName.startsWith("\\\\") ||
    DRIVE_PREFIX_PATTERN.test(fileName)
  ) {
    throw archiveError(
      Buffer.byteLength(String(fileName), "utf8") > MAX_ENTRY_NAME_BYTES
        ? "ZIP_PATH_TOO_LONG"
        : "ZIP_PATH_TRAVERSAL",
      Buffer.byteLength(String(fileName), "utf8") > MAX_ENTRY_NAME_BYTES
        ? "ZIP entry path is too long"
        : "ZIP entry contains an unsafe path",
    );
  }

  const withoutTrailingSlash = fileName.endsWith("/")
    ? fileName.slice(0, -1)
    : fileName;
  if (!withoutTrailingSlash) {
    throw archiveError("ZIP_PATH_TRAVERSAL", "ZIP entry path is empty");
  }
  const components = withoutTrailingSlash.split("/");
  if (
    components.some(
      (component) => component.length === 0 || component === "." || component === "..",
    )
  ) {
    throw archiveError("ZIP_PATH_TRAVERSAL", "ZIP entry traverses a parent path");
  }
  if (path.posix.normalize(withoutTrailingSlash) !== withoutTrailingSlash) {
    throw archiveError("ZIP_PATH_TRAVERSAL", "ZIP entry path is not normalized");
  }
  return fileName.endsWith("/") ? `${withoutTrailingSlash}/` : withoutTrailingSlash;
}

function validateEntryType(entry, normalizedName) {
  const creatorSystem = entry.versionMadeBy >>> 8;
  if (creatorSystem !== 3) {
    return;
  }
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const fileType = unixMode & UNIX_FILE_TYPE_MASK;
  if (fileType === UNIX_SYMLINK) {
    throw archiveError("ZIP_SYMLINK", "ZIP archive contains a symbolic link");
  }
  if (
    fileType !== 0 &&
    fileType !== UNIX_REGULAR_FILE &&
    fileType !== UNIX_DIRECTORY
  ) {
    throw archiveError("ZIP_SPECIAL_FILE", "ZIP archive contains a special file");
  }
  if (
    (fileType === UNIX_DIRECTORY && !normalizedName.endsWith("/")) ||
    (fileType === UNIX_REGULAR_FILE && normalizedName.endsWith("/"))
  ) {
    throw archiveError("ZIP_SPECIAL_FILE", "ZIP entry type conflicts with its path");
  }
}

function openZip(archivePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(
      archivePath,
      {
        autoClose: false,
        decodeStrings: true,
        lazyEntries: true,
        strictFileNames: true,
        validateEntrySizes: true,
      },
      (error, zipFile) => {
        if (error) {
          reject(
            archiveError(
              "INVALID_DICTIONARY_ARCHIVE",
              "Unable to open the dictionary ZIP",
              error,
            ),
          );
          return;
        }
        resolve(zipFile);
      },
    );
  });
}

function inspectEntries(zipFile, limits, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let entryCount = 0;
    let compressedSizeBytes = 0;
    let expandedSizeBytes = 0;
    let hasIndex = false;
    let hasTerm = false;
    let hasMeta = false;
    let hasKanji = false;
    const names = new Set();

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      zipFile.removeListener("entry", onEntry);
      zipFile.removeListener("end", onEnd);
      zipFile.removeListener("error", onError);
    };
    const finishReject = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      try {
        zipFile.close();
      } catch {
        // The parser may already have closed after an input error.
      }
      reject(error);
    };
    const finishResolve = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      try {
        zipFile.close();
      } catch {
        // End-of-directory parsing is already authoritative.
      }
      resolve(value);
    };
    const onAbort = () => finishReject(cancellationError());
    const onError = (error) => {
      const message = String(error?.message);
      const pathFailure =
        /file name|filename|backslash|relative path|absolute path|drive letter/i.test(
          message,
        );
      const encryptionFailure = /encrypt|general purpose bit flag/i.test(message);
      finishReject(
        archiveError(
          pathFailure
            ? "ZIP_PATH_TRAVERSAL"
            : encryptionFailure
              ? "ZIP_ENCRYPTED"
              : "INVALID_DICTIONARY_ARCHIVE",
          pathFailure
            ? "ZIP entry contains an unsafe path"
            : encryptionFailure
              ? "Encrypted dictionary ZIPs are unsupported"
            : "Dictionary ZIP central directory is invalid",
          error,
        ),
      );
    };
    const onEntry = (entry) => {
      try {
        if (signal?.aborted) {
          throw cancellationError();
        }
        entryCount += 1;
        if (entryCount > limits.maxEntries) {
          throw archiveError(
            "ZIP_ENTRY_LIMIT",
            "Dictionary ZIP contains too many entries",
          );
        }

        const normalizedName = normalizeEntryName(entry.fileName);
        const comparisonName = normalizedName.normalize("NFC").toLocaleLowerCase("en-US");
        if (names.has(comparisonName)) {
          throw archiveError(
            "ZIP_DUPLICATE_ENTRY",
            "Dictionary ZIP contains duplicate entry paths",
          );
        }
        names.add(comparisonName);
        validateEntryType(entry, normalizedName);

        if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
          throw archiveError("ZIP_ENCRYPTED", "Encrypted dictionary ZIPs are unsupported");
        }
        if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
          throw archiveError(
            "ZIP_COMPRESSION_UNSUPPORTED",
            "Dictionary ZIP uses an unsupported compression method",
          );
        }
        if (
          entry.versionNeededToExtract >= 45 ||
          entry.extraFields?.some((field) => field.id === 0x0001)
        ) {
          throw archiveError(
            "ZIP64_UNSUPPORTED",
            "ZIP64 dictionary archives are unsupported",
          );
        }
        if (
          !Number.isSafeInteger(entry.compressedSize) ||
          entry.compressedSize < 0 ||
          !Number.isSafeInteger(entry.uncompressedSize) ||
          entry.uncompressedSize < 0
        ) {
          throw archiveError(
            "INVALID_DICTIONARY_ARCHIVE",
            "Dictionary ZIP entry size is invalid",
          );
        }
        if (entry.uncompressedSize > limits.maxEntryBytes) {
          throw archiveError(
            "ZIP_ENTRY_TOO_LARGE",
            "Dictionary ZIP contains an oversized entry",
          );
        }

        compressedSizeBytes += entry.compressedSize;
        expandedSizeBytes += entry.uncompressedSize;
        if (
          !Number.isSafeInteger(compressedSizeBytes) ||
          !Number.isSafeInteger(expandedSizeBytes) ||
          expandedSizeBytes > limits.maxExpandedBytes
        ) {
          throw archiveError(
            "ZIP_EXPANDED_TOO_LARGE",
            "Dictionary ZIP expands beyond the supported limit",
          );
        }
        if (
          entry.uncompressedSize > 0 &&
          entry.uncompressedSize / Math.max(1, entry.compressedSize) >
            limits.maxCompressionRatio
        ) {
          throw archiveError(
            "ZIP_COMPRESSION_RATIO",
            "Dictionary ZIP contains a suspicious compression ratio",
          );
        }

        if (normalizedName === "index.json") {
          hasIndex = true;
        } else if (/^term_bank_[0-9]+\.json$/.test(normalizedName)) {
          hasTerm = true;
        } else if (/^term_meta_bank_[0-9]+\.json$/.test(normalizedName)) {
          hasMeta = true;
        } else if (/^kanji_bank_[0-9]+\.json$/.test(normalizedName)) {
          hasKanji = true;
        }
        zipFile.readEntry();
      } catch (error) {
        finishReject(
          error instanceof HoshiDictsArchiveError
            ? error
            : archiveError(
                "INVALID_DICTIONARY_ARCHIVE",
                "Dictionary ZIP entry is invalid",
                error,
              ),
        );
      }
    };
    const onEnd = () => {
      if (!hasIndex) {
        finishReject(
          archiveError(
            "INVALID_DICTIONARY_ARCHIVE",
            "Dictionary ZIP has no root index.json",
          ),
        );
        return;
      }
      if (!hasTerm && !hasMeta && !hasKanji) {
        finishReject(
          archiveError(
            "UNSUPPORTED_DICTIONARY_TYPE",
            "Dictionary ZIP contains no supported dictionary banks",
          ),
        );
        return;
      }

      const types = [];
      if (hasTerm) {
        types.push("term");
      }
      if (hasMeta) {
        types.push("frequency", "pitch");
      }
      if (hasKanji) {
        types.push("kanji");
      }
      finishResolve({
        entryCount,
        compressedSizeBytes,
        expandedSizeBytes,
        hasIndex,
        types,
      });
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    zipFile.on("entry", onEntry);
    zipFile.once("end", onEnd);
    zipFile.once("error", onError);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    zipFile.readEntry();
  });
}

async function inspectDictionaryArchive(archivePath, options = {}) {
  if (options.signal?.aborted) {
    throw cancellationError();
  }
  const limits = normalizeLimits(options);
  let stat;
  try {
    stat = await fs.promises.lstat(archivePath);
  } catch (error) {
    throw archiveError(
      "INVALID_DICTIONARY_ARCHIVE",
      "Dictionary ZIP cannot be read",
      error,
    );
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw archiveError(
      "INVALID_DICTIONARY_ARCHIVE",
      "Dictionary ZIP must be a regular file",
    );
  }
  if (stat.size <= 0 || stat.size > limits.maxArchiveBytes) {
    throw archiveError(
      "ZIP_ARCHIVE_TOO_LARGE",
      "Dictionary ZIP size is outside the supported range",
    );
  }

  const zipFile = await openZip(archivePath);
  const inspection = await inspectEntries(zipFile, limits, options.signal);
  const requiredFreeBytes = Math.ceil(
    stat.size +
      inspection.expandedSizeBytes * limits.expansionHeadroom +
      limits.freeSpaceReserveBytes,
  );
  if (!Number.isSafeInteger(requiredFreeBytes)) {
    throw archiveError(
      "ZIP_EXPANDED_TOO_LARGE",
      "Dictionary ZIP space estimate exceeds the supported range",
    );
  }
  return {
    ...inspection,
    archiveSizeBytes: stat.size,
    requiredFreeBytes,
  };
}

module.exports = {
  DEFAULT_LIMITS,
  HoshiDictsArchiveError,
  inspectDictionaryArchive,
  normalizeEntryName,
};
