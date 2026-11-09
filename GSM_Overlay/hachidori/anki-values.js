// SPDX-License-Identifier: GPL-3.0-or-later
import "./render/glossary.js";
import { ankiPitchGraphs } from "./anki-pitch.js";
import { ankiTemplateMarkerNames, renderAnkiTemplate, escapeAnkiHtml as escape } from "./anki-templates.js";

// Browser-native port of GSM PR #549's hoshidicts_mining.py marker values.
// DOM glossary rendering and resource preparation remain separate; only values
// actually used by the selected templates are built here.
// Tags split on U+0020 as in HDGlossary.parseTagList, so a U+00A0 inside a
// Jitendex tag name ("rarely used form") stays one tag.
const uniqueTokens = values => [...new Set(values.flatMap(value => value.split(/[ ,]+/u).filter(Boolean)))];
// Keep this sanitizer unchanged: frequency and existing title-based glossary
// marker mappings depend on its exact output.
const dictionaryMarker = name => name.replace(/[_\s]/gu, "-").replace(/[^\p{L}\p{N}-]/gu, "")
  .replace(/-+/gu, "-").replace(/^-|-$/gu, "").toLowerCase();
const normalisedDictionaryMarker = name => typeof name === "string"
  ? dictionaryMarker(name.normalize("NFKC")) : "";
const dictionaryIdMarker = id => /^[0-9a-f]{32}$/u.test(id) ? `id--${id}` : "";
const GLOSSARY_MARKER_PREFIX = "single-glossary-";
const GLOSSARY_IDENTITY_PHASES = ["legacy", "alias", "id"];
const GLOSSARY_VARIANTS = [
  { ending: "-brief", options: { brief: true } },
  { ending: "-no-dictionary", options: { noDictionary: true } },
  { ending: "-plain", options: { plain: true } },
  { ending: "-plain-no-dictionary", options: { plain: true, noDictionary: true } },
];
const PARTS_OF_SPEECH = { v1: "Ichidan verb", v5: "Godan verb", vk: "Kuru verb", vs: "Suru verb",
  vz: "Zuru verb", "adj-i": "I-adjective", n: "Noun" };
// {part-of-speech} names a language's tags with its pack's labels
// (docs/languages.md 12); the Japanese pack carries the table above.
function partOfSpeechLabels(language) {
  if (language === null) return PARTS_OF_SPEECH;
  const labels = globalThis.HDLanguages?.get?.(language.code)?.host?.anki?.partOfSpeechLabels;
  if (labels && typeof labels === "object" && !Array.isArray(labels)) return labels;
  return language.code === "ja" ? PARTS_OF_SPEECH : {};
}
const VALUE_ALIASES = { definition: "glossary", "main-definition": "glossary-first", "jpmn-primary-definition": "glossary-first",
  frequency: "frequencies", "pitch-accent-positions": "pitch-position", "pitch-categories": "pitch-accent-categories" };
const alias = (request, dictionary) => Object.hasOwn(request.dictionaryAliases, dictionary)
  ? request.dictionaryAliases[dictionary] : dictionary;

function furiganaHtml(segments, plain) {
  return segments.map(({ text, reading }, index) => {
    if (!reading) return escape(text);
    const prefix = index ? " " : "";
    return plain ? `${prefix}${escape(text)}[${escape(reading)}]`
      : `<ruby>${escape(text)}<rt>${escape(reading)}</rt></ruby>`;
  }).join("");
}

const expressionFurigana = (term, plain) => furiganaHtml(globalThis.HDGlossary.termFurigana(term), plain);

// The furigana of `text` from its hd_segment spans: each word read as its
// first headword, as a hover would show it, and the text between them bare.
function spanFurigana(text, spans) {
  const segments = [];
  let position = 0;
  for (const { start, length, candidates } of spans) {
    if (start > position) segments.push({ text: text.slice(position, start), reading: "" });
    segments.push(...globalThis.HDGlossary.matchedFurigana(candidates[0], text.slice(start, start + length)));
    position = start + length;
  }
  if (position < text.length) segments.push({ text: text.slice(position), reading: "" });
  return segments;
}

const frequencyNumber = frequency => globalThis.HDGlossary.frequencyNumber(frequency);

