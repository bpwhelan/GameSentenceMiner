// SPDX-License-Identifier: GPL-3.0-or-later
import "./render/glossary.js";
import { ankiTemplateMarkerNames, renderAnkiTemplate, escapeAnkiHtml as escape } from "./anki-templates.js";

// Browser-native port of GSM PR #549's hoshidicts_mining.py marker values.
// DOM glossary rendering and resource preparation remain separate; only values
// actually used by the selected templates are built here.
const uniqueTokens = values => [...new Set(values.flatMap(value => value.split(/[\s,]+/u).filter(Boolean)))];
const dictionaryMarker = name => name.replace(/[_\s]/gu, "-").replace(/[^\p{L}\p{N}-]/gu, "")
  .replace(/-+/gu, "-").replace(/^-|-$/gu, "").toLowerCase();
const PARTS_OF_SPEECH = { v1: "Ichidan verb", v5: "Godan verb", vk: "Kuru verb", vs: "Suru verb",
  vz: "Zuru verb", "adj-i": "I-adjective", n: "Noun" };
const VALUE_ALIASES = { definition: "glossary", "main-definition": "glossary-first", "jpmn-primary-definition": "glossary-first",
  frequency: "frequencies", "pitch-accent-positions": "pitch-position", "pitch-categories": "pitch-accent-categories" };
const alias = (request, dictionary) => Object.hasOwn(request.dictionaryAliases, dictionary)
  ? request.dictionaryAliases[dictionary] : dictionary;

