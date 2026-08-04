"use strict";

const DEFAULT_MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const MAX_MEDIA_PATH_BYTES = 1024;
const MAX_MEDIA_CACHE_ENTRIES = 64;

class HoshiDictsMediaError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "HoshiDictsMediaError";
    this.code = code;
  }
}

function mediaError(code, message) {
  return new HoshiDictsMediaError(code, message);
}

function validateMediaPath(value) {
  if (
    typeof value !== "string" ||
    !value ||
    Buffer.byteLength(value, "utf8") > MAX_MEDIA_PATH_BYTES ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    /^[a-zA-Z]:/u.test(value)
  ) {
    throw mediaError("MEDIA_PATH_INVALID", "Dictionary media path is invalid");
  }
  const components = value.split("/");
  if (
    components.some(
      (component) =>
        !component ||
        component === "." ||
        component === ".." ||
        Buffer.byteLength(component, "utf8") > 255,
    )
  ) {
    throw mediaError("MEDIA_PATH_INVALID", "Dictionary media path is not canonical");
  }
  return value;
}

function validBase64(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length % 4 === 0 &&
    /^[A-Za-z0-9+/]*={0,2}$/u.test(value)
  );
}

function sniffRasterMimeType(bytes) {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 6 &&
    (bytes.subarray(0, 6).toString("ascii") === "GIF87a" ||
      bytes.subarray(0, 6).toString("ascii") === "GIF89a")
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function decodeMediaResponse(response, expected, options = {}) {
  if (!response || typeof response !== "object") {
    throw mediaError("MEDIA_RESPONSE_INVALID", "Dictionary media response is invalid");
  }
  const path = validateMediaPath(expected?.path);
  const dictionaryId = expected?.dictionaryId;
  const catalogGeneration = expected?.catalogGeneration;
  if (
    typeof dictionaryId !== "string" ||
    !dictionaryId ||
    !Number.isSafeInteger(catalogGeneration) ||
    catalogGeneration <= 0
  ) {
    throw mediaError("MEDIA_REQUEST_INVALID", "Dictionary media request is invalid");
  }
  if (response.dictionary !== dictionaryId) {
    throw mediaError(
      "MEDIA_OWNER_MISMATCH",
      "Dictionary media response came from a different dictionary",
    );
  }
  if (response.path !== path) {
    throw mediaError(
      "MEDIA_PATH_MISMATCH",
      "Dictionary media response used a different path",
    );
  }
  if (response.catalogGeneration !== catalogGeneration) {
    throw mediaError(
      "MEDIA_GENERATION_MISMATCH",
      "Dictionary media response belongs to a stale catalog",
    );
  }
  if (response.encoding !== "base64" || !validBase64(response.data)) {
    throw mediaError("MEDIA_ENCODING_INVALID", "Dictionary media encoding is invalid");
  }
  const maxBytes =
    Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0
      ? options.maxBytes
      : DEFAULT_MAX_MEDIA_BYTES;
  if (
    !Number.isSafeInteger(response.size) ||
    response.size <= 0 ||
    response.size > maxBytes
  ) {
    throw mediaError("MEDIA_SIZE_INVALID", "Dictionary media size is unsupported");
  }
  const bytes = Buffer.from(response.data, "base64");
  if (
    bytes.length !== response.size ||
    bytes.toString("base64") !== response.data
  ) {
    throw mediaError("MEDIA_ENCODING_INVALID", "Dictionary media base64 is malformed");
  }
  const mimeType = sniffRasterMimeType(bytes);
  if (!mimeType) {
    throw mediaError(
      "MEDIA_TYPE_UNSUPPORTED",
      "Dictionary media is not a supported raster image",
    );
  }
  return Object.freeze({
    dictionaryId,
    path,
    catalogGeneration,
    size: bytes.length,
    mimeType,
    dataUrl: `data:${mimeType};base64,${response.data}`,
  });
}

class HoshiDictsMediaResolver {
  constructor(options = {}) {
    if (typeof options.request !== "function") {
      throw new TypeError("HoshiDictsMediaResolver requires a host request function");
    }
    this.request = options.request;
    this.catalogGeneration = options.catalogGeneration;
    this.dictionaryIds = new Set(options.dictionaryIds || []);
    this.maxBytes = options.maxBytes || DEFAULT_MAX_MEDIA_BYTES;
    this.cache = new Map();
  }

  reconfigure(options = {}) {
    this.catalogGeneration = options.catalogGeneration;
    this.dictionaryIds = new Set(options.dictionaryIds || []);
    this.cache.clear();
  }

  async resolve(dictionaryId, mediaPath, options = {}) {
    if (!this.dictionaryIds.has(dictionaryId)) {
      throw mediaError(
        "MEDIA_OWNER_UNKNOWN",
        "Dictionary media owner is not active",
      );
    }
    const path = validateMediaPath(mediaPath);
    const cacheKey = `${this.catalogGeneration}\0${dictionaryId}\0${path}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, cached);
      return cached;
    }
    const response = await this.request(
      "media.get",
      {
        catalogGeneration: this.catalogGeneration,
        dictionary: dictionaryId,
        path,
      },
      { signal: options.signal },
    );
    const decoded = decodeMediaResponse(
      response,
      {
        catalogGeneration: this.catalogGeneration,
        dictionaryId,
        path,
      },
      { maxBytes: this.maxBytes },
    );
    this.cache.set(cacheKey, decoded);
    while (this.cache.size > MAX_MEDIA_CACHE_ENTRIES) {
      this.cache.delete(this.cache.keys().next().value);
    }
    return decoded;
  }
}

module.exports = {
  DEFAULT_MAX_MEDIA_BYTES,
  HoshiDictsMediaError,
  HoshiDictsMediaResolver,
  decodeMediaResponse,
  sniffRasterMimeType,
  validateMediaPath,
};