// Yomitan's mode filter (anki-note-data-creator.js:184 at d3c54c1): a dictionary
// that declares no mode counts for both rank and occurrence aggregates.
function frequencyAggregate(term, mode, harmonic) {
  const { frequencyMean, frequencyModeMatches } = globalThis.HDGlossary;
  const mean = frequencyMean(term.frequencies.filter(group => frequencyModeMatches(group.frequencyMode, mode)), harmonic);
  if (mean === null) return mode === "rank-based" ? "9999999" : "0";
  return String(mean);
}

// Under the right-to-left rules of docs/languages.md 12 the list aligns to its
// start and a name with a right-to-left character sits in its own element.
function frequencyHtml(request, groups = request.term.frequencies, rtlRules = false) {
  const items = groups.flatMap(group => {
    const name = alias(request, group.dictionary);
    const dictionary = rtlRules && globalThis.HDGlossary.hasRtlText(name) ? `<span dir="auto">${escape(name)}</span>` : escape(name);
    return group.frequencies.map(value => `<li>${dictionary}: ${escape(value.displayValue ?? value.value)}</li>`);
  });
  if (!items.length) return "";
  const align = rtlRules ? "start" : "left";
  return `<ul style="text-align: ${align};">${items.join("")}</ul>`;
}

function singleFrequency(request, dictionary, numeric, rtlRules) {
  const groups = request.term.frequencies.filter(group => group.dictionary === dictionary && group.frequencies.length);
  if (numeric) {
    const value = groups.length ? frequencyNumber(groups[0].frequencies[0]) : 0;
    return value > 0 ? String(value) : "";
  }
  return frequencyHtml(request, groups, rtlRules);
}

function pitchHtml(term) {
  return term.pitches.map(group => {
    const descriptions = group.pitches.map(pitch => {
      const details = [];
      if (pitch.nasal.length) details.push(`nasal ${pitch.nasal.join(",")}`);
      if (pitch.devoice.length) details.push(`devoice ${pitch.devoice.join(",")}`);
      return (pitch.pattern || `position ${pitch.position}`) + (details.length ? ` (${details.join("; ")})` : "");
    });
    descriptions.push(...group.transcriptions);
    return descriptions.length ? `<b>${escape(group.dictionary)}</b>: ${descriptions.map(escape).join(", ")}` : "";
  }).filter(Boolean).join("<br>");
}

function pitchCategories(term) {
  const reading = term.reading || term.expression;
  const wordClasses = uniqueTokens([term.rules]);
  const categories = term.pitches.flatMap(group => group.pitches.map(pitch =>
    globalThis.HDGlossary.pitchAccentCategory(reading, pitch, wordClasses, term.expression)));
  return [...new Set(categories.filter(Boolean))].join(",");
}

function requestedGlossaryMarkers(requestedNames) {
  const exactRequests = new Map();
  const variantRequests = new Map();
  const candidateBases = new Set();
  for (const name of requestedNames) {
    const key = name.slice(GLOSSARY_MARKER_PREFIX.length);
    exactRequests.set(key, name);
    candidateBases.add(key);
    for (const { ending, options } of GLOSSARY_VARIANTS) {
      if (!key.endsWith(ending)) continue;
      const base = key.slice(0, -ending.length);
      candidateBases.add(base);
      if (!variantRequests.has(base)) variantRequests.set(base, []);
      variantRequests.get(base).push({ name, options });
    }
  }
  return { exactRequests, variantRequests, candidateBases };
}

function glossaryDescriptors(request, candidateBases) {
  const dictionaries = [...new Set(request.term.glossaries.map(glossary => glossary.dictionary))];
  const aliases = request.dictionaryAliases ?? {};
  const wantsId = [...candidateBases].some(key => /^id--[0-9a-f]{32}$/u.test(key));
  return dictionaries.map(dictionary => ({
    dictionary,
    legacy: dictionaryMarker(dictionary),
    alias: Object.hasOwn(aliases, dictionary)
      ? normalisedDictionaryMarker(aliases[dictionary]) : "",
    id: wantsId ? dictionaryIdMarker(request.dictionaryIds?.[dictionary]) : "",
  }));
}

