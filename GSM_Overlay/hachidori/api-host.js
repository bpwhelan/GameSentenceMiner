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
import { ankiMappedFieldNames, escapeAnkiHtml, resolveAnkiTemplates } from "./anki-templates.js";

export { API_CAPABILITY, API_CLIENT_ORIGIN } from "./sharing-protocol.js";

export const API_REQUESTS = new Set([
  "hd_api_version", "hd_api_term_entries", "hd_api_kanji_entries", "hd_api_anki_fields", "hd_api_anki_card_formats",
  "hd_api_tokenize", "hd_api_dictionaries", "hd_api_dictionary_open", "hd_api_dictionary_read", "hd_api_dictionary_close",
]);

const AUDIO_TYPES = { aac: "audio/aac", flac: "audio/flac", m4a: "audio/mp4", mp3: "audio/mpeg", ogg: "audio/ogg",
  wav: "audio/wav", webm: "audio/webm" };

function words(value) {
  return globalThis.HDGlossary.parseTagList(value);
}

function strings(value) {
  return Array.isArray(value) ? value.filter(item => typeof item === "string") : [];
}

// Yomitan's Tag, with a tag-bank tag's category, order, score and notes when
// the engine's reply has one.
function tag(name, dictionary, { category = "", order = 0, score = 0, notes = "" } = {}) {
  return { name, category, order, score, content: notes ? [notes] : [], dictionaries: [dictionary], redundant: false };
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
      tags: globalThis.HDGlossary.definitionTagList(glossary).map(entry => tag(entry.name, glossary.dictionary, entry)),
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
      // Yomitan's TermFrequency (translator.js:1725 at d3c54c1): the declared
      // mode, or null when the dictionary declares none.
      frequencyMode: where.frequencyMode(group.dictionary),
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

// Yomitan's kanji fields API retains its dictionary-entry output format.
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
  return Object.fromEntries(markers.map(marker => [marker, Object.hasOwn(table, marker.toLowerCase()) ? table[marker.toLowerCase()]() : ""]));
}

