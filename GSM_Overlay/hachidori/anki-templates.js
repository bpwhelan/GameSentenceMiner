// SPDX-License-Identifier: GPL-3.0-or-later
import "./reader-options.js";

const { ANKI_FIELDS } = globalThis.HDReaderOptions;
const CORE_MARKERS = ["expression", "reading", "furigana", "furigana-plain", "dictionary", "dictionary-alias",
  "definition", "glossary", "glossary-brief", "glossary-no-dictionary", "glossary-plain", "glossary-plain-no-dictionary",
  "glossary-first", "glossary-first-brief", "glossary-first-no-dictionary", "main-definition", "jpmn-primary-definition",
  "conjugation", "part-of-speech", "phonetic-transcriptions", "tags", "popup-selection-text", "search-query", "document-title",
  "sentence", "sentence-furigana", "sentence-furigana-plain", "cloze-prefix", "cloze-body", "cloze-suffix",
  "frequency", "frequencies", "frequency-harmonic-rank", "frequency-harmonic-occurrence", "frequency-average-rank",
  "frequency-average-occurrence", "pitch", "pitch-position", "pitch-accent-positions", "pitch-categories",
  "pitch-accent-categories", "pitch-accent-graphs", "pitch-accent-graphs-jj",
  "audio", "capture-animation", "capture-audio", "screenshot"];
