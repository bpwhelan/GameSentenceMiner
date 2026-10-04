// SPDX-License-Identifier: GPL-3.0-or-later
import { ankiTemplateMarkerNames, isAnkiAudioOnlyTemplate } from "./anki-templates.js";
import { ankiClozeRefusal, explainAnkiConnectError, isAnkiClozeRefusal } from "./anki.js";

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
    if (name === undefined) {
      const existingNames = Object.keys(existing).map(field => `“${field}”`).join(", ");
      throw new Error(`Anki's note has no field “${field}” to overwrite; its fields are ${existingNames || "unknown"}. `
        + "The note type's fields changed. Refresh fields in Anki Settings before overwriting this note.");
    }
    canonicalTemplates.push([name, template]);
    incoming.push([name, fields[field]]);
  }
  return { templates: Object.fromEntries(canonicalTemplates), fields: Object.fromEntries(incoming) };
}

export function overwriteAnkiFields(incoming, existing, templates, { includeAudio = false } = {}) {
  return Object.fromEntries(Object.entries(templates).filter(([, template]) => includeAudio || !isAnkiAudioOnlyTemplate(template.value))
    .map(([field, template]) => [field, overwriteValue(existing[field] ?? "", incoming[field] ?? "", template.overwriteMode)]));
}

function checkResults(result, count, detailed) {
  if (!Array.isArray(result) || result.length !== count
      || !result.every(item => detailed ? typeof item?.canAdd === "boolean" : typeof item === "boolean")) {
    throw new Error("AnkiConnect returned invalid duplicate check results.");
  }
  return result;
}

const checkResult = (result, detailed) => checkResults(result, 1, detailed)[0];

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

// Anki's add check for every note in one request, in order, without its
// duplicate rule: the word index decides duplicates.
export async function validateAnkiNotes(invoke, notes) {
  if (!notes.length) return [];
  const checkNotes = notes.map(note => ({
    deckName: note.deckName,
    modelName: note.modelName,
    fields: note.fields,
    tags: note.tags,
    options: { ...note.options, allowDuplicate: true },
  }));
  try {
    return checkResults(await invoke("canAddNotesWithErrorDetail", { notes: checkNotes }), checkNotes.length, true)
      .map(result => {
        const error = typeof result.error === "string" && result.error ? result.error : null;
        return { addable: result.canAdd && error === null, error };
      });
  } catch (error) {
    if (!/unsupported action/iu.test(error.message)) throw error;
    return checkResults(await invoke("canAddNotes", { notes: checkNotes }), checkNotes.length, false)
      .map(addable => ({ addable, error: addable ? null : "Anki rejected this note." }));
  }
}

export async function validateAnkiNote(invoke, note) {
  return (await validateAnkiNotes(invoke, [note]))[0];
}

const MODEL_CLOZE = 1; // pylib/anki/consts.py
// cloze.rs tokenize: a deletion opens with {{c, its cloze numbers and ::, and
// closes with }}. Each alternative is linear, so any field text scans quickly.
const CLOZE_MARKERS = /\{\{c(,*\d[\d,]*)::|\}\}/gu;

// cloze.rs contains_cloze: the first complete top-level deletion with a cloze
// number other than 0, such as {{c1::猫}}, or null.
function clozeDeletion(text) {
  const open = [];
  for (const marker of text.matchAll(CLOZE_MARKERS)) {
    if (marker[1] !== undefined) open.push(marker);
    else if (open.length === 1 && /[1-9]/u.test(open[0][1])) return text.slice(open[0].index, marker.index + 2);
    else open.pop(); // Closes a nested or number-0 deletion; a stray }} is plain text.
  }
  return null;
}

// notetype/mod.rs cloze_fields: the fields the first card's front renders with
// the cloze filter, as in {{cloze:Text}} or {{furigana:cloze:Text}}, in the
// note type's order (template.rs all_referenced_cloze_field_names). Anki finds
// each referenced field case-insensitively (get_field_ord) and, since 25.02,
// skips references inside an HTML comment.
function clozeFields(model) {
  const referenced = new Set();
  const template = model.tmpls[0].qfmt.replaceAll(/<!--[\s\S]*?-->/gu, "");
  for (const [, tag] of template.matchAll(/\{\{([^{}]*)\}\}/gu)) {
    const [field, ...filters] = tag.trim().split(":").reverse();
    if (filters.includes("cloze")) referenced.add(field.toLowerCase());
  }
  return model.flds.map(field => field.name).filter(name => referenced.has(name.toLowerCase()));
}