// Yomitan's AnkiCardFormat for one Anki Template. A Template has no add-button
// icon; a legacy mapping answers the rows mining builds from it. Only these
// keys leave the browser.
function cardFormat(template) {
  const fields = template.fieldTemplates
    ?? resolveAnkiTemplates(template, ankiMappedFieldNames(template)).templates;
  return {
    name: template.name,
    icon: "big-circle",
    deck: template.deck,
    model: template.model,
    fields: Object.fromEntries(Object.entries(fields)
      .map(([field, { value, overwriteMode }]) => [field, { value, overwriteMode }])),
    type: "term",
  };
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
// its error. `readDictionaries(profileId)` is a profile's dictionary list,
// `readAudioSources(profileId)` its enabled pronunciation sources,
// `readAnkiTemplates(profileId)` its Anki Templates in Settings order and
// `readSmallerAnkiCards()` whether Smaller Anki cards is on and
// `readCompactGlossaries()` whether Compact glossaries is Compact popup and Anki.
// `resolveProfile(profileIndex)` names the profile a Yomitan profile index
// selects, as { profileId } (undefined while the records have no profiles),
// or null for an index that names none (docs/languages.md 12).
// `readProfile(profileId)` is that profile's { language, packSettings }, whose
// language its notes and readings follow, null while the records have no profiles.
// What every result's mining request shares (docs/languages.md 12): each
// dictionary's target language, which a profile's notes follow, beside the
// display names, ids and frequency dictionaries.
function termContext(where, profile, generation, text) {
  const targets = profile === null ? {} : { dictionaryTargetLanguages: Object.fromEntries(where.dictionaries
    .filter(item => typeof item.targetLanguage === "string" && item.targetLanguage).map(item => [item.title, item.targetLanguage])) };
  return {
    generation, text,
    frequencyModes: new Map(where.dictionaries.map(item => [item.title, item.frequencyMode])),
    shared: {
      dictionaryAliases: Object.fromEntries(where.dictionaries.filter(item => item.displayName).map(item => [item.title, item.displayName])),
      dictionaryIds: Object.fromEntries(where.dictionaries.map(item => [item.title, item.id])),
      frequencyDictionaries: where.dictionaries.filter(item => item.enabled && item.frequencyCount > 0).map(item => item.title),
      ...targets,
    },
  };
}

// One result's mining request, as the popup builds it.
function termRequest(result, context) {
  const term = { ...result.term, frequencies: result.term.frequencies.map(group =>
    ({ ...group, frequencyMode: context.frequencyModes.get(group.dictionary) })) };
  return { ...result, term, generation: context.generation, sentence: context.text, matchOffset: 0, matched: result.matched,
    searchQuery: context.text, popupSelectionText: "", documentTitle: "", ...context.shared };
}

// A match's segments: its furigana, or the matched text without a reading.
function matchedSegments(best, ruby) {
  return ruby ? globalThis.HDGlossary.matchedFurigana(best.term, best.matched) : [{ text: best.matched, reading: "" }];
}

export function createApiHost({ engine, render, readDictionaries, readAudioSources, readAnkiTemplates, readSmallerAnkiCards, version,
  readCompactGlossaries = async () => false,
  resolveProfile = async profileIndex => (profileIndex === 0 ? { profileId: undefined } : null),
  readProfile = async () => null }) {
  // Engine requests made for a profile name it (docs/languages.md 9.3).
  const named = (profileId, fields) => (profileId === undefined ? fields : { ...fields, profileId });

  async function whereabouts(profileId) {
    const dictionaries = await readDictionaries(profileId);
    const titles = dictionaries.map(item => item.title);
    return {
      dictionaries,
      index: title => Math.max(0, titles.indexOf(title)),
      alias: title => dictionaries.find(item => item.title === title)?.displayName || title,
      frequencyMode: title => dictionaries.find(item => item.title === title)?.frequencyMode || null,
    };
  }

  async function lookup(profileId, text, fields = {}) {
    const reply = await engine(named(profileId, { type: "hd_lookup", text, ...fields }));
    return { results: reply.results, generation: reply.generation };
  }

  async function ankiTermFields(profileId, text, markers, maxEntries, includeMedia) {
    const where = await whereabouts(profileId);
    const profile = await readProfile(profileId);
    const { results, generation } = await lookup(profileId, text, maxEntries > 0 ? { maxResults: maxEntries } : {});
    const context = termContext(where, profile, generation, text);
    const dictionaryPaths = Object.fromEntries(where.dictionaries.filter(item => item.enabled !== false)
      .map(item => [item.title, item.path]));
    const templates = Object.fromEntries(markers.map(marker => [marker, { value: `{${marker}}`, overwriteMode: "coalesce" }]));
    const compactGlossary = await readSmallerAnkiCards();
    const compactGlossaries = await readCompactGlossaries();
    const fields = [], dictionaryMedia = [], audioMedia = [];
    const seenMedia = new Set();
    for (const result of maxEntries > 0 ? results.slice(0, maxEntries) : results) {
      const request = termRequest(result, context);
      const sound = markers.some(marker => marker.toLowerCase() === "audio") && includeMedia ? await termAudio(profileId, profile, result) : null; // NOSONAR: results render one at a time, in order
      if (sound) audioMedia.push(sound.media);
      const built = await render({ type: "hd_anki_fields", request, templates, audio: sound?.audio ?? "", dictionaryPaths, // NOSONAR: results render one at a time, in order
        compactGlossary, compactGlossaries, ...(profile === null ? {} : { profile }) });
      fields.push(Object.fromEntries(markers.map(marker => [marker, built.fields[marker] ?? ""])));
      if (includeMedia) dictionaryMedia.push(...await shownDictionaryMedia(built.media, fields.at(-1), seenMedia, generation)); // NOSONAR: results render one at a time, in order
    }
    return { fields, dictionaryMedia, audioMedia };
  }

  // A result's pronunciation as a sound tag and its media, or null.
  async function termAudio(profileId, profile, result) {
    const sources = await readAudioSources(profileId);
    if (!sources.length) return null;
    const prepared = await render({ type: "hd_anki_audio", term: result.term, sources, recordSpeech: false,
      ...(profile === null ? {} : { language: profile.language }) }).catch(() => null);
    if (typeof prepared?.filename !== "string" || typeof prepared.data !== "string") return null;
    const extension = prepared.filename.split(".").at(-1).toLowerCase();
    return { audio: `[sound:${prepared.filename}]`, media: { term: result.term.expression, reading: result.term.reading,
      mediaType: AUDIO_TYPES[extension] ?? "application/octet-stream", content: prepared.data, ankiFilename: prepared.filename } };
  }

  // Only the images these fields show, as mining uploads only those:
  // Smaller Anki cards leaves hidden content out, with any image in it.
  async function shownDictionaryMedia(media, noteFields, seenMedia, generation) {
    const shown = Object.values(noteFields);
    const found = [];
    for (const item of media) {
      if (seenMedia.has(item.filename) || !shown.some(value => value.includes(item.filename))) continue;
      seenMedia.add(item.filename);
      const reply = await engine({ type: "hd_media", dictionary: item.dictionary, path: item.path, generation }); // NOSONAR: media files are read one at a time
      const match = typeof reply.dataUrl === "string" ? /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/u.exec(reply.dataUrl) : null;
      if (match) found.push({ dictionary: item.dictionary, path: item.path, mediaType: match[1], content: match[2], ankiFilename: item.filename });
    }
    return found;
  }

  async function ankiKanjiFields(profileId, text, markers, maxEntries) {
    const where = await whereabouts(profileId);
    const character = [...text][0] ?? "";
    const reply = await engine(named(profileId, { type: "hd_kanji", character }));
    const entries = reply.kanji?.entries ?? [];
    return { fields: (maxEntries > 0 ? entries.slice(0, maxEntries) : entries).map(entry => kanjiFields(character, entry, markers, where)),
      dictionaryMedia: [], audioMedia: [] };
  }

  async function tokenize(profileId, text, index, scanLength) {
    // A language without ruby gives its words no reading (docs/languages.md 12).
    const profile = await readProfile(profileId);
    const ruby = profile === null
      || globalThis.HDReaderOptions.optionRequirementMet("ruby", profile.language, profile.packSettings);
    const lines = [];
    for (const line of text.split("\n")) lines.push(await tokenizeLine(profileId, line, scanLength, ruby)); // NOSONAR: lines are read one at a time, in order
    return { id: "scan", source: "scanning-parser", dictionary: null, index, content: lines };
  }

  async function tokenizeLine(profileId, line, scanLength, ruby) {
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
      const { results } = await lookup(profileId, rest, { maxResults: 1, ...(scanLength ? { scanLength } : {}) }); // NOSONAR: each lookup starts where the last match ended
      const best = results[0];
      if (!best || !best.matched || !rest.startsWith(best.matched)) {
        const step = String.fromCodePoint(rest.codePointAt(0));
        plain(step);
        position += step.length;
        continue;
      }
      for (const segment of matchedSegments(best, ruby)) {
        if (segment.reading === "") plain(segment.text);
        else segments.push({ text: segment.text, reading: segment.reading });
      }
      position += best.matched.length;
    }
    return segments;
  }

  const handlers = {
    hd_api_version: () => ({ version }),

    async hd_api_term_entries(message, profileId) {
      const terms = requireStrings(message.terms, "terms");
      const where = await whereabouts(profileId);
      const results = [];
      for (const [index, text] of terms.entries()) {
        const found = text === "" ? [] : (await lookup(profileId, text)).results; // NOSONAR: terms are looked up one at a time, in order
        results.push({ index, dictionaryEntries: found.map(result => termEntry(result, where)),
          originalTextLength: found[0]?.matched.length ?? 0 });
      }
      return { results };
    },

    async hd_api_kanji_entries(message, profileId) {
      const characters = requireStrings(message.characters, "characters");
      const where = await whereabouts(profileId);
      const results = [];
      for (const [index, text] of characters.entries()) {
        const entries = [];
        for (const character of [...text]) {
          const reply = await engine(named(profileId, { type: "hd_kanji", character })); // NOSONAR: characters are looked up one at a time, in order
          for (const entry of reply.kanji?.entries ?? []) entries.push(kanjiEntry(character, entry, where));
        }
        results.push({ index, dictionaryEntries: entries });
      }
      return { results };
    },

    async hd_api_anki_fields(message, profileId) {
      const text = requireText(message.text, "text");
      const markers = requireStrings(message.markers, "markers");
      const maxEntries = Number.isSafeInteger(message.maxEntries) && message.maxEntries > 0 ? message.maxEntries : 0;
      const includeMedia = message.includeMedia === true;
      if (message.entryType === "kanji") return ankiKanjiFields(profileId, text, markers, maxEntries);
      if (message.entryType !== "term") throw new Error(`unsupported entry type ${JSON.stringify(message.entryType)}`);
      return ankiTermFields(profileId, text, markers, maxEntries, includeMedia);
    },

    // Each profile has its own Templates; Yomitan's profile 0 is Japanese's.
    async hd_api_anki_card_formats(message, profileId) {
      return { cardFormats: (await readAnkiTemplates(profileId)).map(cardFormat) };
    },

    async hd_api_tokenize(message, profileId) {
      const texts = requireStrings(message.texts, "texts");
      const scanLength = Number.isSafeInteger(message.scanLength) && message.scanLength > 0 ? message.scanLength : 0;
      const results = [];
      for (const [index, text] of texts.entries()) results.push(await tokenize(profileId, text, index, scanLength)); // NOSONAR: texts are read one at a time, in order
      return { results };
    },

    async hd_api_dictionaries(message, profileId) {
      const dictionaries = await readDictionaries(profileId);
      return { dictionaries: dictionaries.map(item => ({ id: item.id, title: item.title, revision: item.revision,
        fileName: fileName(item.title) })) };
    },

    async hd_api_dictionary_open(message, profileId) {
      const id = requireText(message.id, "id");
      const dictionary = (await readDictionaries(profileId)).find(item => item.id === id);
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

  // Downloads stream an archive their open already chose.
  const UNPROFILED = new Set(["hd_api_version", "hd_api_dictionary_read", "hd_api_dictionary_close"]);

  return async function answerApiRequest(message) {
    if (!Object.hasOwn(handlers, message.type)) throw new Error(`unsupported API request ${JSON.stringify(message.type)}`);
    if (UNPROFILED.has(message.type)) return handlers[message.type](message, undefined);
    let profile = await resolveProfile(message.profileIndex ?? 0);
    if (profile === null) {
      if (message.type === "hd_api_anki_card_formats") {
        throw new Error(`Invalid input for ankiCardFormats, expected "profileIndex" to be a valid profile index but got ${message.profileIndex}`);
      }
      // Other requests have always answered from profile 0 whatever index they named.
      profile = await resolveProfile(0);
    }
    return handlers[message.type](message, profile.profileId);
  };
}
