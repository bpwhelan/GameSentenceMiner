"use strict";

const MAX_RESULTS = 64;
const MAX_DICTIONARIES = 64;
const MAX_GLOSSARIES_PER_RESULT = 512;
const MAX_METADATA_PER_RESULT = 512;
const MAX_STRING_BYTES = 256 * 1024;
const MAX_SHORT_STRING_BYTES = 4096;

class HoshiDictsResultModelError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "HoshiDictsResultModelError";
    this.code = code;
  }
}

function resultError(code, message) {
  return new HoshiDictsResultModelError(code, message);
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw resultError("INVALID_RESULT", `${label} must be an object`);
  }
  return value;
}

function boundedString(value, label, maxBytes = MAX_SHORT_STRING_BYTES) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw resultError("RESULT_LIMIT_EXCEEDED", `${label} is outside the supported size`);
  }
  return value;
}

function safeInteger(value, label, options = {}) {
  const minimum = options.minimum ?? 0;
  const maximum = options.maximum ?? Number.MAX_SAFE_INTEGER;
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw resultError("INVALID_RESULT", `${label} is invalid`);
  }
  return value;
}

function boundedArray(value, label, maximum) {
  if (!Array.isArray(value)) {
    throw resultError("INVALID_RESULT", `${label} must be an array`);
  }
  if (value.length > maximum) {
    throw resultError("RESULT_LIMIT_EXCEEDED", `${label} contains too many values`);
  }
  return value;
}

function splitTags(value, label) {
  const source = boundedString(value ?? "", label);
  if (!source.trim()) {
    return [];
  }
  return source.trim().split(/\s+/u).slice(0, 64);
}

function stableHash(value) {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(value, "utf8")) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const child of Object.values(value)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

function normalizeCatalog(dictionaries) {
  const source = boundedArray(
    dictionaries ?? [],
    "dictionary catalog",
    MAX_DICTIONARIES,
  );
  const catalog = new Map();
  for (const rawDictionary of source) {
    const dictionary = requireObject(rawDictionary, "dictionary metadata");
    const id = boundedString(dictionary.id, "dictionary id", 128);
    if (!id || catalog.has(id)) {
      throw resultError("INVALID_CATALOG", "dictionary IDs must be non-empty and unique");
    }
    const title = boundedString(dictionary.title, "dictionary title", 1024);
    const displayTitle =
      dictionary.displayTitle === undefined
        ? title
        : boundedString(dictionary.displayTitle, "dictionary display title", 1024);
    const types = boundedArray(
      dictionary.types ?? [],
      "dictionary types",
      8,
    ).map((type) => boundedString(type, "dictionary type", 32));
    catalog.set(id, {
      id,
      title,
      displayTitle,
      types,
    });
  }
  return catalog;
}

function requireDictionary(catalog, id) {
  const dictionaryId = boundedString(id, "result dictionary id", 128);
  const dictionary = catalog.get(dictionaryId);
  if (!dictionary) {
    throw resultError(
      "UNKNOWN_DICTIONARY",
      "A native result referenced a dictionary outside the active catalog",
    );
  }
  return dictionary;
}

function normalizeFrequencyValue(rawValue) {
  const value = requireObject(rawValue, "frequency value");
  const numeric = safeInteger(value.value, "frequency value", {
    minimum: -1,
    maximum: 2_147_483_647,
  });
  return {
    value: numeric,
    displayValue: boundedString(
      value.displayValue ?? String(numeric),
      "frequency display value",
      1024,
    ),
  };
}