function claimGlossaryOwner(owners, candidateBases, key, dictionary) {
  if (!key || !candidateBases.has(key)) return;
  if (!owners.has(key)) owners.set(key, dictionary);
  else if (owners.get(key) !== dictionary) owners.set(key, null);
}

function glossaryIdentityOwners(descriptors, candidateBases) {
  const owners = new Map();
  for (const descriptor of descriptors) {
    claimGlossaryOwner(owners, candidateBases, descriptor.legacy, descriptor.dictionary);
    if (descriptor.alias !== descriptor.legacy) {
      claimGlossaryOwner(owners, candidateBases, descriptor.alias, descriptor.dictionary);
    }
  }
  return owners;
}

function glossaryIdentity(descriptor, phase, owners) {
  const key = descriptor[phase];
  return phase !== "alias" || owners.get(key) === descriptor.dictionary ? key : "";
}

function resolveGlossaryPhase(resolved, descriptors, phase, owners, exactRequests, variantRequests) {
  for (const descriptor of descriptors) {
    const key = glossaryIdentity(descriptor, phase, owners);
    const name = key ? exactRequests.get(key) : null;
    if (name && !resolved.has(name)) resolved.set(name, { dictionary: descriptor.dictionary });
  }
  // Within each namespace, all exact bases retain precedence over suffix
  // variants and dictionary order matches the former eager map.
  for (const descriptor of descriptors) {
    const key = glossaryIdentity(descriptor, phase, owners);
    for (const match of key ? variantRequests.get(key) ?? [] : []) {
      if (!resolved.has(match.name)) {
        resolved.set(match.name, { dictionary: descriptor.dictionary, ...match.options });
      }
    }
  }
}

function dynamicGlossaries(request, requestedNames) {
  const { exactRequests, variantRequests, candidateBases } = requestedGlossaryMarkers(requestedNames);
  const descriptors = glossaryDescriptors(request, candidateBases);
  const owners = glossaryIdentityOwners(descriptors, candidateBases);
  const resolved = new Map();
  // Complete the legacy namespace before considering new identities so aliases
  // and IDs cannot steal an existing title-derived suffix marker.
  for (const phase of GLOSSARY_IDENTITY_PHASES) {
    resolveGlossaryPhase(resolved, descriptors, phase, owners, exactRequests, variantRequests);
  }
  return resolved;
}

function dynamicFrequencies(request) {
  const variants = new Map();
  for (const dictionary of request.frequencyDictionaries) {
    const key = dictionaryMarker(dictionary);
    if (!key) continue;
    variants.set(`single-frequency-number-${key}`, { dictionary, numeric: true });
    variants.set(`single-frequency-${key}`, { dictionary, numeric: false });
  }
  return variants;
}

