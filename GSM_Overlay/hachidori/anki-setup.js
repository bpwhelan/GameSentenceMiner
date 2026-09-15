// SPDX-License-Identifier: GPL-3.0-or-later
import { ankiAvailability } from "./anki.js";
import { ankiPresetCoreMapped, applyAnkiPreset, resolveAnkiTemplates } from "./anki-templates.js";

/*
 * Read-only Anki detection shared by startup and Settings: recognise an installed Senren, Lapis or
 * Kiku note type, rank note types by distinct existing notes and decks by
 * distinct notes represented in them, and propose the preset mapping for the
 * winner. Nothing here writes to Anki; every call is one of the fixed
 * read-only actions below, issued through the worker's AnkiConnect gateway.
 */

export const ANKI_SETUP_FAMILIES = Object.freeze(["senren", "lapis", "kiku"]);
const FAMILY_LABELS = { senren: "Senren", lapis: "Lapis", kiku: "Kiku" };
// The family name must lead the model name and end at a word boundary, so
// ordinary versioned names match ("Kiku v2", "Lapis 1.4") while an unrelated
// or ambiguous name that merely contains the word does not ("Kikuchi", "My Kiku").
const FAMILY_PATTERN = /^(senren|lapis|kiku)(?![\p{L}\p{N}])/iu;

export function ankiSetupFamily(modelName) {
  const match = FAMILY_PATTERN.exec(String(modelName).trim());
  return match === null ? null : match[1].toLowerCase();
}

function positiveId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function idList(value, what) {
  if (!Array.isArray(value) || !value.every(positiveId)) throw new Error(`AnkiConnect returned invalid ${what}.`);
  return value;
}

// The preset is the mapping the user would get from Settings; a model that
// carries a family name but not its field shape is not eligible. The preset
// must have mapped the family's core fields — a namesake with one recognised
// field would otherwise pass on its first field alone.
export function ankiSetupTemplates(family, model, deck, fields, baseConfig) {
  const config = applyAnkiPreset({ ...baseConfig, model, deck }, fields, family);
  if (!ankiPresetCoreMapped(config.fieldTemplates, family)) return null;
  const resolved = resolveAnkiTemplates(config, fields);
  const errors = ankiAvailability(config, { connected: true, model, decks: [deck], models: [model], fields, errors: [] }, resolved);
  return errors.length === 0 ? config.fieldTemplates : null;
}

function uniqueMaximum(entries) {
  let best = null;
  let tied = false;
  for (const entry of entries) {
    if (entry.count <= 0) continue;
    if (best === null || entry.count > best.count) {
      best = entry;
      tied = false;
    } else if (entry.count === best.count) {
      tied = true;
    }
  }
  return { best, tied };
}

function attention(detail) {
  return { status: "needs-attention", detail, model: null, deck: null, fieldTemplates: null };
}

function modelMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("AnkiConnect returned an invalid note type list.");
  return value;
}

function fieldList(value) {
  if (!Array.isArray(value) || value.some((field) => typeof field !== "string" || field === "")) {
    throw new Error("AnkiConnect returned an invalid field list.");
  }
  return value;
}

// Every note type whose name leads with a supported family and whose fields the
// preset can map, with the distinct notes each one already holds.
async function eligibleCandidates(invoke, baseConfig, models) {
  const eligible = [];
  for (const [model, id] of Object.entries(models)) {
    const family = ankiSetupFamily(model);
    if (family === null || !positiveId(id)) continue;
    const fields = fieldList(await invoke("modelFieldNames", { modelName: model }));
    // Deck is settled later; the shape check only needs the fields.
    if (ankiSetupTemplates(family, model, "Default", fields, baseConfig) === null) continue;
    const notes = idList(await invoke("findNotes", { query: `mid:${id}` }), "note IDs");
    eligible.push({ model, id, family, fields, count: new Set(notes).size });
  }
  return eligible;
}

/**
 * The mapping the user already saved, checked the way Settings checks it: the
 * note types, the decks and that model's fields are read and the shared
 * availability rules decide. Nothing is written and nothing is proposed.
 * @param {(action: string, params: object) => Promise<unknown>} invoke fixed read-only AnkiConnect call
 * @param {object} config the saved Anki options
 */
export async function verifyAnkiSetup(invoke, config) {
  const models = modelMap(await invoke("modelNamesAndIds", {}));
  const decks = await invoke("deckNames", {});
  if (!Array.isArray(decks) || decks.some((deck) => typeof deck !== "string")) {
    throw new Error("AnkiConnect returned an invalid deck list.");
  }
  const fields = Object.hasOwn(models, config.model) ? fieldList(await invoke("modelFieldNames", { modelName: config.model })) : [];
  const errors = ankiAvailability(config, { connected: true, model: config.model, models: Object.keys(models), decks, fields, errors: [] });
  return errors.length === 0
    ? { status: "already-configured", detail: null, model: config.model, deck: config.deck, fieldTemplates: null }
    : attention(errors[0]);
}

/**
 * @param {(action: string, params: object) => Promise<unknown>} invoke fixed read-only AnkiConnect call
 * @param {object} baseConfig the current (unconfigured) Anki options
 */
export async function detectAnkiSetup(invoke, baseConfig) {
  const eligible = await eligibleCandidates(invoke, baseConfig, modelMap(await invoke("modelNamesAndIds", {})));
  if (eligible.length === 0) return attention("No Senren, Lapis or Kiku note type with its expected fields was found.");
  const ranked = uniqueMaximum(eligible);
  if (ranked.best === null) return attention("The supported note types have no notes yet.");
  if (ranked.tied) return attention("Two note types share the highest note count.");
  const { model, id, family, fields } = ranked.best;

  // Filtered decks are temporary; the remaining cards are grouped by their
  // exact deck and each deck counts the distinct notes it represents.
  const cards = idList(await invoke("findCards", { query: `mid:${id} -deck:filtered` }), "card IDs");
  if (cards.length === 0) return attention(`${model} has no cards in an ordinary deck.`);
  const decks = await invoke("getDecks", { cards });
  if (!decks || typeof decks !== "object" || Array.isArray(decks)) throw new Error("AnkiConnect returned an invalid deck grouping.");
  const counted = [];
  for (const [deck, deckCards] of Object.entries(decks)) {
    const notes = idList(await invoke("cardsToNotes", { cards: idList(deckCards, "deck card IDs") }), "deck note IDs");
    counted.push({ deck, count: new Set(notes).size });
  }
  const deckRank = uniqueMaximum(counted);
  if (deckRank.best === null) return attention(`${model} has no notes in an ordinary deck.`);
  if (deckRank.tied) return attention(`Two decks share the most ${model} notes.`);
  const fieldTemplates = ankiSetupTemplates(family, model, deckRank.best.deck, fields, baseConfig);
  if (fieldTemplates === null) return attention(`${model} does not match the ${FAMILY_LABELS[family]} field layout.`);
  return { status: "configured", detail: null, model, deck: deckRank.best.deck, fieldTemplates };
}
