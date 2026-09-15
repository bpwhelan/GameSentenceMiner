// SPDX-License-Identifier: GPL-3.0-or-later
import { ankiDigest } from "./anki-digest.js";
import { ankiSetupFamily, ankiSetupTemplates } from "./anki-setup.js";
import { escapeAnkiHtml, resolveAnkiTemplates } from "./anki-templates.js";
import "./reader-options.js";

// Anki parses these field names as operators before considering a field search.
// They cannot identify a direct expression value reliably.
const SEARCH_OPERATORS = new Set(["deck", "note", "tag", "card", "flag", "resched", "prop", "added", "edited",
  "introduced", "rated", "is", "did", "mid", "nid", "cid", "re", "nc", "sc", "w", "dupe", "has-cd", "preset"]);
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const foldAscii = value => value.replace(/[A-Z]/gu, character => character.toLowerCase());
const nameKey = value => value.normalize("NFC").toLowerCase();
const compare = (left, right) => Number(left > right) - Number(left < right);
const escapeQuery = value => value.replace(/[\\"*_:]/gu, String.raw`\$&`);
const searchToken = (operator, value) => `"${escapeQuery(operator)}:${escapeQuery(value)}"`;

function directExpressionFields(config, names = config.fieldTemplates === null
  ? Object.values(config.fields).filter(Boolean) : Object.keys(config.fieldTemplates)) {
  const { templates } = resolveAnkiTemplates(config, names);
  return [...new Set(Object.entries(templates)
    .filter(([field, template]) => /^\{expression\}$/iu.test(template.value)
      && !SEARCH_OPERATORS.has(field.toLowerCase()))
    .map(([field]) => nameKey(field)))].sort(compare);
}

export function ankiWordKey(expression) {
  if (typeof expression !== "string" || !expression) return null;
  // Ordinary Anki field search escapes the rendered HTML, folds ASCII only,
  // and normalizes query text to NFC. Stored field values remain unnormalized.
  return foldAscii(escapeAnkiHtml(expression).normalize("NFC"));
}

function storedWordKey(value) {
  return typeof value === "string" && value ? foldAscii(value) : null;
}

export async function ankiIndexSource(config) {
  if (!config.model) return null;
  const url = globalThis.HDReaderOptions.normaliseAnkiConnectUrl(
    config.url === undefined ? globalThis.HDReaderOptions.DEFAULT_OPTIONS.anki.url : config.url
  );
  if (!url) return null;
  const fields = directExpressionFields(config);
  if (!fields.length) return null;
  const source = {
    url,
    apiKey: config.apiKey,
    scope: config.duplicateScope,
    model: config.model,
    fields,
    ...(config.duplicateScope === "deck" ? { deck: config.deck } : {}),
  };
  return { key: await ankiDigest(new TextEncoder().encode(JSON.stringify(source))), ...source };
}

function modelMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("AnkiConnect returned an invalid note type list.");
  }
  return value;
}

function fieldList(value) {
  if (!Array.isArray(value) || value.some(field => typeof field !== "string" || !field)) {
    throw new Error("AnkiConnect returned an invalid field list.");
  }
  return value;
}

async function recognizedModels(invoke, source) {
  if (source.scope === "model") return [{ name: source.model, fields: source.fields }];
  const available = modelMap(await invoke("modelNamesAndIds", {}));
  const models = [];
  if (positiveId(available[source.model])) {
    models.push({ name: source.model, fields: source.fields });
  }
  const base = globalThis.HDReaderOptions.DEFAULT_OPTIONS.anki;
  for (const [model, id] of Object.entries(available)) {
    if (model === source.model) continue;
    const family = ankiSetupFamily(model);
    if (family === null || !positiveId(id)) continue;
    const fields = fieldList(await invoke("modelFieldNames", { modelName: model }));
    const templates = ankiSetupTemplates(family, model, source.deck ?? "Default", fields, base);
    if (templates === null) continue;
    const expressionFields = directExpressionFields({ ...base, model, fieldTemplates: templates }, fields);
    if (expressionFields.length) models.push({ name: model, fields: expressionFields });
  }
  return models;
}

function modelQuery(models) {
  const clauses = models.map(model => searchToken("note", model.name));
  if (clauses.length === 0) return null;
  return clauses.length === 1 ? clauses[0] : `(${clauses.join(" or ")})`;
}

function scopedQuery(source, query) {
  return source.scope === "deck" ? `${query} ${searchToken("deck", source.deck)}` : query;
}

function completeQuery(source, models) {
  const query = modelQuery(models);
  return query === null ? null : scopedQuery(source, query);
}

function lookupQuery(source, models, expression) {
  const value = escapeAnkiHtml(expression).normalize("NFC");
  const clauses = models.flatMap(model => model.fields.map(field =>
    `(${searchToken("note", model.name)} ${searchToken(field, value)})`));
  if (clauses.length === 0) return null;
  const query = clauses.length === 1 ? clauses[0] : `(${clauses.join(" or ")})`;
  return scopedQuery(source, query);
}

function noteFields(info) {
  if (!info?.fields || typeof info.fields !== "object" || Array.isArray(info.fields)) {
    throw new Error("AnkiConnect returned invalid note details.");
  }
  const entries = Object.entries(info.fields).map(([field, value]) =>
    [field, typeof value === "string" ? value : value?.value]);
  if (entries.some(([, value]) => typeof value !== "string")) {
    throw new Error("AnkiConnect returned invalid note details.");
  }
  return Object.fromEntries(entries);
}