function expressionFurigana(term, plain) {
  return globalThis.HDGlossary.segmentFurigana(term.expression, term.reading).map(({ text, reading }, index) => {
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

function frequencyHtml(term) {
  return term.frequencies.filter(group => group.frequencies.length).map(group =>
    `<b>${escape(group.dictionary)}</b>: ${group.frequencies.map(value => escape(value.displayValue ?? value.value)).join(", ")}`
  ).join("<br>");
}

function singleFrequency(request, dictionary, numeric) {
  const groups = request.term.frequencies.filter(group => group.dictionary === dictionary && group.frequencies.length);
  if (numeric) {
    const value = groups.length ? frequencyNumber(groups[0].frequencies[0]) : 0;
    return value > 0 ? String(value) : "";
  }
  const items = groups.flatMap(group => group.frequencies.map(value =>
    `<li>${escape(alias(request, dictionary))}: ${escape(value.displayValue ?? value.value)}</li>`));
  return items.length ? `<ul style="text-align: left;">${items.join("")}</ul>` : "";
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
  const classes = new Set(uniqueTokens([term.rules]));
  const inflected = ["v1", "v5", "vk", "vs", "vz", "adj-i"].some(rule => classes.has(rule))
    && !(classes.has("vs") && classes.has("n"));
  const morae = globalThis.HDGlossary.splitPitchAccentMorae(term.reading || term.expression).length;
  const categories = term.pitches.flatMap(group => group.pitches.map(pitch => {
    if (pitch.position === 0) return "heiban";
    if (pitch.position < 0) return null;
    if (inflected) return "kifuku";
    if (pitch.position === 1) return "atamadaka";
    return pitch.position >= morae ? "odaka" : "nakadaka";
  }));
  return [...new Set(categories.filter(Boolean))].join(",");
}

function dynamicGlossaries(request) {
  const dictionaries = [...new Set(request.term.glossaries.map(glossary => glossary.dictionary))];
  const bases = dictionaries.flatMap(dictionary => {
    const key = dictionaryMarker(dictionary);
    return key ? [[dictionary, `single-glossary-${key}`]] : [];
  });
  const variants = new Map();
  for (const [dictionary, key] of bases) if (!variants.has(key)) variants.set(key, { dictionary });
  for (const [dictionary, key] of bases) {
    for (const [suffix, options] of Object.entries({ brief: { brief: true }, "no-dictionary": { noDictionary: true },
      plain: { plain: true }, "plain-no-dictionary": { plain: true, noDictionary: true } })) {
      if (!variants.has(`${key}-${suffix}`)) variants.set(`${key}-${suffix}`, { dictionary, ...options });
    }
  }
  return variants;
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
    tags: () => uniqueTokens(term.glossaries.flatMap(glossary => [glossary.definitionTags, glossary.termTags]))
      .map(tag => `<span class="tag" data-details="${escape(tag)}">${escape(tag)}</span>`).join(", "),
    "phonetic-transcriptions": () => {
      const items = term.pitches.flatMap(group => group.transcriptions).filter(Boolean).map(value =>
        `<li class="pronunciation" data-pronunciation-type="phonetic-transcription">${escape(value)}</li>`);
      return items.length ? `<ul>${items.join("")}</ul>` : "";
    },
    "popup-selection-text": () => escape(request.popupSelectionText), "search-query": () => escape(request.searchQuery),
    "document-title": () => escape(request.documentTitle), sentence,
    // GSM falls back to highlighted text when its optional native tokenizer is
    // unavailable. There is no MeCab/native-helper dependency in the extension.
    "sentence-furigana": sentence, "sentence-furigana-plain": sentence,
    "cloze-prefix": () => parts()[0], "cloze-body": () => parts()[1], "cloze-suffix": () => parts()[2],
    frequencies: () => frequencyHtml(term),
    "frequency-harmonic-rank": () => frequencyAggregate(term, "rank-based", true),
    "frequency-harmonic-occurrence": () => frequencyAggregate(term, "occurrence-based", true),
    "frequency-average-rank": () => frequencyAggregate(term, "rank-based", false),
    "frequency-average-occurrence": () => frequencyAggregate(term, "occurrence-based", false),
    pitch: () => pitchHtml(term), "pitch-position": () => [...new Set(term.pitches.flatMap(group => group.pitches.map(value => value.position)))].join(", "),
    "pitch-accent-categories": () => pitchCategories(term), audio: () => audio,
    "capture-animation": () => request.capturePin?.animationFilename
      && !request.captureUnavailable?.includes("animation")
      ? `<img src="${escape(request.capturePin.animationFilename)}">` : "",
    "capture-audio": () => request.capturePin?.audioFilename
      && !request.captureUnavailable?.includes("audio")
      ? `[sound:${request.capturePin.audioFilename}]` : "",
    // The viewport screenshot this mining request was made from. A capture or
    // upload that failed marks itself unavailable, and the field stays empty
    // rather than referring to a picture Anki does not have.
    screenshot: () => request.screenshot?.filename && !request.captureUnavailable?.includes("screenshot")
      ? `<img src="${escape(request.screenshot.filename)}">` : "",
  };
  const values = new Map();
  let glossaries, frequencies;
  function valueFor(name) {
    if (Object.hasOwn(VALUE_ALIASES, name)) return valueFor(VALUE_ALIASES[name]);
    if (values.has(name)) return values.get(name);
    let value = "";
    if (Object.hasOwn(table, name)) value = table[name]();
    else if (name.startsWith("single-glossary-")) {
      glossaries ??= dynamicGlossaries(request);
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
  const planned = Object.entries(templates).map(([field, template]) => {
    const markers = {};
    for (const name of new Set(ankiTemplateMarkerNames(template.value))) {
      const value = valueFor(name);
      if (value && typeof value.then === "function") pending.push(value.then(resolved => { markers[name] = resolved; }));
      else markers[name] = value;
    }
    return { field, template, markers };
  });
  // Only glossary/resource values need asynchronous settlement. Ordinary text
  // and frequency templates should not create a promise per field and marker.
  if (pending.length) await Promise.all(pending);
  return Object.fromEntries(planned.map(({ field, template, markers }) => [field, renderAnkiTemplate(template.value, markers)]));
}