function normalizeTermLookupResult(nativeResponse, options = {}) {
  const response = requireObject(nativeResponse, "lookup response");
  const catalog = normalizeCatalog(options.dictionaries);
  const catalogGeneration = safeInteger(
    response.catalogGeneration,
    "catalog generation",
    { minimum: 1 },
  );
  const requestGeneration = safeInteger(
    response.requestGeneration,
    "request generation",
  );
  const matchedLength = safeInteger(response.matchedLength, "matched length", {
    maximum: 4096,
  });
  const nativeElapsedMs = safeInteger(response.elapsedMs, "native elapsed time", {
    maximum: 3_600_000,
  });
  const results = boundedArray(response.results, "lookup results", MAX_RESULTS);

  const entries = results.map((rawResult, rank) => {
    const result = requireObject(rawResult, "lookup result");
    const term = requireObject(result.term, "term result");
    const expression = boundedString(term.expression, "term expression");
    const reading = boundedString(term.reading, "term reading");
    const matched = boundedString(result.matched, "matched text");
    const deinflected = boundedString(result.deinflected, "deinflected text");
    const process = boundedArray(
      result.process ?? [],
      "deinflection process",
      64,
    ).map((step) => boundedString(step, "deinflection step", 1024));
    const preprocessorSteps = safeInteger(
      result.preprocessorSteps,
      "preprocessor step count",
      { maximum: 1024 },
    );
    const entryId = `hoshi-result-${rank}-${stableHash(
      `${expression}\0${reading}\0${matched}\0${deinflected}`,
    )}`;
    const grouped = new Map();

    const ensureGroup = (dictionaryId) => {
      const metadata = requireDictionary(catalog, dictionaryId);
      let group = grouped.get(metadata.id);
      if (!group) {
        group = {
          id: `${entryId}-dictionary-${stableHash(metadata.id)}`,
          dictionaryId: metadata.id,
          title: metadata.title,
          displayTitle: metadata.displayTitle,
          glossaries: [],
          frequencies: [],
          pitches: [],
        };
        grouped.set(metadata.id, group);
      }
      return group;
    };

    const glossaries = boundedArray(
      term.glossaries ?? [],
      "term glossaries",
      MAX_GLOSSARIES_PER_RESULT,
    );
    for (const [glossaryIndex, rawGlossary] of glossaries.entries()) {
      const glossary = requireObject(rawGlossary, "term glossary");
      const group = ensureGroup(glossary.dictionary);
      group.glossaries.push({
        id: `${entryId}-glossary-${stableHash(
          `${group.dictionaryId}\0${glossaryIndex}\0${String(glossary.glossary)}`,
        )}`,
        content: boundedString(
          glossary.glossary,
          "glossary content",
          MAX_STRING_BYTES,
        ),
        definitionTags: splitTags(
          glossary.definitionTags ?? "",
          "definition tags",
        ),
        termTags: splitTags(glossary.termTags ?? "", "term tags"),
      });
    }

    const frequencies = boundedArray(
      term.frequencies ?? [],
      "frequency metadata",
      MAX_METADATA_PER_RESULT,
    );
    for (const rawFrequency of frequencies) {
      const frequency = requireObject(rawFrequency, "frequency metadata");
      const group = ensureGroup(frequency.dictionary);
      const values = boundedArray(
        frequency.values ?? [],
        "frequency values",
        MAX_METADATA_PER_RESULT,
      );
      group.frequencies.push(...values.map(normalizeFrequencyValue));
    }

    const pitches = boundedArray(
      term.pitches ?? [],
      "pitch metadata",
      MAX_METADATA_PER_RESULT,
    );
    for (const rawPitch of pitches) {
      const pitch = requireObject(rawPitch, "pitch metadata");
      const group = ensureGroup(pitch.dictionary);
      const positions = boundedArray(
        pitch.positions ?? [],
        "pitch positions",
        128,
      );
      for (const position of positions) {
        group.pitches.push(
          safeInteger(position, "pitch position", { maximum: 4096 }),
        );
      }
    }

    return {
      id: entryId,
      rank,
      expression,
      reading,
      matched,
      deinflected,
      deinflectionReason: process.join(" > "),
      process,
      preprocessorSteps,
      partOfSpeech: splitTags(term.rules ?? "", "part-of-speech tags"),
      dictionaries: Array.from(grouped.values()),
    };
  });

  return deepFreeze({
    catalogGeneration,
    requestGeneration,
    matchedLength,
    nativeElapsedMs,
    entries,
  });
}

module.exports = {
  HoshiDictsResultModelError,
  MAX_GLOSSARIES_PER_RESULT,
  MAX_RESULTS,
  deepFreeze,
  normalizeTermLookupResult,
  stableHash,
};
