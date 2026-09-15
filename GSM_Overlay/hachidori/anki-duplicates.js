// SPDX-License-Identifier: GPL-3.0-or-later
import { isAnkiAudioOnlyTemplate } from "./anki-templates.js";

// GSM PR #549 hoshidicts_anki.py and hoshidicts_markers.py. These policies
// receive the gateway's private invoker, never a page-selected API action.
const escapeQuery = value => value.replace(/[\\"*_:]/gu, String.raw`\$&`);
const positiveId = value => Number.isSafeInteger(value) && value > 0;
export const isAnkiDuplicateError = error => /cannot create note because it is a duplicate/iu.test(error || "");

export function ankiBrowseQuery(expression) {
  return `"${escapeQuery(expression.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"))}"`;
}

export function ankiNoteIdsQuery(noteIds) {
  if (!Array.isArray(noteIds) || noteIds.length === 0 || !noteIds.every(positiveId)) {
    throw new Error("Anki browse requires valid note IDs.");
  }
  return `nid:${[...new Set(noteIds)].join(",")}`;
}

export function ankiNoteOptions(config) {
  const deck = config.duplicateScope === "deck";
  return {
    // The index applies the selected recognized-note-type scope. Native Anki
    // remains a final race guard for the configured destination note type only:
    // its all-model switch would also reject unrelated custom note types.
    allowDuplicate: config.duplicateBehavior === "new",
    duplicateScope: deck ? "deck" : "collection",
    duplicateScopeOptions: {
      deckName: deck ? config.deck : null,
      checkChildren: deck,
      checkAllModels: false,
    },
  };
}

function overwriteValue(existing, incoming, mode) {
  if (mode === "overwrite") return incoming;
  if (mode === "skip") return existing;
  if (mode === "append") return existing + incoming;
  if (mode === "prepend") return incoming + existing;
  if (mode === "coalesce-new") return incoming || existing;
  return existing || incoming;
}

export function canonicalAnkiFields(fields, templates, existing) {
  const names = new Map(Object.keys(existing).map(name => [name.toLowerCase(), name]));
  const canonicalTemplates = [], incoming = [];
  for (const [field, template] of Object.entries(templates)) {
    const name = Object.hasOwn(existing, field) ? field : names.get(field.toLowerCase());
    if (name === undefined) throw new Error("Anki model fields changed. Refresh before overwriting this note.");
    canonicalTemplates.push([name, template]);
    incoming.push([name, fields[field]]);
  }
  return { templates: Object.fromEntries(canonicalTemplates), fields: Object.fromEntries(incoming) };
}

export function overwriteAnkiFields(incoming, existing, templates, { includeAudio = false } = {}) {
  return Object.fromEntries(Object.entries(templates).filter(([, template]) => includeAudio || !isAnkiAudioOnlyTemplate(template.value))
    .map(([field, template]) => [field, overwriteValue(existing[field] ?? "", incoming[field] ?? "", template.overwriteMode)]));
}

function checkResult(result, detailed) {
  if (!Array.isArray(result) || result.length !== 1
      || (detailed ? typeof result[0]?.canAdd !== "boolean" : typeof result[0] !== "boolean")) {
    throw new Error("AnkiConnect returned invalid duplicate check results.");
  }
  return result[0];
}

export async function checkAnkiDuplicate(invoke, note, config) {
  // Anki also validates clozes in non-first fields. Keep all rendered fields,
  // but omit media-upload objects: preflight must not write collection media.
  const checkNote = allowDuplicate => ({ deckName: note.deckName, modelName: note.modelName, fields: note.fields, tags: note.tags,
    options: { ...note.options, allowDuplicate } });
  let result;
  try {
    result = checkResult(await invoke("canAddNotesWithErrorDetail", { notes: [checkNote(false)] }), true);
  } catch (error) {
    if (!/unsupported action/iu.test(error.message)) throw error;
    const allowed = checkResult(await invoke("canAddNotes", { notes: [checkNote(true)] }), false);
    const prevented = checkResult(await invoke("canAddNotes", { notes: [checkNote(false)] }), false);
    return { duplicate: allowed && !prevented, addable: allowed && prevented, error: null };
  }
  const error = typeof result.error === "string" && result.error ? result.error : null;
  return { duplicate: isAnkiDuplicateError(error), addable: result.canAdd && !error, error };
}

export async function validateAnkiNote(invoke, note) {
  const checkNote = {
    deckName: note.deckName,
    modelName: note.modelName,
    fields: note.fields,
    tags: note.tags,
    options: { ...note.options, allowDuplicate: true },
  };
  try {
    const result = checkResult(await invoke("canAddNotesWithErrorDetail", { notes: [checkNote] }), true);
    const error = typeof result.error === "string" && result.error ? result.error : null;
    return { addable: result.canAdd && error === null, error };
  } catch (error) {
    if (!/unsupported action/iu.test(error.message)) throw error;
    const addable = checkResult(await invoke("canAddNotes", { notes: [checkNote] }), false);
    return { addable, error: addable ? null : "Anki rejected this note." };
  }
}

function duplicateQuery(note, firstField, modelId) {
  // Native Anki dupe search uses the same case-sensitive, HTML-stripped
  // comparison as duplicate validation. Ordinary field search does not.
  // Unlike ordinary search, dupe text treats wildcard/colon/comma literally.
  const text = (note.fields[firstField] ?? "").replace(/[\\"]/gu, String.raw`\$&`);
  return `"dupe:${modelId},${text}"`;
}

async function scopedNoteIds(invoke, infos, config) {
  if (config.duplicateScope !== "deck") return null;
  const ids = infos.flatMap(info => Array.isArray(info?.cards) ? info.cards.filter(positiveId) : []);
  if (!ids.length) return new Set();
  const cards = await invoke("cardsInfo", { cards: ids });
  if (!Array.isArray(cards)) throw new Error("AnkiConnect returned invalid duplicate card details.");
  const exact = config.deck.toLowerCase();
  return new Set(cards.filter(card => {
    if (typeof card?.deckName !== "string" || !positiveId(card.note)) return false;
    const deck = card.deckName.toLowerCase();
    return deck === exact || deck.startsWith(`${exact}::`);
  }).map(card => card.note));
}

export async function findAnkiDuplicateNotes(invoke, note, firstField, config, {
  allModels = false,
} = {}) {
  const models = await invoke("modelNamesAndIds");
  const modelId = models?.[config.model];
  if (Array.isArray(models) || !positiveId(modelId)) throw new Error("AnkiConnect returned no valid ID for the selected note type.");
  const modelEntries = [[config.model, modelId]];
  if (allModels) {
    for (const [modelName, id] of Object.entries(models)) {
      if (modelName === config.model) continue;
      if (!positiveId(id)) throw new Error("AnkiConnect returned invalid note type IDs.");
      modelEntries.push([modelName, id]);
    }
  }
  const ids = [];
  const modelByNote = new Map();
  for (const [modelName, id] of modelEntries) {
    const found = await invoke("findNotes", { query: duplicateQuery(note, firstField, id) });
    if (!Array.isArray(found) || !found.every(positiveId)) throw new Error("AnkiConnect returned invalid duplicate note IDs.");
    for (const noteId of found) {
      if (modelByNote.has(noteId)) continue;
      ids.push(noteId);
      modelByNote.set(noteId, modelName);
    }
  }
  if (!ids.length) return [];
  const infos = await invoke("notesInfo", { notes: ids });
  if (!Array.isArray(infos)) throw new Error("AnkiConnect returned invalid duplicate note details.");
  const scoped = await scopedNoteIds(invoke, infos, config);
  const byId = new Map(infos.filter(info => positiveId(info?.noteId)).map(info => [info.noteId, info]));
  const matches = [];
  for (const id of ids) {
    if (scoped && !scoped.has(id)) continue;
    const info = byId.get(id);
    const expectedModel = modelByNote.get(id);
    if (typeof info?.modelName !== "string" || info.modelName.toLowerCase() !== expectedModel.toLowerCase()) continue;
    let fields = null;
    if (info.modelName.toLowerCase() === config.model.toLowerCase()) {
      if (!info.fields || typeof info.fields !== "object" || Array.isArray(info.fields)) continue;
      const entries = Object.entries(info.fields).map(([field, value]) =>
        [field, typeof value === "string" ? value : value?.value]);
      if (entries.some(([, value]) => typeof value !== "string")) {
        throw new Error("AnkiConnect returned invalid duplicate note fields.");
      }
      fields = Object.fromEntries(entries);
    }
    matches.push({ noteId: id, modelName: info.modelName, fields });
  }
  return matches;
}

export async function findAnkiOverwriteTarget(invoke, note, firstField, config) {
  const [target] = await findAnkiDuplicateNotes(invoke, note, firstField, config, { allModels: false });
  return target ? { noteId: target.noteId, fields: target.fields } : null;
}
