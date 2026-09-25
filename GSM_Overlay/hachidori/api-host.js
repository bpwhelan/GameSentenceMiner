/*
 * Host side of the relay's Yomitan-compatible API (hachidori-anki
 * docs/host-contract.md). The relay connects as a sharing client that lives
 * inside Anki and forwards each HTTP request as an `hd_api_*` runtime message;
 * this module answers them from the engine's results, projected onto the
 * shapes Yomitan's own API produces so existing tools work unchanged.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./render/glossary.js";
import { escapeAnkiHtml } from "./anki-templates.js";

export { API_CAPABILITY, API_CLIENT_ORIGIN } from "./sharing-protocol.js";

export const API_REQUESTS = new Set([
  "hd_api_version", "hd_api_term_entries", "hd_api_kanji_entries", "hd_api_anki_fields", "hd_api_tokenize",
  "hd_api_dictionaries", "hd_api_dictionary_open", "hd_api_dictionary_read", "hd_api_dictionary_close",
]);

const AUDIO_TYPES = { aac: "audio/aac", flac: "audio/flac", m4a: "audio/mp4", mp3: "audio/mpeg", ogg: "audio/ogg",
  wav: "audio/wav", webm: "audio/webm" };

function words(value) {
  return String(value ?? "").split(/\s+/u).filter(Boolean);
}

function strings(value) {
  return Array.isArray(value) ? value.filter(item => typeof item === "string") : [];
}

function tag(name, dictionary) {
  return { name, category: "", order: 0, score: 0, content: [], dictionaries: [dictionary], redundant: false };
}

function parseGlossary(text) {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [String(text)];
  }
}

// Yomitan's TermDictionaryEntry, as far as the engine's result carries it.
function termEntry(result, where) {
  const { term, matched, deinflected, trace } = result;
  const first = term.glossaries[0]?.dictionary ?? "";
  const headwordTags = [...new Set(term.glossaries.flatMap(glossary => words(glossary.termTags)))];
  return {
    type: "term",
    isPrimary: true,
    textProcessorRuleChainCandidates: [[]],
    inflectionRuleChainCandidates: [{
      source: "dictionary",
      inflectionRules: trace.map(step => ({ name: step.name, description: step.description })),
    }],
    score: term.score,
    frequencyOrder: 0,
    dictionaryIndex: where.index(first),
    dictionaryAlias: where.alias(first),
    sourceTermExactMatchCount: matched === term.expression ? 1 : 0,
    matchPrimaryReading: false,
    maxOriginalTextLength: matched.length,
    headwords: [{
      index: 0,
      term: term.expression,
      reading: term.reading,
      sources: [{ originalText: matched, transformedText: deinflected, deinflectedText: deinflected,
        matchType: "exact", matchSource: "term", isPrimary: true }],
      tags: headwordTags.map(name => tag(name, first)),
      wordClasses: words(term.rules),
    }],
    definitions: term.glossaries.map((glossary, index) => ({
      index,
      headwordIndices: [0],
      dictionary: glossary.dictionary,
      dictionaryIndex: where.index(glossary.dictionary),
      dictionaryAlias: where.alias(glossary.dictionary),
      id: index,
      score: term.score,
      frequencyOrder: 0,
      sequences: [-1],
      isPrimary: true,
      tags: words(glossary.definitionTags).map(name => tag(name, glossary.dictionary)),
      entries: parseGlossary(glossary.glossary),
    })),
    pronunciations: term.pitches.map(group => ({
      headwordIndex: 0,
      dictionary: group.dictionary,
      dictionaryIndex: where.index(group.dictionary),
      dictionaryAlias: where.alias(group.dictionary),
      pronunciations: [
        ...group.pitches.map(pitch => ({ type: "pitch-accent", positions: pitch.position,
          nasalPositions: pitch.nasal, devoicePositions: pitch.devoice, tags: [] })),
        ...group.transcriptions.map(ipa => ({ type: "phonetic-transcription", ipa, tags: [] })),
      ],
    })),
    frequencies: term.frequencies.flatMap(group => group.frequencies.map(value => ({
      index: 0,
      headwordIndex: 0,
      dictionary: group.dictionary,
      dictionaryIndex: where.index(group.dictionary),
      dictionaryAlias: where.alias(group.dictionary),
      hasReading: false,
      frequency: value.value,
      displayValue: value.displayValue || null,
      displayValueParsed: false,
    }))).map((entry, index) => ({ ...entry, index })),
  };
}

function kanjiEntry(character, entry, where) {
  const stats = entry.stats.map(stat => ({ name: stat.name, category: "misc", content: "", order: 0, score: 0,
    dictionary: entry.dictionary, value: stat.value }));
  return {
    type: "kanji",
    character,
    dictionary: entry.dictionary,
    dictionaryIndex: where.index(entry.dictionary),
    dictionaryAlias: where.alias(entry.dictionary),
    onyomi: words(entry.onyomi),
    kunyomi: words(entry.kunyomi),
    tags: words(entry.tags).map(name => tag(name, entry.dictionary)),
    stats: stats.length ? { misc: stats } : {},
    definitions: strings(entry.definitions),
    frequencies: [],
  };
}

// Yomitan's kanji note fields have no counterpart in mining, which is term-only.
function kanjiFields(character, entry, markers, where) {
  const stat = name => entry.stats.find(item => item.name === name)?.value ?? "";
  const table = {
    character: () => escapeAnkiHtml(character),
    dictionary: () => escapeAnkiHtml(entry.dictionary),
    "dictionary-alias": () => escapeAnkiHtml(where.alias(entry.dictionary)),
    onyomi: () => words(entry.onyomi).map(escapeAnkiHtml).join(", "),
    kunyomi: () => words(entry.kunyomi).map(escapeAnkiHtml).join(", "),
    glossary: () => `<ul>${strings(entry.definitions).map(text => `<li>${escapeAnkiHtml(text)}</li>`).join("")}</ul>`,
    tags: () => words(entry.tags).map(escapeAnkiHtml).join(", "),
    "stroke-count": () => escapeAnkiHtml(stat("strokes")),
    frequencies: () => escapeAnkiHtml(stat("freq")),
  };
  return Object.fromEntries(markers.map(marker => [marker, Object.hasOwn(table, marker) ? table[marker]() : ""]));
}

// Yomitan's distributeFuriganaInflected: the reading covers the stem shared by
// the dictionary form and the matched text; the inflected ending has none.
function furiganaSegments(expression, reading, matched) {
  const { segmentFurigana } = globalThis.HDGlossary;
  if (matched === expression) return segmentFurigana(expression, reading);
  let stem = 0;
  while (stem < expression.length && stem < matched.length && expression[stem] === matched[stem]) stem += 1;
  const ending = expression.slice(stem);
  if (stem === 0 || !reading.endsWith(ending)) return [{ text: matched, reading }];
  return [...segmentFurigana(expression.slice(0, stem), reading.slice(0, reading.length - ending.length)),
    { text: matched.slice(stem), reading: "" }];
}

function fileName(title) {
  const safe = String(title).replaceAll(/[\\/:*?"<>|\u0000-\u001f]/gu, "_").trim();
  return `${safe || "dictionary"}.hachidori.zip`;
}

function requireText(value, name) {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function requireStrings(value, name) {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw new Error(`${name} must be an array of strings`);
  return value;
}

// `engine(fields)` answers a "hoshidicts-offscreen" request, `render(fields)`
// a "hachidori-anki-render" one; both resolve to the reply envelope or throw
// its error. `readDictionaries()` is the stored dictionary list and
// `readAudioSources()` the enabled pronunciation sources.
export function createApiHost({ engine, render, readDictionaries, readAudioSources, version }) {
  async function whereabouts() {
    const dictionaries = await readDictionaries();
    const titles = dictionaries.map(item => item.title);
    return {
      dictionaries,
      index: title => Math.max(0, titles.indexOf(title)),
      alias: title => dictionaries.find(item => item.title === title)?.displayName || title,
    };
  }

  async function lookup(text, fields = {}) {
    const reply = await engine({ type: "hd_lookup", text, ...fields });
    return { results: reply.results, generation: reply.generation };
  }

  async function ankiTermFields(text, markers, maxEntries, includeMedia) {
    const where = await whereabouts();
    const { results, generation } = await lookup(text, maxEntries > 0 ? { maxResults: maxEntries } : {});
    const enabled = where.dictionaries.filter(item => item.enabled !== false);
    const dictionaryPaths = Object.fromEntries(enabled.map(item => [item.title, item.path]));
    const frequencyModes = new Map(where.dictionaries.map(item => [item.title, item.frequencyMode]));
    const templates = Object.fromEntries(markers.map(marker => [marker, { value: `{${marker}}`, overwriteMode: "coalesce" }]));
    const fields = [], dictionaryMedia = [], audioMedia = [];
    const seenMedia = new Set();
    for (const result of maxEntries > 0 ? results.slice(0, maxEntries) : results) {
      const term = { ...result.term, frequencies: result.term.frequencies.map(group =>
        ({ ...group, frequencyMode: frequencyModes.get(group.dictionary) })) };
      const request = { ...result, term, generation, sentence: text, matchOffset: 0, matched: result.matched,
        searchQuery: text, popupSelectionText: "", documentTitle: "",
        dictionaryAliases: Object.fromEntries(where.dictionaries.filter(item => item.displayName).map(item => [item.title, item.displayName])),
        dictionaryIds: Object.fromEntries(where.dictionaries.map(item => [item.title, item.id])),
        frequencyDictionaries: where.dictionaries.filter(item => item.enabled && item.frequencyCount > 0).map(item => item.title) };
      let audio = "";
      if (markers.includes("audio") && includeMedia) {
        const sources = await readAudioSources();
        const prepared = sources.length
          ? await render({ type: "hd_anki_audio", term: result.term, sources, recordSpeech: false }).catch(() => null)
          : null;
        if (typeof prepared?.filename === "string" && typeof prepared.data === "string") {
          audio = `[sound:${prepared.filename}]`;
          const extension = prepared.filename.split(".").at(-1).toLowerCase();
          audioMedia.push({ term: term.expression, reading: term.reading,
            mediaType: AUDIO_TYPES[extension] ?? "application/octet-stream", content: prepared.data, ankiFilename: prepared.filename });
        }
      }
      const built = await render({ type: "hd_anki_fields", request, templates, audio, dictionaryPaths });
      fields.push(Object.fromEntries(markers.map(marker => [marker, built.fields[marker] ?? ""])));
      if (!includeMedia) continue;
      for (const item of built.media) {
        if (seenMedia.has(item.filename)) continue;
        seenMedia.add(item.filename);
        const reply = await engine({ type: "hd_media", dictionary: item.dictionary, path: item.path, generation });
        const match = typeof reply.dataUrl === "string" ? /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/u.exec(reply.dataUrl) : null;
        if (!match) continue;
        dictionaryMedia.push({ dictionary: item.dictionary, path: item.path, mediaType: match[1], content: match[2], ankiFilename: item.filename });
      }
    }
    return { fields, dictionaryMedia, audioMedia };
  }

  async function ankiKanjiFields(text, markers, maxEntries) {
    const where = await whereabouts();
    const character = [...text][0] ?? "";
    const reply = await engine({ type: "hd_kanji", character });
    const entries = reply.kanji?.entries ?? [];
    return { fields: (maxEntries > 0 ? entries.slice(0, maxEntries) : entries).map(entry => kanjiFields(character, entry, markers, where)),
      dictionaryMedia: [], audioMedia: [] };
  }

  async function tokenize(text, index, scanLength) {
    const lines = [];
    for (const line of text.split("\n")) {
      const segments = [];
      const plain = (value) => {
        if (value === "") return;
        const last = segments.at(-1);
        if (last && last.reading === "") last.text += value;
        else segments.push({ text: value, reading: "" });
      };
      let position = 0;
      while (position < line.length) {
        const rest = line.slice(position);
        const { results } = await lookup(rest, { maxResults: 1, ...(scanLength ? { scanLength } : {}) });
        const best = results[0];
        if (!best || !best.matched || !rest.startsWith(best.matched)) {
          const step = String.fromCodePoint(rest.codePointAt(0));
          plain(step);
          position += step.length;
          continue;
        }
        for (const segment of furiganaSegments(best.term.expression, best.term.reading, best.matched)) {
          if (segment.reading === "") plain(segment.text);
          else segments.push({ text: segment.text, reading: segment.reading });
        }
        position += best.matched.length;
      }
      lines.push(segments);
    }
    return { id: "scan", source: "scanning-parser", dictionary: null, index, content: lines };
  }

  const handlers = {
    hd_api_version: () => ({ version }),

    async hd_api_term_entries(message) {
      const terms = requireStrings(message.terms, "terms");
      const where = await whereabouts();
      const results = [];
      for (const [index, text] of terms.entries()) {
        const found = text === "" ? [] : (await lookup(text)).results;
        results.push({ index, dictionaryEntries: found.map(result => termEntry(result, where)),
          originalTextLength: found[0]?.matched.length ?? 0 });
      }
      return { results };
    },

    async hd_api_kanji_entries(message) {
      const characters = requireStrings(message.characters, "characters");
      const where = await whereabouts();
      const results = [];
      for (const [index, text] of characters.entries()) {
        const entries = [];
        for (const character of [...text]) {
          const reply = await engine({ type: "hd_kanji", character });
          for (const entry of reply.kanji?.entries ?? []) entries.push(kanjiEntry(character, entry, where));
        }
        results.push({ index, dictionaryEntries: entries });
      }
      return { results };
    },

    async hd_api_anki_fields(message) {
      const text = requireText(message.text, "text");
      const markers = requireStrings(message.markers, "markers").map(marker => marker.toLowerCase());
      const maxEntries = Number.isSafeInteger(message.maxEntries) && message.maxEntries > 0 ? message.maxEntries : 0;
      const includeMedia = message.includeMedia === true;
      if (message.entryType === "kanji") return ankiKanjiFields(text, markers, maxEntries);
      if (message.entryType !== "term") throw new Error(`unsupported entry type ${JSON.stringify(message.entryType)}`);
      return ankiTermFields(text, markers, maxEntries, includeMedia);
    },

    async hd_api_tokenize(message) {
      const texts = requireStrings(message.texts, "texts");
      const scanLength = Number.isSafeInteger(message.scanLength) && message.scanLength > 0 ? message.scanLength : 0;
      const results = [];
      for (const [index, text] of texts.entries()) results.push(await tokenize(text, index, scanLength));
      return { results };
    },

    async hd_api_dictionaries() {
      const dictionaries = await readDictionaries();
      return { dictionaries: dictionaries.map(item => ({ id: item.id, title: item.title, revision: item.revision,
        fileName: fileName(item.title) })) };
    },

    async hd_api_dictionary_open(message) {
      const id = requireText(message.id, "id");
      const dictionary = (await readDictionaries()).find(item => item.id === id);
      if (!dictionary) return { error: "unknown dictionary", notFound: true };
      const reply = await engine({ type: "hd_api_dictionary_open", id });
      return { token: reply.token, size: reply.size, fileName: fileName(dictionary.title) };
    },

    async hd_api_dictionary_read(message) {
      const reply = await engine({ type: "hd_api_dictionary_read", token: message.token, offset: message.offset, length: message.length });
      return { data: reply.data, eof: reply.eof };
    },

    async hd_api_dictionary_close(message) {
      await engine({ type: "hd_api_dictionary_close", token: message.token });
      return {};
    },
  };

  return async function answerApiRequest(message) {
    if (!Object.hasOwn(handlers, message.type)) throw new Error(`unsupported API request ${JSON.stringify(message.type)}`);
    return handlers[message.type](message);
  };
}
