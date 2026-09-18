// SPDX-License-Identifier: GPL-3.0-or-later
import { ankiAvailability, isUndispatchedAnkiTransportError } from "./anki.js";
import { ankiCaptureRequirements, resolveAnkiTemplates } from "./anki-templates.js";
import { ankiDigest } from "./anki-digest.js";
import { ankiSetupFamily } from "./anki-setup.js";
import { inspectAnkiNoteIds } from "./anki-index.js";
import { ankiBrowseQuery, ankiNoteIdsQuery, ankiNoteOptions, canonicalAnkiFields, checkAnkiDuplicate, findAnkiDuplicateNotes,
  isAnkiDuplicateError, overwriteAnkiFields, validateAnkiNote } from "./anki-duplicates.js";

const CONFIG_CHANGED = "Anki configuration changed. Refresh this result before adding a note.";
const AUTOMATIC_CAPTURE_FIELDS = {
  kiku: { picture: "Picture", audio: "SentenceAudio" },
  lapis: { picture: "Picture", audio: "SentenceAudio" },
  senren: { picture: "picture", audio: "sentenceAudio" },
};

function requestConfiguration(current, request) {
  const fields = AUTOMATIC_CAPTURE_FIELDS[ankiSetupFamily(current.config.model)];
  if (!fields) return current;
  const templates = Object.fromEntries(Object.entries(current.resolved.templates)
    .map(([field, template]) => [field, { ...template }]));
  const routed = { ...current, resolved: { ...current.resolved, templates } };
  const capture = current.config.mediaCapture;
  if (!request.capturePin || capture?.enabled !== true) return routed;
  if (capture.includeAnimation === true && templates[fields.picture]) {
    templates[fields.picture].value = templates[fields.picture].value
      .replaceAll("{screenshot}", "{capture-animation}");
  }
  if (capture.includeCapturedAudio === true && templates[fields.audio]?.value.trim() === "") {
    templates[fields.audio].value = "{capture-audio}";
  }
  return routed;
}

export async function readAnkiNoteFields(invoke, noteId) {
  const infos = await invoke("notesInfo", { notes: [noteId] });
  const info = Array.isArray(infos) ? infos.find(value => value.noteId === noteId) : null;
  if (!info?.fields || typeof info.fields !== "object" || Array.isArray(info.fields)) throw new Error("Anki did not return the saved note fields.");
  return Object.fromEntries(Object.entries(info.fields).map(([field, value]) => [field, value?.value]));
}

export async function verifyAnkiFields(invoke, noteId, expected) {
  const fields = await readAnkiNoteFields(invoke, noteId);
  for (const [field, value] of Object.entries(expected)) {
    if (typeof fields[field] !== "string" || fields[field].normalize("NFC") !== value.normalize("NFC")) {
      throw new Error("Anki's saved fields differ from the submitted values. Inspect the note in Anki.");
    }
  }
}

async function addableDecision(prepared) {
  const check = await validateAnkiNote(prepared.invoke, prepared.note);
  return { state: check.addable ? "addable" : "invalid", canAdd: check.addable, error: check.error };
}

async function unindexedDecision(prepared) {
  const { invoke, note, config, firstField } = prepared;
  const checked = await checkAnkiDuplicate(invoke, note, config);
  if (!checked.duplicate) {
    return { state: checked.addable ? "addable" : "invalid", canAdd: checked.addable, error: checked.error };
  }
  // A non-direct destination field cannot be keyed by the word index. Keep
  // Anki's exact first-field identity as a compatibility path, restricted to
  // the configured destination type so unrelated custom models never block.
  const matches = await findAnkiDuplicateNotes(invoke, note, firstField, config);
  const noteIds = matches.map(match => match.noteId);
  if (config.duplicateBehavior === "overwrite") {
    const target = matches.find(match => match.fields !== null) ?? null;
    return { state: "duplicate", canAdd: target !== null, action: "overwrite", target, noteIds, mature: false,
      error: target ? null : "A duplicate exists, but no matching configured note type is inside the selected scope." };
  }
  if (config.duplicateBehavior === "new") {
    const addable = await addableDecision(prepared);
    if (!addable.canAdd) return addable;
  }
  return {
    state: "duplicate",
    canAdd: config.duplicateBehavior === "new",
    error: null,
    noteIds,
    mature: false,
  };
}