function indexedNotes(value, models, expectedIds = null) {
  if (!Array.isArray(value)) throw new Error("AnkiConnect returned invalid note details.");
  const byModel = new Map(models.map(model => [nameKey(model.name), model]));
  const expected = expectedIds === null ? null : new Set(expectedIds);
  const seen = new Set();
  const notes = value.map(info => {
    if (!positiveId(info?.noteId) || typeof info.modelName !== "string") {
      throw new Error("AnkiConnect returned invalid note details.");
    }
    if ((expected && !expected.has(info.noteId)) || seen.has(info.noteId)) {
      throw new Error("AnkiConnect returned invalid note details.");
    }
    seen.add(info.noteId);
    const model = byModel.get(nameKey(info.modelName));
    if (!model) throw new Error("AnkiConnect returned notes outside the requested note types.");
    const fields = noteFields(info);
    const names = new Map(Object.keys(fields).map(field => [nameKey(field), field]));
    if (model.fields.some(field => !names.has(field))) {
      throw new Error("AnkiConnect returned invalid note details.");
    }
    return { noteId: info.noteId, model, fields, names };
  });
  if (expected && seen.size !== expected.size) throw new Error("AnkiConnect returned invalid note details.");
  return notes;
}

function returnedNoteIds(value, message = "AnkiConnect returned invalid note IDs.") {
  if (!Array.isArray(value) || !value.every(positiveId)) {
    throw new Error(message);
  }
  return [...new Set(value)].sort((left, right) => left - right);
}

function matureNoteIds(value) {
  return new Set(returnedNoteIds(value, "AnkiConnect returned invalid mature note IDs."));
}

function compactRows(notes, mature) {
  const rows = new Map();
  for (const note of notes) {
    for (const field of note.model.fields) {
      const key = storedWordKey(note.fields[note.names.get(field)]);
      if (key === null) continue;
      const row = rows.get(key) ?? { mature: false, noteIds: new Set() };
      row.noteIds.add(note.noteId);
      row.mature ||= mature.has(note.noteId);
      rows.set(key, row);
    }
  }
  return [...rows].sort(([left], [right]) => compare(left, right))
    .map(([word, row]) => [word, row.mature, [...row.noteIds].sort((left, right) => left - right)]);
}

export async function fetchAnkiIndex(invoke, source) {
  const models = await recognizedModels(invoke, source);
  const query = completeQuery(source, models);
  if (query === null) return [];
  const [candidateResult, matureIds] = await Promise.all([
    invoke("findNotes", { query }, 25_000),
    invoke("findNotes", { query: `${query} is:review -is:learn prop:ivl>=21` }, 25_000),
  ]);
  const candidateIds = returnedNoteIds(candidateResult);
  const candidates = new Set(candidateIds);
  const mature = matureNoteIds(matureIds);
  if ([...mature].some(noteId => !candidates.has(noteId))) {
    throw new Error("AnkiConnect returned invalid mature note IDs.");
  }
  if (!candidateIds.length) return [];
  const infos = await invoke("notesInfo", { notes: candidateIds }, 25_000);
  return compactRows(indexedNotes(infos, models, candidateIds), mature);
}

export async function lookupAnkiIndex(invoke, source, expression) {
  const wordKey = ankiWordKey(expression);
  if (wordKey === null) return { wordKey, mature: false, noteIds: [] };
  const models = await recognizedModels(invoke, source);
  const query = lookupQuery(source, models, expression);
  if (query === null) return { wordKey, mature: false, noteIds: [] };
  const candidateIds = returnedNoteIds(await invoke("findNotes", { query }));
  if (!candidateIds.length) return { wordKey, mature: false, noteIds: [] };
  const candidates = indexedNotes(await invoke("notesInfo", { notes: candidateIds }), models, candidateIds);
  const noteIds = [];
  for (const note of candidates) {
    if (note.model.fields.some(field => storedWordKey(note.fields[note.names.get(field)]) === wordKey)) {
      noteIds.push(note.noteId);
    }
  }
  noteIds.sort((left, right) => left - right);
  const unique = [...new Set(noteIds)];
  if (!unique.length) return { wordKey, mature: false, noteIds: [] };
  const mature = matureNoteIds(await invoke("findNotes", {
    query: `nid:${unique.join(",")} is:review -is:learn prop:ivl>=21`,
  }));
  if ([...mature].some(noteId => !unique.includes(noteId))) {
    throw new Error("AnkiConnect returned invalid mature note IDs.");
  }
  return { wordKey, mature: unique.some(noteId => mature.has(noteId)), noteIds: unique };
}

export async function inspectAnkiNoteIds(invoke, source, expression, noteIds) {
  if (!Array.isArray(noteIds) || !noteIds.every(positiveId)) {
    throw new Error("Anki duplicate inspection requires valid note IDs.");
  }
  const ids = [...new Set(noteIds)].sort((left, right) => left - right);
  const infos = await invoke("notesInfo", { notes: ids });
  if (!Array.isArray(infos)) throw new Error("AnkiConnect returned invalid duplicate note details.");
  const requested = new Set(ids);
  const byId = new Map();
  for (const info of infos) {
    if (!positiveId(info?.noteId) || !requested.has(info.noteId) || byId.has(info.noteId)
        || typeof info.modelName !== "string") {
      throw new Error("AnkiConnect returned invalid duplicate note details.");
    }
    byId.set(info.noteId, info);
  }
  const wordKey = ankiWordKey(expression);
  let stale = byId.size !== ids.length;
  let target = null;
  for (const noteId of ids) {
    const info = byId.get(noteId);
    if (!info || nameKey(info.modelName) !== nameKey(source.model)) continue;
    const fields = noteFields(info);
    const names = new Map(Object.keys(fields).map(field => [nameKey(field), field]));
    if (wordKey === null || !source.fields.some(field => storedWordKey(fields[names.get(field)]) === wordKey)) {
      stale = true;
      continue;
    }
    target ??= { noteId, fields };
  }
  return { stale, target };
}
