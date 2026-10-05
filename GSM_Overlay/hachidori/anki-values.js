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
const VALUE_ALIASES = { definition: "glossary", "main-definition": "glossary-first", "jpmn-primary-definition": "glossary-first",
  frequency: "frequencies", "pitch-accent-positions": "pitch-position", "pitch-categories": "pitch-accent-categories" };
const alias = (request, dictionary) => Object.hasOwn(request.dictionaryAliases, dictionary)
  ? request.dictionaryAliases[dictionary] : dictionary;

function expressionFurigana(term, plain) {
  return globalThis.HDGlossary.termFurigana(term).map(({ text, reading }, index) => {
    if (!reading) return escape(text);
    const prefix = index ? " " : "";
    return plain ? `${prefix}${escape(text)}[${escape(reading)}]`
      : `<ruby>${escape(text)}<rt>${escape(reading)}</rt></ruby>`;
  }).join("");
}

function frequencyNumber(frequency) {
  const prefix = typeof frequency.displayValue === "string" ? /^\d+/u.exec(frequency.displayValue) : null;
  const display = prefix ? Number(prefix[0]) : 0;
  return display > 0 ? display : frequency.value;
}

function frequencyAggregate(term, mode, harmonic) {
  const values = [];
  for (const group of term.frequencies) {
    if (group.frequencyMode && group.frequencyMode !== mode) continue;
    for (const frequency of group.frequencies) {
      const value = frequencyNumber(frequency);
      if (value > 0) { values.push(value); break; }
    }
  }
  if (!values.length) return mode === "rank-based" ? "9999999" : "0";
  const mean = harmonic ? values.length / values.reduce((sum, value) => sum + 1 / value, 0)
    : values.reduce((sum, value) => sum + value, 0) / values.length;
  return String(Math.floor(mean));
}

function frequencyHtml(request, groups = request.term.frequencies) {
  const items = groups.flatMap(group => {
    const dictionary = escape(alias(request, group.dictionary));
    return group.frequencies.map(value => `<li>${dictionary}: ${escape(value.displayValue ?? value.value)}</li>`);
  });
  return items.length ? `<ul style="text-align: left;">${items.join("")}</ul>` : "";
}

function singleFrequency(request, dictionary, numeric) {
  const groups = request.term.frequencies.filter(group => group.dictionary === dictionary && group.frequencies.length);
  if (numeric) {
    const value = groups.length ? frequencyNumber(groups[0].frequencies[0]) : 0;
    return value > 0 ? String(value) : "";
  }
  return frequencyHtml(request, groups);
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
    globalThis.HDGlossary.pitchAccentCategory(reading, pitch, wordClasses)));
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

export async function buildAnkiFields(request, templates, { definition, audio = "" }) {
  const { term } = request;
  let sentenceParts;
  const parts = () => sentenceParts ??= [request.sentence.slice(0, request.matchOffset),
    request.sentence.slice(request.matchOffset, request.matchOffset + request.matched.length),
    request.sentence.slice(request.matchOffset + request.matched.length)].map(escape);
  const sentence = () => { const [prefix, body, suffix] = parts(); return `${prefix}<b>${body}</b>${suffix}`; };
  const firstDictionary = () => term.glossaries[0]?.dictionary || "";
  // The relay API and older linked browsers send no address. Like Yomitan's
  // anki-note-data-creator.js, a missing or non-string one is blank.
  const pageUrl = () => typeof request.pageUrl === "string" ? escape(request.pageUrl) : "";
  const pageLink = () => { const address = pageUrl(); return address && `<a href="${address}">${address}</a>`; };
  const table = {
    expression: () => escape(term.expression), reading: () => escape(term.reading),
    furigana: () => expressionFurigana(term, false), "furigana-plain": () => expressionFurigana(term, true),
    dictionary: () => escape(firstDictionary()), "dictionary-alias": () => escape(alias(request, firstDictionary())),
    glossary: () => definition({}), "glossary-brief": () => definition({ brief: true }),
    "glossary-no-dictionary": () => definition({ noDictionary: true }), "glossary-plain": () => definition({ plain: true }),
    "glossary-plain-no-dictionary": () => definition({ plain: true, noDictionary: true }),
    "glossary-first": () => definition({ firstOnly: true }),
    "glossary-first-brief": () => definition({ firstOnly: true, brief: true }),
    "glossary-first-no-dictionary": () => definition({ firstOnly: true, noDictionary: true }),
    conjugation: () => request.trace.map(step => escape(step.name)).join(" « ") || escape(term.rules),
    "part-of-speech": () => uniqueTokens([term.rules, ...term.glossaries.map(glossary => glossary.termTags)])
      .map(tag => escape(Object.hasOwn(PARTS_OF_SPEECH, tag) ? PARTS_OF_SPEECH[tag] : tag)).join(", ") || "Unknown",
    tags: () => uniqueTokens(term.glossaries.flatMap(glossary =>
      [...globalThis.HDGlossary.definitionTagList(glossary).map(tag => tag.name), glossary.termTags]))
      .map(tag => `<span class="tag" data-details="${escape(tag)}">${escape(tag)}</span>`).join(", "),
    "phonetic-transcriptions": () => {
      const items = term.pitches.flatMap(group => group.transcriptions).filter(Boolean).map(value =>
        `<li class="pronunciation" data-pronunciation-type="phonetic-transcription">${escape(value)}</li>`);
      return items.length ? `<ul>${items.join("")}</ul>` : "";
    },
    // Yomitan's getMedia keeps a multi-line selection's breaks visible in the HTML field.
    "popup-selection-text": () => escape(request.popupSelectionText).replaceAll("\n", "<br>\n"), "search-query": () => escape(request.searchQuery),
    "document-title": () => escape(request.documentTitle), url: pageLink, "url-plain": pageUrl, sentence,
    // GSM falls back to highlighted text when its optional native tokenizer is
    // unavailable. There is no MeCab/native-helper dependency in the extension.
    "sentence-furigana": sentence, "sentence-furigana-plain": sentence,
    "cloze-prefix": () => parts()[0], "cloze-body": () => parts()[1], "cloze-suffix": () => parts()[2],
    frequencies: () => frequencyHtml(request),
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
      if (variant) value = singleFrequency(request, variant.dictionary, variant.numeric);
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