async function decision(prepared, request, duplicateIndex) {
  const { invoke, config } = prepared;
  const expression = request.term?.expression ?? request.expression;
  const source = await duplicateIndex.source(config);
  if (source === null) return unindexedDecision(prepared);
  let duplicate = await duplicateIndex.lookup(config, expression, invoke);
  if (!duplicate.noteIds.length) return addableDecision(prepared);
  if (config.duplicateBehavior === "overwrite") {
    let inspected = await inspectAnkiNoteIds(invoke, source, expression, duplicate.noteIds);
    if (inspected.stale) {
      duplicate = await duplicateIndex.repair(config, expression, invoke);
      if (!duplicate.noteIds.length) return addableDecision(prepared);
      inspected = await inspectAnkiNoteIds(invoke, source, expression, duplicate.noteIds);
    }
    const target = inspected.target;
    return { state: "duplicate", canAdd: target !== null, action: "overwrite", target, noteIds: duplicate.noteIds,
      mature: duplicate.mature,
      error: target ? null : "A duplicate exists, but no matching configured note type is inside the selected scope." };
  }
  if (config.duplicateBehavior === "new") {
    const addable = await addableDecision(prepared);
    if (!addable.canAdd) return addable;
  }
  return { state: "duplicate", canAdd: config.duplicateBehavior === "new", error: null,
    noteIds: duplicate.noteIds, mature: duplicate.mature };
}

function omitUnchangedFields(fields, existing) {
  if (existing) for (const [field, value] of Object.entries(fields)) {
    if (value === existing[field]) delete fields[field];
  }
  return fields;
}

function fieldsForDecision(prepared, checked) {
  const target = checked.target;
  if (!target) {
    return {
      fields: prepared.note.fields,
      target: null,
      templates: prepared.resolved.templates,
    };
  }
  const canonical = canonicalAnkiFields(prepared.note.fields, prepared.resolved.templates, target.fields);
  // Only the initial write omits unchanged values. Pronunciation enrichment
  // compares its complete desired value with the text-only write it replaces.
  const fields = omitUnchangedFields(overwriteAnkiFields(canonical.fields, target.fields, canonical.templates), target.fields);
  return {
    fields,
    target,
    templates: Object.fromEntries(Object.entries(canonical.templates).filter(([field]) => Object.hasOwn(fields, field))),
  };
}

function captureForApplication(request, templates) {
  const requirements = ankiCaptureRequirements(templates);
  const unavailable = new Set(Array.isArray(request.captureUnavailable) ? request.captureUnavailable : []);
  requirements.includeAnimation &&= !unavailable.has("animation");
  requirements.includeAudio &&= !unavailable.has("audio");
  if (!requirements.includeAnimation && !requirements.includeAudio) return null;
  const pin = request.capturePin;
  return {
    requirements,
    sourceLabel: pin?.sourceLabel,
    partial: pin?.partial === true,
    readyAtMs: pin?.readyAtMs,
  };
}

async function writeAnkiNote(invoke, note, target, fields) {
  let noteId;
  if (target) {
    const reply = await invoke("updateNoteFields", { note: { id: target.noteId, fields } }, 10_000);
    if (reply !== null) throw new Error("Anki returned an invalid field-update acknowledgement.");
    noteId = target.noteId;
  } else {
    noteId = await invoke("addNote", { note }, 10_000);
  }
  if (!Number.isSafeInteger(noteId) || noteId <= 0) throw new Error("Anki did not return a valid note ID.");
  return noteId;
}

