// SPDX-License-Identifier: GPL-3.0-or-later
import { ankiAvailability, isUndispatchedAnkiTransportError } from "./anki.js";
import { ankiCaptureRequirements, resolveAnkiTemplates } from "./anki-templates.js";
import { ankiDigest } from "./anki-digest.js";
import { inspectAnkiNoteIds } from "./anki-index.js";
import { ankiSetupFamily } from "./anki-setup.js";
import { ankiBrowseQuery, ankiNoteIdsQuery, ankiNoteOptions, canonicalAnkiFields, checkAnkiDuplicate, explainAnkiRefusal,
  findAnkiDuplicateNotes, isAnkiDuplicateError, overwriteAnkiFields, validateAnkiNote, validateAnkiNotes } from "./anki-duplicates.js";

const CONFIG_CHANGED = "Anki configuration changed. Refresh this result before adding a note.";
// The sentence-audio field the Kiku, Lapis and Senren presets leave blank.
const SENTENCE_AUDIO_FIELDS = { kiku: "SentenceAudio", lapis: "SentenceAudio", senren: "sentenceAudio" };

// A mining request from a Netflix subtitle line, with or without its cue, while
// Settings → Advanced → Experimental features → Netflix mining is on.
const netflixRequest = (config, request) => config.netflixMining === true
  && request?.netflix !== null && typeof request?.netflix === "object";

// For a recognised note type, a Netflix request fills its blank sentence-audio
// field with {sentence-audio} in this request's copy of the templates, as the
// removed media mining did. Saved templates and a field the user filled are
// never changed.
function requestConfiguration(current, request) {
  if (!netflixRequest(current.config, request)) return current;
  const field = SENTENCE_AUDIO_FIELDS[ankiSetupFamily(current.config.model)];
  const template = field === undefined ? undefined : current.resolved.templates[field];
  if (template === undefined || template.value.trim() !== "") return current;
  return { ...current, resolved: { ...current.resolved,
    templates: { ...current.resolved.templates, [field]: { ...template, value: "{sentence-audio}" } } } };
}
export async function readAnkiNoteFields(invoke, noteId) {
  const infos = await invoke("notesInfo", { notes: [noteId] });
  const info = Array.isArray(infos) ? infos.find(value => value.noteId === noteId) : null;
  if (!info?.fields || typeof info.fields !== "object" || Array.isArray(info.fields)) throw new Error("Anki did not return the saved note fields.");
  return Object.fromEntries(Object.entries(info.fields).map(([field, value]) => [field, value?.value]));
}

// Names the submitted fields Anki lost or changed; null when the saved note matches.
export function ankiFieldDifferences(fields, noteId, expected) {
  const missing = [], changed = [];
  for (const [field, value] of Object.entries(expected)) {
    if (typeof fields[field] !== "string") missing.push(field);
    else if (fields[field].normalize("NFC") !== value.normalize("NFC")) changed.push(field);
  }
  if (missing.length === 0 && changed.length === 0) return null;
  const list = names => names.map(name => `“${name}”`).join(", ");
  const parts = [];
  if (missing.length) parts.push(`${missing.length === 1 ? "field" : "fields"} ${list(missing)} ${missing.length === 1 ? "is" : "are"} missing from note ${noteId}`);
  if (changed.length) parts.push(`${changed.length === 1 ? "field" : "fields"} ${list(changed)} ${changed.length === 1 ? "was" : "were"} saved with different content`);
  return { fields: [...missing, ...changed],
    message: `Anki's saved note differs from the submitted values: ${parts.join("; ")}. Inspect note ${noteId} in Anki.` };
}

export async function verifyAnkiFields(invoke, noteId, expected) {
  const difference = ankiFieldDifferences(await readAnkiNoteFields(invoke, noteId), noteId, expected);
  if (difference !== null) throw new Error(difference.message);
}

// A check result becomes the reader's decision here. Its per-note error skips
// the gateway's translation, so it is explained before the reader sees it.
async function checkedDecision(prepared, addable, error) {
  return { state: addable ? "addable" : "invalid", canAdd: addable,
    error: error === null ? null : await explainAnkiRefusal(prepared.invoke, prepared.note, error, prepared.resolved.templates) };
}

async function addableDecision(prepared) {
  const check = await validateAnkiNote(prepared.invoke, prepared.note);
  return checkedDecision(prepared, check.addable, check.error);
}