const MARKER_ALIASES = new Map([["pitch-accent", "pitch"], ["pitch-accents", "pitch"]]);
const MARKER_DESCRIPTIONS = {
  expression: "Dictionary form of the selected term",
  reading: "Reading of the selected term",
  furigana: "Expression with ruby furigana",
  "furigana-plain": "Expression with bracketed plain-text furigana",
  dictionary: "Title of the first definition dictionary",
  "dictionary-alias": "Display name of the first definition dictionary",
  definition: "All definitions with dictionary names",
  glossary: "All definitions with dictionary names",
  "glossary-brief": "Brief definitions from every dictionary",
  "glossary-no-dictionary": "All definitions without dictionary names",
  "glossary-plain": "Plain-text definitions with dictionary names",
  "glossary-plain-no-dictionary": "Plain-text definitions without dictionary names",
  "glossary-first": "First available definition",
  "glossary-first-brief": "Brief form of the first definition",
  "glossary-first-no-dictionary": "First definition without its dictionary name",
  "main-definition": "First available definition",
  "jpmn-primary-definition": "First available definition",
  conjugation: "Deinflection and conjugation path",
  "part-of-speech": "Readable part-of-speech names",
  "phonetic-transcriptions": "Available phonetic transcriptions",
  tags: "Definition and term tags",
  "popup-selection-text": "Text selected inside the lookup popup",
  "search-query": "Text used for the lookup",
  "document-title": "Title of the source page",
  sentence: "Source sentence with the matched text emphasized",
  "sentence-furigana": "Source sentence with furigana when available",
  "sentence-furigana-plain": "Plain-text source sentence with furigana when available",
  "cloze-prefix": "Sentence text before the match",
  "cloze-body": "Matched sentence text",
  "cloze-suffix": "Sentence text after the match",
  frequency: "All available frequency values",
  frequencies: "All available frequency values",
  "frequency-harmonic-rank": "Harmonic mean of rank-based frequencies",
  "frequency-harmonic-occurrence": "Harmonic mean of occurrence-based frequencies",
  "frequency-average-rank": "Arithmetic mean of rank-based frequencies",
  "frequency-average-occurrence": "Arithmetic mean of occurrence-based frequencies",
  pitch: "Pitch accent patterns and transcriptions",
  "pitch-position": "Pitch accent drop positions",
  "pitch-accent-positions": "Pitch accent drop positions",
  "pitch-categories": "Pitch accent categories",
  "pitch-accent-categories": "Pitch accent categories",
  "pitch-accent-graphs": "Japanese pitch accent SVG graphs",
  "pitch-accent-graphs-jj": "Japanese pitch accent SVG graphs with kana labels (Jidoujisho style)",
  audio: "Selected pronunciation audio",
  "capture-animation": "Captured animated image",
  "capture-audio": "Captured sentence audio",
  screenshot: "Screenshot of the source page",
};
const DYNAMIC_MARKER_OPTIONS = [
  ["single-glossary-DICTIONARY", "Definitions from one dictionary; replace DICTIONARY with its marker name"],
  ["single-glossary-DICTIONARY-brief", "Brief definitions from one dictionary"],
  ["single-glossary-DICTIONARY-no-dictionary", "Definitions from one dictionary without its name"],
  ["single-glossary-DICTIONARY-plain", "Plain-text definitions from one dictionary"],
  ["single-glossary-DICTIONARY-plain-no-dictionary", "Plain-text definitions from one dictionary without its name"],
  ["single-glossary-id--PACKAGE-ID", "Definitions selected by the dictionary package ID"],
  ["single-frequency-DICTIONARY", "Formatted values from one frequency dictionary"],
  ["single-frequency-number-DICTIONARY", "Numeric value from one frequency dictionary"],
];
export const ANKI_TEMPLATE_MARKERS = Object.freeze([...CORE_MARKERS, ...MARKER_ALIASES.keys()]);
export const ANKI_TEMPLATE_MARKER_OPTIONS = Object.freeze([
  ...CORE_MARKERS.map(marker => Object.freeze({
    marker,
    value: `{${marker}}`,
    description: MARKER_DESCRIPTIONS[marker],
  })),
  ...[...MARKER_ALIASES].map(([marker, canonical]) => Object.freeze({
    marker,
    value: `{${marker}}`,
    description: `Legacy spelling of {${canonical}}`,
  })),
  ...DYNAMIC_MARKER_OPTIONS.map(([marker, description]) => Object.freeze({
    marker,
    value: `{${marker}}`,
    description,
  })),
]);
const MARKERS = new Set([...CORE_MARKERS, ...MARKER_ALIASES.keys()]);
const DYNAMIC_PREFIXES = ["single-glossary-", "single-frequency-"];
const MARKER_PATTERN = /\{([^{}]+)\}/gu;
const BREAK_PATTERN = /<br\s*\/?>/giu;
const genericAliases = {
  expression: ["Expression", "Word", "Term", "Front"], reading: ["Reading", "Word Reading", "WordReading", "Kana"],
  definition: ["Definition", "Definitions", "Meaning", "Glossary"], sentence: ["Sentence", "Context", "Example Sentence"],
  frequency: ["Frequency", "Frequencies"], pitch: ["Pitch Accent", "PitchAccent", "Pitch", "Accent"],
  audio: ["WordAudio", "PronunciationAudio", "Pronunciation", "Audio"],
  captureAnimation: ["Capture Animation", "CaptureAnimation", "Sentence Animation", "SentenceAnimation"],
  captureAudio: ["Capture Audio", "CaptureAudio", "Sentence Audio", "SentenceAudio"],
};
// Reviewed against the complete Kiku 2.1.0, Lapis 1.7.0 and Senren 5.1.0
// package schemas. Every known unsupported field is explicit so the upstream
// compatibility contract can distinguish an intentional blank from drift.
const KIKU = {
  Expression: "{expression}", ExpressionFurigana: "{furigana-plain}", ExpressionReading: "{reading}", ExpressionAudio: "{audio}",
  RelatedExpression: "", SelectionText: "{popup-selection-text}", MainDefinition: "{main-definition}", DefinitionPicture: "",
  Sentence: "{cloze-prefix}<b>{cloze-body}</b>{cloze-suffix}", SentenceFurigana: "{sentence-furigana-plain}",
  SentenceTranslation: "", SentenceAudio: "", Picture: "{screenshot}", Glossary: "{glossary}", Hint: "",
  IsWordAndSentenceCard: "", IsClickCard: "", IsSentenceCard: "", IsAudioCard: "",
  PitchPosition: "{pitch-accent-positions}", PitchCategories: "{pitch-accent-categories}", Frequency: "{frequencies}",
  FreqSort: "{frequency-harmonic-rank}", MiscInfo: "{document-title}",
};
const LAPIS = {
  Expression: "{expression}", ExpressionFurigana: "{furigana-plain}", ExpressionReading: "{reading}", ExpressionAudio: "{audio}",
  SelectionText: "{popup-selection-text}", MainDefinition: "{main-definition}", DefinitionPicture: "",
  Sentence: "{cloze-prefix}<b>{cloze-body}</b>{cloze-suffix}", SentenceFurigana: "", SentenceAudio: "",
  Picture: "{screenshot}", Glossary: "{glossary}", Hint: "",
  IsWordAndSentenceCard: "", IsClickCard: "", IsSentenceCard: "", IsAudioCard: "",
  PitchPosition: "{pitch-accent-positions}", PitchCategories: "{pitch-accent-categories}", Frequency: "{frequencies}",
  FreqSort: "{frequency-harmonic-rank}", MiscInfo: "{document-title}",
};
const KIKU_LAPIS_SLOTS = { ExpressionFurigana: "expression-furigana", ExpressionReading: "reading", ExpressionAudio: "audio",
  SelectionText: "selection-text", MainDefinition: "main-definition", SentenceFurigana: "sentence-furigana",
  PitchPosition: "pitch", PitchCategories: "pitch-categories", FreqSort: "frequency-sort", MiscInfo: "document-title" };
