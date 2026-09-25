// SPDX-License-Identifier: GPL-3.0-or-later
import { ankiTemplateMarkerNames } from "./anki-templates.js";
import { canonicalAnkiFields, overwriteAnkiFields } from "./anki-duplicates.js";
import { readAnkiNoteFields, verifyAnkiFields } from "./anki-mining.js";

function pronunciationFields(incoming, current, appliedFields, existingFields, warnings) {
  const fields = {};
  for (const [field, value] of Object.entries(incoming)) {
    const baseline = appliedFields[field] ?? existingFields?.[field] ?? "";
    if (typeof current[field] !== "string" || current[field].normalize("NFC") !== baseline.normalize("NFC")) {
      warnings.push(`Field “${field}” changed in Anki; its pronunciation update was skipped.`);
    } else if (current[field] !== value) fields[field] = value;
  }
  return fields;
}

export async function enrichAnkiNote(context, { audio, render, store }) {
  const { request, invoke, noteId, appliedFields, existingFields, resolved, resources } = context;
  const warnings = [];
  const confirmed = new Set(Array.isArray(resources.confirmedMedia) ? resources.confirmedMedia : []);
  async function ensure(file, kind) {
    if (confirmed.has(file.filename)) return;
    await store(file, kind);
    confirmed.add(file.filename);
  }
  // Dictionary media and any first-field pronunciation have already been
  // confirmed before the note mutation. Only deferred pronunciation remains.
  const canonical = existingFields ? canonicalAnkiFields({}, resolved.templates, existingFields).templates : resolved.templates;
  const templates = Object.fromEntries(Object.entries(canonical).filter(([field, template]) => {
    if (!ankiTemplateMarkerNames(template.value).includes("audio")) return false;
    return !existingFields || (template.overwriteMode !== "skip"
      && !(template.overwriteMode === "coalesce" && existingFields[field]));
  }));
  // No enabled audio source means no pronunciation, like a screenshot turned off.
  if (!Object.keys(templates).length || (!resources.audioPrepared && !context.config.audioSources.length)) return warnings;
  try {
    const file = resources.audioPrepared ? resources.audio : await audio(request, context.config);
    await ensure(file, "pronunciation");
    const rendered = await render(request, templates, `[sound:${file.filename}]`, resources);
    const incoming = existingFields ? overwriteAnkiFields(rendered.fields, existingFields, templates, { includeAudio: true }) : rendered.fields;
    // Audio work may have taken seconds. Re-read just before updating; never
    // clobber an external edit or append to our already-applied text a second
    // time. AnkiConnect has no CAS, so the final inter-call race remains.
    const current = await readAnkiNoteFields(invoke, noteId);
    const fields = pronunciationFields(incoming, current, appliedFields, existingFields, warnings);
    if (Object.keys(fields).length) {
      const result = await invoke("updateNoteFields", { note: { id: noteId, fields } }, 10_000);
      if (result !== null) throw new Error("Anki returned an invalid pronunciation-update acknowledgement. Inspect the saved note.");
      await verifyAnkiFields(invoke, noteId, fields);
    }
  } catch (error) { warnings.push(`Pronunciation: ${error.message}`); }
  return warnings;
}