async function unindexedDecision(prepared) {
  const { invoke, note, config, firstField } = prepared;
  const checked = await checkAnkiDuplicate(invoke, note);
  if (!checked.duplicate) return checkedDecision(prepared, checked.addable, checked.error);
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

// The indexed duplicate policy, given the word index's answer and Anki's add
// check where the policy needs one: with no duplicate, and in Add anyway.
const needsAddCheck = (config, duplicate) => !duplicate.noteIds.length || config.duplicateBehavior === "new";

async function indexedDecision(prepared, duplicate, check) {
  if (check) {
    const addable = await checkedDecision(prepared, check.addable, check.error);
    if (!duplicate.noteIds.length || !addable.canAdd) return addable;
  }
  return { state: "duplicate", canAdd: prepared.config.duplicateBehavior === "new", error: null,
    noteIds: duplicate.noteIds, mature: duplicate.mature };
}

async function decision(prepared, request, duplicateIndex) {
  const { invoke, config } = prepared;
  const expression = request.term?.expression ?? request.expression;
  const source = await duplicateIndex.source(config);
  if (source === null) return unindexedDecision(prepared);
  let duplicate = await duplicateIndex.lookup(config, expression, invoke);
  if (duplicate.noteIds.length && config.duplicateBehavior === "overwrite") {
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
  return indexedDecision(prepared, duplicate,
    needsAddCheck(config, duplicate) ? await validateAnkiNote(invoke, prepared.note) : null);
}

// One Template's entries of a popup batch, in order. Overwrite needs each
// target's notesInfo, and a destination the index cannot key needs Anki's own
// dupe: identity, so both keep the per-entry decision. Otherwise the entries
// share one duplicate lookup and one add check.
async function batchDecisions(entries, duplicateIndex) {
  const [{ prepared: { config, invoke } }] = entries;
  if (config.duplicateBehavior === "overwrite" || await duplicateIndex.source(config) === null) {
    return entries.map(({ prepared, request }) => () => decision(prepared, request, duplicateIndex));
  }
  const found = await duplicateIndex.lookupMany(config,
    entries.map(({ request }) => request.term?.expression ?? request.expression), invoke);
  const checked = entries.filter((_, index) => needsAddCheck(config, found[index]));
  const checks = await validateAnkiNotes(invoke, checked.map(({ prepared }) => prepared.note));
  const checkFor = new Map(checked.map((entry, index) => [entry, checks[index]]));
  return entries.map((entry, index) => () => indexedDecision(entry.prepared, found[index], checkFor.get(entry)));
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

// Names the looked-up word in an error, so a reader mining several results
// can tell which one Anki refused.
function describeRequestTerm(request) {
  const expression = request?.term?.expression ?? request?.expression;
  return typeof expression === "string" && expression.trim() ? `“${expression}”` : "this result";
}

async function writeAnkiNote(invoke, note, target, fields) {
  let noteId;
  if (target) {
    const reply = await invoke("updateNoteFields", { note: { id: target.noteId, fields } }, 10_000);
    if (reply !== null) throw new Error("Anki returned an invalid field-update acknowledgement.");
    noteId = target.noteId;
  } else {
    try {
      noteId = await invoke("addNote", { note }, 10_000);
    } catch (error) {
      throw addNoteContext(error, note);
    }
  }
  if (!Number.isSafeInteger(noteId) || noteId <= 0) {
    throw new Error(`Anki did not return a valid note ID for the ${target ? "updated" : "added"} note in deck “${note.deckName}”. Check the note in Anki.`);
  }
  return noteId;
}

// AnkiConnect's "empty" refusal names neither the note nor the field; Anki
// strips HTML before judging, so a first field this side considered filled
// can still be refused. A duplicate refusal is described by the caller.
function addNoteContext(error, note) {
  const message = error?.message ?? String(error);
  const [firstField] = Object.keys(note.fields ?? {});
  const firstValue = firstField === undefined ? "" : String(note.fields[firstField] ?? "");
  const context = `deck “${note.deckName}”, note type “${note.modelName}”`;
  if (!/cannot create note because it is empty/iu.test(message)) return error;
  const detail = `Anki refused the note for ${context} because its first field “${firstField}” is empty`
    + `${firstValue.trim() ? " once Anki stripped its formatting" : ""}.`;
  const raw = (/\(AnkiConnect: (.+)\)$/u.exec(message)?.[1] ?? message).replace(/^AnkiConnect: /u, "");
  return new Error(`${detail} (AnkiConnect: ${raw})`, { cause: error });
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
  enrich,
  duplicateIndex,
  now = Date.now,
}) {
  const cached = new Map();
  let mutations = Promise.resolve();
  const invokeFor = config => (action, params, timeoutMs) => gateway.invoke(action, params, config.apiKey, timeoutMs, config.url);

  async function identity(templateId) {
    const config = await readConfig(templateId);
    if (!config) throw new Error("The selected Anki Template is no longer available.");
    const configJson = JSON.stringify(config);
    const configKey = await ankiDigest(new TextEncoder().encode(JSON.stringify({
      templateId: templateId ?? null,
      config,
    })));
    return { config, configJson, configKey, templateId: templateId ?? null };
  }

  async function configuration(templateId, fresh = false) {
    const current = await identity(templateId);
    const { config, configJson } = current;
    const cacheKey = templateId ?? "";
    const previous = cached.get(cacheKey);
    if (!fresh && previous?.key === configJson && now() < previous.expires) return previous.promise;
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
    cached.set(cacheKey, { key: configJson, expires: now() + 2000, promise });
    return promise;
  }

  async function status(templateId) {
    const current = await configuration(templateId);
    return { available: current.errors.length === 0, configKey: current.configKey, error: current.errors.join("\n") };
  }

  async function view(request) {
    const current = await identity(request?.templateId);
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
    const configured = await configuration(request?.templateId, fresh);
    if (request.configKey !== configured.configKey) throw new Error(CONFIG_CHANGED);
    if (configured.errors.length) throw new Error(configured.errors.join("\n"));
    const current = requestConfiguration(configured, request);
    const resources = await buildFields(request, current, { preflight: !fresh });
    const { fields } = resources;
    const firstField = current.discovery.fields[0];
    if (!fields[firstField]?.trim()) {
      const template = current.resolved.templates[firstField]?.value ?? "";
      throw new Error(`The first field of note type “${current.config.model}”, “${firstField}”, is empty for this result`
        + `${template ? `: its template ${template} produced nothing for ${describeRequestTerm(request)}` : ""}. Anki requires it.`);
    }
    const note = { deckName: current.config.deck, modelName: current.config.model, fields,
      options: ankiNoteOptions(current.config), tags: [...new Set(current.config.tags)] };
    return { ...current, note, resources, firstField, invoke: invokeFor(current.config) };
  }

  // A mapped {screenshot} that the user has left switched on: the reader
  // takes the viewport picture itself, when it submits. The whole
  // request-specific mapping decides, not the subset this preflight would
  // apply, because the authoritative decision is made again inside the
  // write and may then apply a field this one would have kept.
  const screenshotFor = prepared => prepared.config.captureScreenshot === true
    && ankiCaptureRequirements(prepared.resolved.templates).includeScreenshot;
  // A mapped {sentence-audio} on a Netflix request: the reader records the
  // line, or reports why it could not, when it submits.
  const sentenceAudioFor = (prepared, request) => netflixRequest(prepared.config, request)
    && ankiCaptureRequirements(prepared.resolved.templates).includeSentenceAudio
    ? { sentenceAudio: true } : {};
  // A mapped {gif} on a Netflix request: the reader records a GIF of the line
  // when it submits, and falls back to the screenshot where it cannot.
  const gifFor = (prepared, request) => netflixRequest(prepared.config, request)
    && ankiCaptureRequirements(prepared.resolved.templates).includeGif
    ? { gif: true } : {};

  async function deferredReply(request, prepared) {
    const extra = await preflightExtra({ request, prepared, applied: null, deferred: true });
    return { state: "addable", canAdd: true, error: null, deferred: true, screenshot: screenshotFor(prepared),
      ...sentenceAudioFor(prepared, request), ...gifFor(prepared, request), ...extra };
  }

  async function preflightReply(request, prepared, result) {
    const applied = result.canAdd ? fieldsForDecision(prepared, result) : null;
    const extra = await preflightExtra({ request, prepared, applied, deferred: false });
    return {
      state: result.state,
      canAdd: result.canAdd,
      error: result.error,
      action: result.action,
      noteIds: result.noteIds,
      screenshot: screenshotFor(prepared),
      ...sentenceAudioFor(prepared, request),
      ...gifFor(prepared, request),
      ...extra,
    };
  }

  async function preflight(request) {
    const prepared = await prepare(request, false);
    if (prepared.resources.deferDuplicateCheck === true) return deferredReply(request, prepared);
    return preflightReply(request, prepared, await decision(prepared, request, duplicateIndex));
  }

  // The popup's readiness for several results in one request. Each entry gets
  // the reply `preflight` would give it; a failure that belongs to one entry,
  // such as an empty first field, stays with that entry, while a failed shared
  // request fails every entry that waited on it.
  const failedPreflight = error => ({ state: "error", canAdd: false, error: error?.message || String(error) });

  async function batchEntry(index, request) {
    try {
      const prepared = await prepare(request, false);
      if (prepared.resources.deferDuplicateCheck === true) return { reply: await deferredReply(request, prepared) };
      return { entry: { index, request, prepared } };
    } catch (error) {
      return { reply: failedPreflight(error) };
    }
  }

  async function groupReplies(entries) {
    let decisions;
    try {
      decisions = await batchDecisions(entries, duplicateIndex);
    } catch (error) {
      return entries.map(() => failedPreflight(error));
    }
    return Promise.all(entries.map(({ request, prepared }, position) => decisions[position]()
      .then(result => preflightReply(request, prepared, result))
      .catch(failedPreflight)));
  }

  async function preflightMany(requests) {
    const prepared = await Promise.all(requests.map((request, index) => batchEntry(index, request)));
    const replies = prepared.map(({ reply }) => reply);
    const groups = new Map();
    for (const { entry } of prepared) {
      if (entry === undefined) continue;
      const { configKey } = entry.prepared;
      if (!groups.has(configKey)) groups.set(configKey, []);
      groups.get(configKey).push(entry);
    }
    await Promise.all([...groups.values()].map(async entries => {
      (await groupReplies(entries)).forEach((reply, position) => { replies[entries[position].index] = reply; });
    }));
    return replies;
  }

  async function write(request) {
    const prepared = await prepare(request, true);
    const checked = await decision(prepared, request, duplicateIndex);
    if (!checked.canAdd) return { state: checked.state, error: checked.error,
      action: checked.action, noteIds: checked.noteIds };
    const { config, configJson, firstField, note, invoke } = prepared;
    const { fields, target } = fieldsForDecision(prepared, checked);
    if (JSON.stringify(await readConfig(request?.templateId)) !== configJson) throw new Error(CONFIG_CHANGED);
    const writeResources = await beforeWrite({
      request,
      ...prepared,
      target,
      appliedFields: fields,
    });
    // Failed media can restore a field's original value after preparation.
    // Leave it untouched instead of overwriting an intervening Anki edit.
    omitUnchangedFields(fields, target?.fields);
    // A definitive no-write releases whatever only this note would have used.
    // An uncertain write keeps it: the note may exist in Anki after all.
    const releaseRejected = () => afterRejected({ request, ...prepared, writeResources })
      .catch(() => undefined);
    if (JSON.stringify(await readConfig(request?.templateId)) !== configJson) {
      await releaseRejected();
      throw new Error(CONFIG_CHANGED);
    }
    // Validate the remaining write ownership before sending the mutation.
    try {
      await beforeMutation({ request, writeResources });
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
        const firstValue = String(fields[firstField] ?? note.fields[firstField] ?? "").trim();
        return { state: "duplicate", noteIds,
          error: `Anki already has a note in deck “${note.deckName}” (note type “${note.modelName}”) whose first field “${firstField}” is `
            + `${firstValue ? `“${firstValue}”` : "empty"}.` };
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
    // A field an Anki add-on rewrote during the add (AJT Japanese fills furigana
    // on note_will_be_added) is reported but does not make the note untrustworthy:
    // enrichment re-reads and guards its own target fields before updating them.
    // Only a failed readback, or a first field Anki did not save as submitted,
    // leaves the note's identity unknown and skips the deferred pronunciation.
    let verified = false;
    try {
      const difference = ankiFieldDifferences(await readAnkiNoteFields(invoke, noteId), noteId, fields);
      verified = difference === null || !difference.fields.includes(firstField);
      if (difference !== null) warnings.push(difference.message);
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
        writeResources,
        verified,
      });
    } catch (error) {
      warnings.push(error.message);
    }
    if (verified) {
      try {
        warnings.push(...await enrich({ request, ...prepared, noteId, existingFields: target?.fields, appliedFields: fields }));
      } catch (error) {
        warnings.push(error.message);
      }
    }
    cached.delete(request?.templateId ?? "");
    return { state: target ? "updated" : "added", noteId, warnings };
  }

  function submit(request) {
    const operation = mutations.then(() => write(request));
    mutations = operation.catch(() => {});
    return operation;
  }

  async function browse(request) {
    const value = typeof request === "string" ? { expression: request } : request;
    const config = await readConfig(value?.templateId);
    if (!config) throw new Error("The selected Anki Template is no longer available.");
    if (typeof value?.configKey === "string") {
      const configKey = await ankiDigest(new TextEncoder().encode(JSON.stringify({
        templateId: value?.templateId ?? null,
        config,
      })));
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

  return { status, view, preflight, preflightMany, submit, browse };
}