const SENREN = {
  word: "{expression}", reading: "{reading}",
  sentence: '<span class="group">{cloze-prefix}<span class="highlight">{cloze-body}</span>{cloze-suffix}</span>',
  sentenceFurigana: '<span class="group">{sentence-furigana}</span>',
  sentenceTranslation: "", sentenceCard: "", audioCard: "", notes: "", hint: "",
  picture: "{screenshot}", wordAudio: "{audio}", sentenceAudio: "",
  selectionText: "{popup-selection-text}", definition: "{main-definition}", glossary: "{glossary}",
  pitchAccents: "{pitch}", pitchPositions: "{pitch-accent-positions}", pitchCategories: "{pitch-accent-categories}",
  frequencies: "{frequencies}", freqSort: "{frequency-harmonic-rank}", miscInfo: "{document-title}",
  dictionaryPreference: "",
};
const PRESETS = { kiku: KIKU, lapis: LAPIS, senren: SENREN };
const fieldKey = value => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const knownMarker = value => MARKERS.has(value) || DYNAMIC_PREFIXES.some(prefix => value.startsWith(prefix) && value.length > prefix.length);
const blankTemplate = () => ({ value: "", overwriteMode: "coalesce" });
const semanticMarker = semantic => ({ captureAnimation: "capture-animation", captureAudio: "capture-audio" })[semantic] ?? semantic;
const semanticLabel = semantic => ({ captureAnimation: "captured animation", captureAudio: "captured audio" })[semantic] ?? semantic;
// Names the fields Anki reported, so a stale mapping can be corrected without
// opening Anki. An empty list means the note type itself is still unknown.
const availableFields = fields => fields.length === 0 ? ""
  : ` Its fields are ${fields.map(field => `“${field}”`).join(", ")}.`;

export const escapeAnkiHtml = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#x27;");

export function ankiFieldNames(fields) {
  return new Map(fields.map(field => [field.toLowerCase(), field]));
}

export function ankiTemplateMarkerNames(template) {
  return [...template.matchAll(MARKER_PATTERN)].map(match => {
    const name = match[1].toLowerCase();
    return MARKER_ALIASES.get(name) ?? name;
  });
}

export function ankiCaptureRequirements(templates) {
  const markers = new Set(Object.values(templates).flatMap(template => ankiTemplateMarkerNames(template.value)));
  return {
    includeAnimation: markers.has("capture-animation"),
    includeAudio: markers.has("capture-audio"),
    includeScreenshot: markers.has("screenshot"),
  };
}

export function ankiTemplateErrors(template) {
  return [...new Set([...template.matchAll(MARKER_PATTERN)].filter(match => !knownMarker(match[1].toLowerCase()))
    .map(match => `Unknown marker: ${match[0]}`))];
}

export function isAnkiAudioOnlyTemplate(template) {
  let hasAudio = false;
  const rest = template.replace(MARKER_PATTERN, (match, name) => {
    if (name.toLowerCase() !== "audio") return match;
    hasAudio = true;
    return "";
  }).replace(BREAK_PATTERN, "");
  return hasAudio && !rest.trim();
}

