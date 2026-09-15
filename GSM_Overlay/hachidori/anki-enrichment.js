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

export async function enrichAnkiNote(context, { audio, render, media }) {
  const { request, invoke, noteId, appliedFields, existingFields, resolved, resources } = context;
  const warnings = [];
  async function store(file) {
    const filename = await invoke("storeMediaFile", { filename: file.filename, data: file.data, deleteExisting: false }, 30_000);
    if (filename !== file.filename) throw new Error("Anki stored media under a different filename. The checked note fields were left unchanged.");
  }
  // Only fetch images actually referenced by committed fields, not images in
  // an overwrite field whose policy preserved a different existing value.
  for (const item of resources.media) {
    if (!Object.values(appliedFields).some(value => value.includes(item.filename))) continue;
    try { await store({ ...item, data: await media(item, request.generation) }); }
    catch (error) { warnings.push(`Dictionary image ${item.path}: ${error.message}`); }
  }
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
    await store(file);
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