export function createAnkiMiningService({
  gateway,
  readConfig,
  buildFields,
  beforeWrite,
  beforeMutation = async () => {},
  afterConfirmed = async () => {},
  afterRejected = async () => {},
  preflightExtra = async () => ({}),
  validateCapture = async () => {},
  enrich,
  duplicateIndex,
  now = Date.now,
}) {
  let cached = null;
  let mutations = Promise.resolve();
  const invokeFor = config => (action, params, timeoutMs) => gateway.invoke(action, params, config.apiKey, timeoutMs, config.url);

  async function identity() {
    const config = await readConfig();
    const configJson = JSON.stringify(config);
    const configKey = await ankiDigest(new TextEncoder().encode(configJson));
    return { config, configJson, configKey };
  }

  async function configuration(fresh = false) {
    const current = await identity();
    const { config, configJson } = current;
    if (!fresh && cached?.key === configJson && now() < cached.expires) return cached.promise;
    const promise = (async () => {
      // Correlate reader requests without returning the saved API key/source
      // credentials in a serialized configuration string to each content script.
      const { configKey } = current;
      if (!config.model) return { config, configKey, configJson, errors: ["Choose an Anki note type in Settings."] };
      const discovery = await gateway.discover(config);
      const resolved = resolveAnkiTemplates(config, discovery.fields);
      return { config, configKey, configJson, discovery, resolved, errors: ankiAvailability(config, discovery, resolved) };
    })();
    // GSM's two-second status cache, sharing concurrent callers as well. Only
    // read-only preparation may use it; each submission refreshes discovery.
    cached = { key: configJson, expires: now() + 2000, promise };
    return promise;
  }

  async function status() {
    const current = await configuration();
    return { available: current.errors.length === 0, configKey: current.configKey, error: current.errors.join("\n") };
  }

  async function view(request) {
    const current = await identity();
    const expression = request?.term?.expression ?? request?.expression;
    const unknown = {
      state: "unknown",
      canAdd: false,
      noteIds: [],
      configKey: current.configKey,
      cached: false,
    };
    if (current.config.duplicateBehavior !== "prevent") return unknown;
    const duplicate = await duplicateIndex.peek(current.config, expression);
    if (!duplicate.noteIds.length) return unknown;
    return {
      state: "duplicate",
      canAdd: false,
      noteIds: duplicate.noteIds,
      mature: duplicate.mature,
      configKey: current.configKey,
      cached: true,
    };
  }

  async function prepare(request, fresh) {
    const configured = await configuration(fresh);
    const current = requestConfiguration(configured, request);
    if (request.configKey !== current.configKey) throw new Error(CONFIG_CHANGED);
    if (current.errors.length) throw new Error(current.errors.join("\n"));
    const resources = await buildFields(request, current, { preflight: !fresh });
    const { fields } = resources;
    const firstField = current.discovery.fields[0];
    if (!fields[firstField]?.trim()) throw new Error(`The first Anki field, “${firstField}”, is empty for this result.`);
    const note = { deckName: current.config.deck, modelName: current.config.model, fields,
      options: ankiNoteOptions(current.config), tags: [...new Set(current.config.tags)] };
    return { ...current, note, resources, firstField, invoke: invokeFor(current.config) };
  }

  async function preflight(request) {
    const prepared = await prepare(request, false);
    if (prepared.resources.deferDuplicateCheck === true) {
      const capture = captureForApplication(request, prepared.resolved.templates);
      if (capture) await validateCapture({ request, prepared, capture });
      const extra = await preflightExtra({ request, prepared, applied: null, deferred: true });
      return {
        state: "addable",
        canAdd: true,
        error: null,
        deferred: true,
        capture,
        screenshot: prepared.config.captureScreenshot === true
          && ankiCaptureRequirements(prepared.resolved.templates).includeScreenshot,
        ...(extra ?? {}),
      };
    }
    const result = await decision(prepared, request, duplicateIndex);
    const applied = result.canAdd ? fieldsForDecision(prepared, result) : null;
    const capture = applied ? captureForApplication(request, applied.templates) : null;
    if (capture) await validateCapture({ request, prepared, capture });
    const extra = await preflightExtra({ request, prepared, applied, deferred: false });
    return {
      state: result.state,
      canAdd: result.canAdd,
      error: result.error,
      action: result.action,
      noteIds: result.noteIds,
      capture,
      // A mapped {screenshot} that the user has left switched on: the reader
      // takes the viewport picture itself, when it submits. The whole
      // request-specific mapping decides, not the subset this preflight would
      // apply, because the authoritative decision is made again inside the
      // write and may then apply a field this one would have kept.
      screenshot: prepared.config.captureScreenshot === true
        && ankiCaptureRequirements(prepared.resolved.templates).includeScreenshot,
      ...(extra ?? {}),
    };
  }

  async function write(request) {
    const prepared = await prepare(request, true);
    const checked = await decision(prepared, request, duplicateIndex);
    if (!checked.canAdd) return { state: checked.state, error: checked.error,
      action: checked.action, noteIds: checked.noteIds };
    const { config, configJson, firstField, note, invoke } = prepared;
    const { fields, target, templates } = fieldsForDecision(prepared, checked);
    const capture = captureForApplication(request, templates);
    if (capture) await validateCapture({ request, prepared, capture });
    if (JSON.stringify(await readConfig()) !== configJson) throw new Error(CONFIG_CHANGED);
    const writeResources = await beforeWrite({
      request,
      ...prepared,
      target,
      appliedFields: fields,
      appliedTemplates: templates,
      capture,
    });
    // Failed media can restore a field's original value after preparation.
    // Leave it untouched instead of overwriting an intervening Anki edit.
    omitUnchangedFields(fields, target?.fields);
    // A definitive no-write releases whatever only this note would have used.
    // An uncertain write keeps it: the note may exist in Anki after all.
    const releaseRejected = () => afterRejected({ request, ...prepared, writeResources })
      .catch(() => undefined);
    if (JSON.stringify(await readConfig()) !== configJson) {
      await releaseRejected();
      throw new Error(CONFIG_CHANGED);
    }
    // Uploads and configuration reads can outlive Stop. Validate the remaining
    // write ownership last, with no unrelated await before sending the mutation.
    try {
      await beforeMutation({ request, capture, writeResources });
    } catch (error) {
      await releaseRejected();
      throw error;
    }
    let noteId;
    try {
      noteId = await writeAnkiNote(invoke, note, target, fields);
    } catch (error) {
      if (isAnkiDuplicateError(error.message)) {
        await releaseRejected();
        let noteIds = [];
        try {
          const expression = request.term?.expression ?? request.expression;
          noteIds = await duplicateIndex.source(config) === null
            ? (await findAnkiDuplicateNotes(invoke, note, firstField, config)).map(match => match.noteId)
            : (await duplicateIndex.repair(config, expression, invoke)).noteIds;
        } catch { /* The duplicate result is definitive even if browse discovery fails. */ }
        return { state: "duplicate", error: "This note already exists in Anki.", noteIds };
      }
      if (isUndispatchedAnkiTransportError(error)) {
        // A failed endpoint generation rejected this queued mutation before it
        // entered fetch. Its note cannot exist, so release request-owned media
        // and return a definitive retryable failure instead of uncertainty.
        await releaseRejected();
        throw error;
      }
      // A lost acknowledgement may follow a completed write. Neither this
      // worker nor the reader retries it automatically, including append modes.
      return { state: "uncertain", error: `The write could not be confirmed. Check Anki before trying again. ${error.message}` };
    }
    const warnings = [...(Array.isArray(writeResources?.warnings) ? writeResources.warnings : [])];
    try {
      await duplicateIndex.recordWrite(config, request.term?.expression ?? request.expression, noteId,
        { mature: checked.mature === true });
    } catch (error) {
      warnings.push(`Duplicate index: ${error.message}`);
    }
    let verified = false;
    try {
      await verifyAnkiFields(invoke, noteId, fields);
      verified = true;
    } catch (error) {
      warnings.push(error.message);
    }
    try {
      await afterConfirmed({
        request,
        ...prepared,
        noteId,
        existingFields: target?.fields,
        appliedFields: fields,
        capture,
        writeResources,
        verified,
      });
    } catch (error) {
      warnings.push(`Captured media cleanup: ${error.message}`);
    }
    if (verified) {
      try {
        warnings.push(...await enrich({ request, ...prepared, noteId, existingFields: target?.fields, appliedFields: fields }));
      } catch (error) {
        warnings.push(error.message);
      }
    }
    cached = null;
    return { state: target ? "updated" : "added", noteId, warnings };
  }

  function submit(request) {
    const operation = mutations.then(() => write(request));
    mutations = operation.catch(() => {});
    return operation;
  }

  async function browse(request) {
    const config = await readConfig();
    const value = typeof request === "string" ? { expression: request } : request;
    if (typeof value?.configKey === "string") {
      const configKey = await ankiDigest(new TextEncoder().encode(JSON.stringify(config)));
      if (value.configKey !== configKey) throw new Error(CONFIG_CHANGED);
    }
    const invoke = invokeFor(config);
    const supplied = Array.isArray(value?.noteIds) && value.noteIds.length;
    let noteIds = supplied ? [...value.noteIds] : [];
    let repaired = false;
    if (supplied && typeof value?.expression === "string" && value.expression
        && await duplicateIndex.source(config) !== null) {
      const refreshed = await duplicateIndex.repair(config, value.expression, invoke);
      noteIds = refreshed.noteIds;
      if (!noteIds.length) return { opened: false, noteIds: [], repaired: true };
      repaired = true;
    }
    const query = noteIds.length ? ankiNoteIdsQuery(noteIds) : ankiBrowseQuery(value?.expression ?? "");
    await invoke("guiBrowse", { query }, 30_000);
    return { opened: true, noteIds, repaired };
  }

  return { status, view, preflight, submit, browse };
}