export function renderAnkiTemplate(template, values) {
  const errors = ankiTemplateErrors(template);
  if (errors.length) throw new Error(errors.join("\n"));
  return template.split(BREAK_PATTERN).flatMap(segment => {
    const markers = [...segment.matchAll(MARKER_PATTERN)];
    const rendered = segment.replace(MARKER_PATTERN, (_, name) => {
      const key = name.toLowerCase();
      return values[key] ?? values[MARKER_ALIASES.get(key)] ?? "";
    });
    return markers.length && !rendered.trim() ? [] : [rendered];
  }).join("<br>");
}

function basicTemplates(config, fields) {
  const canonical = ankiFieldNames(fields);
  const rows = new Map(fields.map(field => [field, blankTemplate()]));
  const errors = [];
  for (const semantic of ANKI_FIELDS) {
    const name = config.fields[semantic];
    if (!name) continue;
    const field = canonical.get(name.toLowerCase());
    if (!field) {
      errors.push(`The ${semanticLabel(semantic)} mapping points at field “${name}”, which is unavailable in note type “${config.model}”.${availableFields(fields)}`);
      continue;
    }
    const row = rows.get(field);
    const marker = semantic === "pitch" && field.toLowerCase() === "pitchposition" ? "pitch-position"
      : semanticMarker(semantic);
    row.value += `${row.value ? "<br>" : ""}{${marker}}`;
  }
  return { templates: Object.fromEntries(rows), staleFields: [], errors };
}

// The core a mined card needs: the expression, its reading, the sentence and a
// definition body. A note type that only shares a family name maps fewer than
// these, so first-run detection can tell a real setup from a namesake.
export function ankiPresetCoreMapped(fieldTemplates, family) {
  const table = PRESETS[family];
  if (table === undefined) return false;
  const values = new Set(Object.values(fieldTemplates).map(template => template.value));
  const expression = table === SENREN ? table.word : table.Expression;
  const reading = table === SENREN ? table.reading : table.ExpressionReading;
  const definition = table === SENREN ? table.definition : table.MainDefinition;
  const glossary = table === SENREN ? table.glossary : table.Glossary;
  return values.has(expression) && values.has(reading)
    && (values.has(definition) || values.has(glossary))
    && values.has(table.sentence ?? table.Sentence);
}

export function resolveAnkiTemplates(config, fields) {
  if (config.fieldTemplates === null) return basicTemplates(config, fields);
  const saved = config.fieldTemplates;
  const folded = new Map();
  for (const name of Object.keys(saved)) {
    if (!folded.has(name.toLowerCase())) folded.set(name.toLowerCase(), name);
  }
  const used = new Set();
  const templates = Object.fromEntries(fields.map(field => {
    const name = Object.hasOwn(saved, field) ? field : folded.get(field.toLowerCase());
    if (name === undefined) return [field, blankTemplate()];
    used.add(name);
    return [field, { ...saved[name] }];
  }));
  const staleFields = Object.keys(saved).filter(field => !used.has(field));
  const errors = staleFields.map(field =>
    `Template field “${field}” is unavailable in note type “${config.model}”.${availableFields(fields)}`);
  for (const [field, template] of Object.entries(templates)) {
    errors.push(...ankiTemplateErrors(template.value).map(error => `Field “${field}”: ${error}`));
  }
  return { templates, staleFields, errors };
}

export function applyAnkiPreset(config, fields, preset) {
  const table = PRESETS[preset] ?? KIKU;
  const suggestions = new Map();
  if (preset === "automatic") {
    for (const [semantic, aliases] of Object.entries(genericAliases)) {
      for (const alias of aliases) suggestions.set(fieldKey(alias), { slot: semantic, value: `{${semanticMarker(semantic)}}` });
    }
  }
  for (const [field, value] of Object.entries(table)) {
    if (preset === "automatic" && value === "") continue;
    suggestions.set(fieldKey(field), {
      slot: table === SENREN ? fieldKey(field) : KIKU_LAPIS_SLOTS[field] ?? field.toLowerCase(), value,
    });
  }
  const used = new Set();
  const fieldTemplates = Object.fromEntries(fields.map(field => {
    const suggestion = suggestions.get(fieldKey(field));
    const template = blankTemplate();
    if (suggestion && !used.has(suggestion.slot)) {
      used.add(suggestion.slot);
      template.value = suggestion.value;
    }
    return [field, template];
  }));
  return { ...config, fieldTemplates };
}