// notes/mod.rs field_cloze_check, in Anki's order: the first deletion in a
// field that cannot make cloze cards, then a Cloze note type without any.
// AnkiConnect assigns submitted fields to the note type's case-insensitively.
function clozeRule(model, note, refused, templates) {
  const values = new Map(Object.entries(note.fields).map(([name, value]) => [name.toLowerCase(), value]));
  const deletions = model.flds.map(({ name }) => [name, clozeDeletion(values.get(name.toLowerCase()) ?? "")])
    .filter(([, deletion]) => deletion !== null);
  const modelName = `“${note.modelName}”`;
  if (model.type !== MODEL_CLOZE) {
    if (!deletions.length) return null;
    const [[field, deletion]] = deletions;
    const refusal = `${refused}: field “${field}” contains the cloze deletion “${deletion}”, but ${modelName} is not a Cloze note type.`;
    // A template without literal deletion text has nothing to remove: the
    // deletion arrived inside a marker's content, such as a dictionary's.
    const template = Object.entries(templates).find(([name]) => name.toLowerCase() === field.toLowerCase())?.[1].value;
    if (template !== undefined && clozeDeletion(template) === null) {
      const markers = [...new Set(ankiTemplateMarkerNames(template))].map(name => `{${name}}`).join(", ");
      return `${refusal} The deletion comes from the content of ${markers || "its markers"}, not from the field's template. `
        + "Map that field to other content in Anki Settings, or choose a Cloze note type.";
    }
    return `${refusal} Remove the deletion from that field's template in Anki Settings, or choose a Cloze note type.`;
  }
  const clozable = clozeFields(model);
  if (!clozable.length) return null;
  const outside = deletions.find(([field]) => !clozable.includes(field));
  if (outside) {
    const names = clozable.map(name => `“${name}”`).join(", ");
    return `${refused}: field “${outside[0]}” contains the cloze deletion “${outside[1]}”, but ${modelName} makes cloze cards `
      + `only from ${names}. Move the deletion to the template of “${clozable[0]}” in Anki Settings.`;
  }
  if (deletions.length) return null;
  return `${refused}: it is a Cloze note type, but its cloze field “${clozable[0]}” has no cloze deletion such as {{c1::…}}. `
    + `Map “${clozable[0]}” to a template that makes one, for example {cloze-prefix}{{c1::{cloze-body}}}{cloze-suffix}, `
    + "or choose a non-Cloze note type in Anki Settings.";
}

// The reader-facing text of a per-note refusal from the checks above. It is a
// check result, not a request error, so the gateway has not translated it.
// AnkiConnect's "unknown reason" is one of Anki's three cloze refusals: one
// read of the note type names which. Text no translation knows, such as the
// legacy fallback's own, is kept.
export async function explainAnkiRefusal(invoke, note, error, templates) {
  if (!isAnkiClozeRefusal(error)) return explainAnkiConnectError(error) ?? error;
  const refused = `Anki refused the note for deck “${note.deckName}”, note type “${note.modelName}”`;
  try {
    const [model] = await invoke("findModelsByName", { modelNames: [note.modelName] });
    return clozeRule(model, note, refused, templates) ?? ankiClozeRefusal(refused);
  } catch {
    // An AnkiConnect without findModelsByName, or a note type it could not
    // return, still gets the rules Anki applies.
    return ankiClozeRefusal(refused);
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

// Anki's exact first-field duplicates of the configured note type inside the
// configured scope, for a destination the word index cannot key. One `dupe:`
// search answers it from Anki's checksum index.
export async function findAnkiDuplicateNotes(invoke, note, firstField, config) {
  const models = await invoke("modelNamesAndIds");
  const modelId = models?.[config.model];
  if (Array.isArray(models) || !positiveId(modelId)) throw new Error("AnkiConnect returned no valid ID for the selected note type.");
  const found = await invoke("findNotes", { query: duplicateQuery(note, firstField, modelId) });
  if (!Array.isArray(found) || !found.every(positiveId)) throw new Error("AnkiConnect returned invalid duplicate note IDs.");
  const ids = [...new Set(found)];
  if (!ids.length) return [];
  const infos = await invoke("notesInfo", { notes: ids });
  if (!Array.isArray(infos)) throw new Error("AnkiConnect returned invalid duplicate note details.");
  const scoped = await scopedNoteIds(invoke, infos, config);
  const byId = new Map(infos.filter(info => positiveId(info?.noteId)).map(info => [info.noteId, info]));
  const matches = [];
  for (const id of ids) {
    if (scoped && !scoped.has(id)) continue;
    const info = byId.get(id);
    if (typeof info?.modelName !== "string" || info.modelName.toLowerCase() !== config.model.toLowerCase()) continue;
    if (!info.fields || typeof info.fields !== "object" || Array.isArray(info.fields)) continue;
    const entries = Object.entries(info.fields).map(([field, value]) =>
      [field, typeof value === "string" ? value : value?.value]);
    if (entries.some(([, value]) => typeof value !== "string")) {
      throw new Error("AnkiConnect returned invalid duplicate note fields.");
    }
    matches.push({ noteId: id, modelName: info.modelName, fields: Object.fromEntries(entries) });
  }
  return matches;
}