// `language` is the language object of the profile the note is mined in, once
// the records have profiles (docs/languages.md 12); without one every value is
// today's.
export async function buildAnkiFields(request, templates, { definition, audio = "", language = null }) {
  const { term } = request;
  // A note mined in a right-to-left profile follows the right-to-left rules.
  const rtlRules = language?.direction === "rtl";
  // Without ruby the furigana markers give the plain headword.
  const ruby = language === null || Boolean(language.capabilities?.ruby);
  let partsOfSpeech;
  const kanjiTokens = value => Array.isArray(value) ? value : globalThis.HDGlossary.parseTagList(value);
  let nativeKanjiEntries;
  const kanjiEntries = () => nativeKanjiEntries ??= term.glossaries.flatMap(glossary => glossary.kanji ? [glossary.kanji] : []);
  const kanjiReadings = key => [...new Set(kanjiEntries().flatMap(entry => kanjiTokens(entry[key])))].map(escape).join(", ");
  let sentenceParts;
  const parts = () => sentenceParts ??= [request.sentence.slice(0, request.matchOffset),
    request.sentence.slice(request.matchOffset, request.matchOffset + request.matched.length),
    request.sentence.slice(request.matchOffset + request.matched.length)].map(escape);
  const sentence = () => { const [prefix, body, suffix] = parts(); return `${prefix}<b>${body}</b>${suffix}`; };
  // The sentence keeps its own direction in any card; the cloze parts stay
  // bare, because isolating each one would break the sentence's order.
  const isolatedSentence = () => (rtlRules ? `<span dir="auto">${sentence()}</span>` : sentence());
  // The matched word takes the reading of the chosen result; the text around
  // it is read from the spans of the Anki worker's hd_segment request. Without
  // spans (the relay API) the sentence is left without furigana.
  const sentenceFurigana = plain => {
    if (!request.sentenceSegments) return sentence();
    const { sentence: text, matchOffset } = request;
    const end = matchOffset + request.matched.length;
    const [prefixSpans, suffixSpans] = request.sentenceSegments;
    const prefix = furiganaHtml(spanFurigana(text.slice(0, matchOffset), prefixSpans), plain);
    const body = furiganaHtml(globalThis.HDGlossary.matchedFurigana(term, text.slice(matchOffset, end)), plain);
    const suffix = furiganaHtml(spanFurigana(text.slice(end), suffixSpans), plain);
    return `${prefix}<b>${body}</b>${suffix}`;
  };
  const firstDictionary = () => term.glossaries[0]?.dictionary || "";
  // The relay API and older linked browsers send no address. Like Yomitan's
  // anki-note-data-creator.js, a missing or non-string one is blank.
  const pageUrl = () => typeof request.pageUrl === "string" ? escape(request.pageUrl) : "";
  const pageLink = () => { const address = pageUrl(); return address && `<a href="${address}">${address}</a>`; };
  const table = {
    expression: () => escape(term.expression), reading: () => escape(term.reading),
    character: () => kanjiEntries().length ? escape(term.expression) : "",
    onyomi: () => kanjiReadings("onyomi"), kunyomi: () => kanjiReadings("kunyomi"),
    "stroke-count": () => escape(kanjiEntries().flatMap(entry => entry.stats ?? [])
      .find(stat => stat.name === "strokes")?.value ?? ""),
    furigana: () => (ruby ? expressionFurigana(term, false) : escape(term.expression)),
    "furigana-plain": () => (ruby ? expressionFurigana(term, true) : escape(term.expression)),
    dictionary: () => escape(firstDictionary()), "dictionary-alias": () => escape(alias(request, firstDictionary())),
    glossary: () => definition({}), "glossary-brief": () => definition({ brief: true }),
    "glossary-no-dictionary": () => definition({ noDictionary: true }), "glossary-plain": () => definition({ plain: true }),
    "glossary-plain-no-dictionary": () => definition({ plain: true, noDictionary: true }),
    "glossary-first": () => definition({ firstOnly: true }),
    "glossary-first-brief": () => definition({ firstOnly: true, brief: true }),
    "glossary-first-no-dictionary": () => definition({ firstOnly: true, noDictionary: true }),
    conjugation: () => request.trace.map(step => escape(step.name)).join(" « ") || escape(term.rules),
    "part-of-speech": () => {
      partsOfSpeech ??= partOfSpeechLabels(language);
      return uniqueTokens([term.rules, ...term.glossaries.map(glossary => glossary.termTags)])
        .map(tag => escape(Object.hasOwn(partsOfSpeech, tag) ? partsOfSpeech[tag] : tag)).join(", ") || "Unknown";
    },
    tags: () => uniqueTokens(term.glossaries.flatMap(glossary =>
      [...globalThis.HDGlossary.definitionTagList(glossary).map(tag => tag.name), glossary.termTags,
        ...(glossary.kanji ? kanjiTokens(glossary.kanji.tags) : [])]))
      .map(tag => `<span class="tag" data-details="${escape(tag)}">${escape(tag)}</span>`).join(", "),
    "phonetic-transcriptions": () => {
      const items = term.pitches.flatMap(group => group.transcriptions).filter(Boolean).map(value =>
        `<li class="pronunciation" data-pronunciation-type="phonetic-transcription">${escape(value)}</li>`);
      return items.length ? `<ul>${items.join("")}</ul>` : "";
    },
    // Yomitan's getMedia keeps a multi-line selection's breaks visible in the HTML field.
    "popup-selection-text": () => escape(request.popupSelectionText).replaceAll("\n", "<br>\n"), "search-query": () => escape(request.searchQuery),
    "document-title": () => escape(request.documentTitle), url: pageLink, "url-plain": pageUrl, sentence: isolatedSentence,
    "sentence-furigana": () => sentenceFurigana(false), "sentence-furigana-plain": () => sentenceFurigana(true),
    "cloze-prefix": () => parts()[0], "cloze-body": () => parts()[1], "cloze-suffix": () => parts()[2],
    frequencies: () => frequencyHtml(request, request.term.frequencies, rtlRules),
    "frequency-harmonic-rank": () => frequencyAggregate(term, "rank-based", true),
    "frequency-harmonic-occurrence": () => frequencyAggregate(term, "occurrence-based", true),
    "frequency-average-rank": () => frequencyAggregate(term, "rank-based", false),
    "frequency-average-occurrence": () => frequencyAggregate(term, "occurrence-based", false),
    pitch: () => pitchHtml(term), "pitch-position": () => [...new Set(term.pitches.flatMap(group =>
      group.pitches.map(value => globalThis.HDGlossary.pitchAccentDownstep(value))))].join(", "),
    "pitch-accent-graphs": () => ankiPitchGraphs(term),
    "pitch-accent-graphs-jj": () => ankiPitchGraphs(term, true),
    "pitch-accent-categories": () => pitchCategories(term), audio: () => audio,
    // The viewport screenshot this mining request was made from.
    // upload that failed marks itself unavailable, and the field stays empty
    // rather than referring to a picture Anki does not have.
    screenshot: () => request.screenshot?.filename && !request.captureUnavailable?.includes("screenshot")
      ? `<img src="${escape(request.screenshot.filename)}">` : "",
    // Experimental Netflix and YouTube mining: the recorded subtitle line, on
    // the same terms as the screenshot.
    "sentence-audio": () => request.sentenceAudio?.filename && !request.captureUnavailable?.includes("sentence-audio")
      ? `[sound:${escape(request.sentenceAudio.filename)}]` : "",
    // Experimental Netflix and YouTube mining: the line's animated GIF when one
    // was recorded, otherwise the screenshot's <img>. Off a subtitle line, with
    // the switch off, or when the line could not be recorded there is no GIF,
    // so a Picture field mapped to {gif} still gets the screenshot. A held GIF
    // that Anki could not store leaves the field empty instead: the screenshot
    // was released unstored, because no field referenced it.
    gif: () => {
      if (!request.gif?.filename) return table.screenshot();
      return request.captureUnavailable?.includes("gif") ? "" : `<img src="${escape(request.gif.filename)}">`;
    },
  };
  const values = new Map();
  let glossaries, frequencies;
  const glossaryMarkerNames = new Set();
  const planned = Object.entries(templates).map(([field, template]) => {
    const names = new Set(ankiTemplateMarkerNames(template.value));
    for (const name of names) {
      if (name.startsWith(GLOSSARY_MARKER_PREFIX)) glossaryMarkerNames.add(name);
    }
    return { field, template, names, markers: {} };
  });
  function valueFor(name) {
    if (Object.hasOwn(VALUE_ALIASES, name)) return valueFor(VALUE_ALIASES[name]);
    if (values.has(name)) return values.get(name);
    let value = "";
    if (Object.hasOwn(table, name)) value = table[name]();
    else if (name.startsWith(GLOSSARY_MARKER_PREFIX)) {
      glossaries ??= dynamicGlossaries(request, glossaryMarkerNames);
      if (glossaries.has(name)) value = definition(glossaries.get(name));
    } else if (name.startsWith("single-frequency-")) {
      frequencies ??= dynamicFrequencies(request);
      const variant = frequencies.get(name);
      if (variant) value = singleFrequency(request, variant.dictionary, variant.numeric, rtlRules);
    }
    values.set(name, value);
    return value;
  }
  const pending = [];
  for (const { names, markers } of planned) {
    for (const name of names) {
      const value = valueFor(name);
      if (value && typeof value.then === "function") pending.push(value.then(resolved => { markers[name] = resolved; }));
      else markers[name] = value;
    }
  }
  // Only glossary/resource values need asynchronous settlement. Ordinary text
  // and frequency templates should not create a promise per field and marker.
  if (pending.length) await Promise.all(pending);
  return Object.fromEntries(planned.map(({ field, template, markers }) => [field, renderAnkiTemplate(template.value, markers)]));
}
