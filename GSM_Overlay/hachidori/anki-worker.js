// SPDX-License-Identifier: GPL-3.0-or-later
import { createAnkiMiningService } from "./anki-mining.js";
import { enrichAnkiNote } from "./anki-enrichment.js";
import { createAnkiMediaStore } from "./anki-media.js";
import { ankiTemplateMarkerNames } from "./anki-templates.js";
import {
  MAX_LINKED_SCREENSHOT_BYTES, decodedBase64Length,
  validateLinkedAnkiClientMedia,
} from "./anki-client-media.js";

// A note that was definitively not written leaves no media of its own behind.
async function releaseCapturedMedia({ writeResources, invoke }) {
  const filenames = [writeResources?.screenshotFilename, writeResources?.sentenceAudioFilename, writeResources?.gifFilename]
    .filter(filename => typeof filename === "string" && filename !== "");
  await Promise.all(filenames.map(filename => invoke("deleteMediaFile", { filename }, 10_000).catch(() => undefined)));
}

// Media the reader captures for one mining action. Each kind is held under its
// own token until the note is written, then stored inside the queued write.
const CAPTURED_MEDIA = {
  screenshot: { requestKey: "screenshot", resourceKey: "screenshotFilename", label: "Screenshot",
    reference: filename => `<img src="${filename}">`,
    replaced: "the captured picture was replaced before this note was saved." },
  "sentence-audio": { requestKey: "sentenceAudio", resourceKey: "sentenceAudioFilename", label: "Sentence audio",
    reference: filename => `[sound:${filename}]`,
    replaced: "the recorded line was replaced before this note was saved." },
  gif: { requestKey: "gif", resourceKey: "gifFilename", label: "GIF",
    reference: filename => `<img src="${filename}">`,
    replaced: "the recorded GIF was replaced before this note was saved." },
};

export function createAnkiWorkerService({
  gateway,
  readOptions,
  readDictionaries,
  engine,
  offscreen,
  duplicateIndex,
}) {
  const linkedClientMedia = new WeakMap();
  const linkedClientPreflights = new WeakSet();
  const ankiMediaStore = createAnkiMediaStore();

  function isLinkedSubmission(request) {
    return linkedClientMedia.has(request);
  }

  async function currentGeneration(request) {
    const status = await engine({ type: "hd_status" });
    if (!status.ready || status.loading || status.generation !== request.generation) {
      throw new Error("The dictionary generation changed or is being updated. Look up this result again before adding it.");
    }
  }

  async function dictionaryMedia(item, generation) {
    const reply = await engine({ type: "hd_media", dictionary: item.dictionary, path: item.path, generation });
    const match = typeof reply.dataUrl === "string"
      ? /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/u.exec(reply.dataUrl)
      : null;
    if (!match) throw new Error("The dictionary image is no longer available or is malformed.");
    return match[2];
  }
  const audio = (request, config, { recordSpeech = true } = {}) => {
    const clientSpeech = linkedClientMedia.get(request)?.speech;
    return offscreen({
      type: "hd_anki_audio",
      term: request.term,
      selection: request.audioSelection,
      sources: config.audioSources,
      recordSpeech,
      ...(linkedClientPreflights.has(request) ? { clientSpeechProbe: true } : {}),
      ...(clientSpeech ? { clientSpeech } : {}),
    });
  };
  const render = (request, templates, audio, resources) => offscreen({ type: "hd_anki_fields", request, templates, audio,
    dictionaryPaths: resources.dictionaryPaths, compactGlossary: resources.compactGlossary === true });

  // One pending item of each kind at a time: a later capture supersedes an
  // earlier one, and a note that is written consumes it. Nothing is uploaded
  // until then, so a rejected note leaves no unreferenced media in Anki.
  const pendingMedia = { screenshot: null, "sentence-audio": null, gif: null };
  let screenshotRequestToken = null;

  // Stored inside the queued write, once the generation, configuration and
  // duplicate decisions have been made. A refused upload is a warning, and the
  // fields that referenced the media are emptied so the note never points at
  // a file Anki does not have.
  async function storePendingMedia(kind, { request, appliedFields, invoke }) {
    const { requestKey, label, reference: referenceFor, replaced } = CAPTURED_MEDIA[kind];
    const filename = request[requestKey]?.filename;
    if (typeof filename !== "string" || filename === "") return {};
    const reference = referenceFor(filename);
    const fields = Object.keys(appliedFields).filter(field => appliedFields[field].includes(reference));
    if (fields.length === 0) {
      // The fields this note actually applies keep their existing media, so
      // what was captured for it is released rather than left held.
      if (!isLinkedSubmission(request) && pendingMedia[kind]?.token === request[requestKey].token) pendingMedia[kind] = null;
      return {};
    }
    const without = reason => {
      // Pronunciation enrichment renders this request again after the note is
      // saved; keep that render from restoring media that was not stored.
      request.captureUnavailable = [...(request.captureUnavailable ?? []), kind];
      for (const field of fields) appliedFields[field] = appliedFields[field].replaceAll(reference, "");
      return { warning: `${label}: ${reason}` };
    };
    const pending = isLinkedSubmission(request)
      ? linkedClientMedia.get(request)?.[requestKey]
      : pendingMedia[kind];
    // Only this note's own media is consumed: another Add's newer capture is
    // left where it is rather than taken away from it.
    if (!pending || pending.token !== request[requestKey].token || pending.filename !== filename) {
      return without(replaced);
    }
    if (!isLinkedSubmission(request)) pendingMedia[kind] = null;
    try {
      const stored = await invoke("storeMediaFile", { filename, data: pending.data, deleteExisting: false }, 30_000);
      if (stored !== filename) throw new Error("Anki stored it under a different filename.");
    } catch (error) {
      // The store may have happened even though its answer did not arrive, and
      // the note is about to be written without the media: take it back out.
      await releaseCapturedMedia({ writeResources: { [CAPTURED_MEDIA[kind].resourceKey]: filename }, invoke });
      return without(error.message);
    }
    return { filename };
  }

  async function storePendingScreenshot(context) {
    const screenshot = await storePendingMedia("screenshot", context);
    const sentenceAudio = await storePendingMedia("sentence-audio", context);
    const gif = await storePendingMedia("gif", context);
    return {
      warnings: [screenshot.warning, sentenceAudio.warning, gif.warning].filter(Boolean),
      ...(screenshot.filename ? { screenshotFilename: screenshot.filename } : {}),
      ...(sentenceAudio.filename ? { sentenceAudioFilename: sentenceAudio.filename } : {}),
      ...(gif.filename ? { gifFilename: gif.filename } : {}),
    };
  }

  async function prepareWrite(context) {
    const screenshot = await storePendingScreenshot(context);
    try {
      await ankiMediaStore.prepare({
        ...context,
        media: dictionaryMedia,
        validate: () => currentGeneration(context.request),
      });
    } catch (error) {
      await releaseCapturedMedia({ writeResources: screenshot, invoke: context.invoke });
      throw error;
    }
    return screenshot;
  }

  const mining = createAnkiMiningService({ gateway,
    readConfig: async templateId => {
      const options = await readOptions();
      const template = globalThis.HDReaderOptions.ankiTemplateConfig(options.anki, templateId);
      if (template === null) return null;
      return {
        ...template,
        audioSources: options.audioSources.filter(source => source.enabled),
        // Part of the checked configuration, so toggling Smaller Anki cards
        // between a preflight and Add refuses the stale Add.
        compactGlossary: options.experimental.smallerAnkiCards === true,
        // Likewise for the experimental Netflix mining switch, which decides
        // whether a Netflix request gets its sentence audio.
        netflixMining: options.experimental.netflixMining === true,
      };
    },
    buildFields: async (request, current, { preflight = false } = {}) => {
      if (!Number.isSafeInteger(request?.generation) || request.generation < 0
          || typeof request.term?.expression !== "string" || !request.term.expression
          || typeof request.term.reading !== "string") throw new Error("Mining requires a current dictionary result.");
      await currentGeneration(request);
      const dictionaries = await readDictionaries();
      const resources = { dictionaryPaths: Object.fromEntries(dictionaries.filter(item => item.enabled !== false)
        .map(item => [item.title, item.path])), compactGlossary: current.config.compactGlossary === true,
        audioPrepared: false, audio: null, deferDuplicateCheck: false };
      const first = current.resolved.templates[current.discovery.fields[0]];
      if (ankiTemplateMarkerNames(first.value).includes("audio") && current.config.audioSources.length) {
        // Audio in the first field is part of Anki's duplicate identity. A
        // failed/stale selection must not turn that identity into text-only.
        // Browser speech is audible work, so preflight verifies only that the
        // active capture can record it and defers the exact duplicate identity
        // until the user submits.
        const prepared = await audio(request, current.config, { recordSpeech: !preflight });
        if (prepared?.recordingRequired === true) {
          if (!preflight) throw new Error("Browser text-to-speech was not recorded for this note.");
          if (prepared.clientSpeech) resources.clientSpeech = prepared.clientSpeech;
          resources.deferDuplicateCheck = true;
        }
        else {
          resources.audioPrepared = true;
          resources.audio = prepared;
        }
      }
      const pronunciation = resources.audio ? `[sound:${resources.audio.filename}]`
        : resources.deferDuplicateCheck ? "[sound:hachidori_pending_speech.wav]" : "";
      const built = await render(request, current.resolved.templates, pronunciation, resources);
      return { ...resources, ...built };
    },
    beforeWrite: prepareWrite,
    beforeMutation: ({ request }) => currentGeneration(request),
    preflightExtra: async ({ request, prepared, applied }) => {
      if (!linkedClientPreflights.has(request)) return {};
      if (prepared.resources.clientSpeech) return { clientSpeech: prepared.resources.clientSpeech };
      if (prepared.resources.audioPrepared || !applied
          || !Object.values(applied.templates).some(template =>
            ankiTemplateMarkerNames(template.value).includes("audio"))
          || prepared.config.audioSources.length === 0) return {};
      try {
        const planned = await audio(request, prepared.config, { recordSpeech: false });
        return planned?.recordingRequired === true && planned.clientSpeech
          ? { clientSpeech: planned.clientSpeech }
          : {};
      } catch {
        // Non-first-field pronunciation remains best-effort. Submission will
        // report the ordinary warning if no configured source is available.
        return {};
      }
    },
    afterRejected: releaseCapturedMedia,
    duplicateIndex,
    enrich: context => enrichAnkiNote(context, {
      audio,
      render,
      store: (file, kind) => ankiMediaStore.ensure({
        invoke: context.invoke,
        filename: file.filename,
        data: file.data,
        kind,
      }),
    }),
  });

  // One viewport screenshot for the mining action being taken now. The caller
  // owns the capture itself, because only it knows which page asked; the picture
  // is held here under a name a field may reference and uploaded only when the
  // note is written, so this reply is immediate and the reader can show itself
  // again without waiting for Anki.
  async function screenshot(captureViewport, templateId) {
    const token = crypto.randomUUID();
    screenshotRequestToken = token;
    const options = await readOptions();
    const { anki } = options;
    const template = globalThis.HDReaderOptions.ankiTemplateConfig(anki, templateId);
    if (template === null) throw new Error("The selected Anki Template is no longer available.");
    if (template.captureScreenshot !== true) throw new Error("Screenshots when mining are turned off in Settings.");
    const dataUrl = await captureViewport(options);
    // Capture retries can complete out of order. Only the latest request may
    // publish its bytes, even if a newer picture has already been consumed.
    if (screenshotRequestToken !== token) throw new Error("A newer capture replaced this screenshot request.");
    const prefix = "data:image/jpeg;base64,";
    const data = typeof dataUrl === "string" && dataUrl.startsWith(prefix)
      ? dataUrl.slice(prefix.length) : "";
    const byteLength = decodedBase64Length(data);
    if (byteLength === null || byteLength > MAX_LINKED_SCREENSHOT_BYTES) {
      throw new Error("This page produced no screenshot or exceeded the 6 MiB screenshot limit.");
    }
    pendingMedia.screenshot = { token, filename: `hachidori-screenshot-${crypto.randomUUID()}.jpg`, data };
    return { token: pendingMedia.screenshot.token, filename: pendingMedia.screenshot.filename };
  }

  // Experimental Netflix mining: the WAV of the subtitle line the reader just
  // had replayed and recorded. Like the screenshot it is held here and stored
  // only inside the note's write.
  async function sentenceAudio(data, templateId) {
    const options = await readOptions();
    if (options.experimental.netflixMining !== true) throw new Error("Netflix mining is turned off in Settings.");
    if (globalThis.HDReaderOptions.ankiTemplateConfig(options.anki, templateId) === null) {
      throw new Error("The selected Anki Template is no longer available.");
    }
    if (decodedBase64Length(data) === null || !data.startsWith("UklG")) {
      throw new Error("The recording produced no WAV audio.");
    }
    const held = { token: crypto.randomUUID(), filename: `hachidori-sentence-audio-${crypto.randomUUID()}.wav`, data };
    pendingMedia["sentence-audio"] = held;
    return { token: held.token, filename: held.filename };
  }

  // Experimental Netflix mining: the animated GIF of the subtitle line the
  // reader just had replayed and recorded. Held here and stored only inside
  // the note's write, exactly like the screenshot and the WAV.
  async function gifImage(data, templateId) {
    const options = await readOptions();
    if (options.experimental.netflixMining !== true) throw new Error("Netflix mining is turned off in Settings.");
    if (globalThis.HDReaderOptions.ankiTemplateConfig(options.anki, templateId) === null) {
      throw new Error("The selected Anki Template is no longer available.");
    }
    // GIF87a/GIF89a both base64-encode to the "R0lG" prefix.
    if (decodedBase64Length(data) === null || !data.startsWith("R0lG")) {
      throw new Error("The recording produced no GIF image.");
    }
    const held = { token: crypto.randomUUID(), filename: `hachidori-gif-${crypto.randomUUID()}.gif`, data };
    pendingMedia.gif = held;
    return { token: held.token, filename: held.filename };
  }

  // An abandoned or definitively rejected submission releases only its own
  // pending bytes; uploaded media has a separate write-outcome cleanup path.
  // Tokens are unique across kinds, so one discard serves every capture.
  function discardScreenshot(request) {
    for (const kind of Object.keys(pendingMedia)) {
      if (pendingMedia[kind] !== null && pendingMedia[kind].token === request?.token) pendingMedia[kind] = null;
    }
    return { discarded: true };
  }

  async function submitRequest(request) {
    try {
      const result = await mining.submit(request);
      if (["duplicate", "invalid"].includes(result.state)) {
        discardScreenshot(request.screenshot);
        discardScreenshot(request.sentenceAudio);
        discardScreenshot(request.gif);
      }
      return result;
    } catch (error) {
      // The mining service reports a possibly sent mutation as uncertain;
      // a rejection here confirms that its note write never happened.
      discardScreenshot(request.screenshot);
      discardScreenshot(request.sentenceAudio);
      discardScreenshot(request.gif);
      throw error;
    }
  }

  async function submitClient(request, clientMedia) {
    const validated = validateLinkedAnkiClientMedia(request, clientMedia);
    linkedClientMedia.set(request, validated);
    try {
      return await submitRequest(request);
    } finally {
      linkedClientMedia.delete(request);
    }
  }

  async function preflightClient(request) {
    linkedClientPreflights.add(request);
    try {
      return await mining.preflight(request);
    } finally {
      linkedClientPreflights.delete(request);
    }
  }

  async function resolveClientSpeech(request, recordSpeech) {
    const plan = request?.clientSpeech;
    if (!plan || typeof plan !== "object" || Array.isArray(plan)
        || typeof request.term?.expression !== "string" || typeof request.term.reading !== "string"
        || plan.expression !== request.term.expression || plan.reading !== request.term.reading) {
      throw new Error("The linked browser-speech request is invalid or stale.");
    }
    const options = await readOptions();
    const sources = options.audioSources.filter(source => source.enabled);
    const source = sources.find(candidate => candidate.id === plan.sourceId
      && JSON.stringify(candidate) === plan.sourceKey
      && typeof candidate.type === "string" && candidate.type.startsWith("text-to-speech"));
    if (!source) throw new Error("The browser-speech source changed. Check Audio Settings and try again.");
    if (request.audioSelection !== undefined
        && (request.audioSelection?.sourceId !== source.id || request.audioSelection.sourceKey !== plan.sourceKey)) {
      throw new Error("The selected pronunciation changed before browser speech could be recorded.");
    }
    const file = await offscreen({
      type: "hd_anki_audio",
      term: request.term,
      selection: request.audioSelection,
      sources: [source],
      recordSpeech,
    });
    if (!recordSpeech) {
      if (file?.recordingRequired !== true) {
        throw new Error("Browser text-to-speech preflight returned an unexpected result.");
      }
      return { available: true };
    }
    const byteLength = decodedBase64Length(file?.data);
    if (file?.sourceId !== source.id || typeof file.filename !== "string"
        || byteLength === null || byteLength < 1) {
      throw new Error("Browser text-to-speech produced no transferable WAV data.");
    }
    return {
      sourceId: plan.sourceId,
      sourceKey: plan.sourceKey,
      expression: plan.expression,
      reading: plan.reading,
      filename: file.filename,
      byteLength,
      data: file.data,
    };
  }

  const clientSpeech = request => resolveClientSpeech(request, true);
  const preflightClientSpeech = request => resolveClientSpeech(request, false);

  // The reading browser owns these bytes. Export them only when submission is
  // about to cross the sharing socket, without consulting its local engine or
  // Anki endpoint.
  async function clientMedia(request) {
    const value = {};
    if (request?.screenshot && !request.captureUnavailable?.includes("screenshot")) {
      const screenshot = pendingMedia.screenshot;
      if (!screenshot || screenshot.token !== request.screenshot.token
          || screenshot.filename !== request.screenshot.filename) {
        throw new Error("The screenshot was replaced before it could be sent to the linked Hachidori.");
      }
      value.screenshot = { token: screenshot.token, filename: screenshot.filename, data: screenshot.data };
    }
    if (request?.clientSpeech) value.speech = await clientSpeech(request);
    return validateLinkedAnkiClientMedia(request, value);
  }

  async function settleClientMedia(request) {
    discardScreenshot(request?.screenshot);
    return { settled: true };
  }

  return { ...mining, preflightClient, preflightClientSpeech, submit: submitRequest, submitClient,
    clientMedia, settleClientMedia,
    screenshot, discardScreenshot, sentenceAudio, gifImage, async maturity(request) {
    try {
      const options = await readOptions();
      return { mature: options.definitionBlurAnkiMature === true
        && await duplicateIndex.has(options.anki, request?.term?.expression) };
    } catch {
      // Missing local evidence never prevents dictionary lookup.
      return { mature: false };
    }
  },
    // Page-wide word status (#520): the first Template's cached index rows, read
    // locally without contacting Anki. The reader reconciles against revision.
    async wordStatus(request) {
      const headwords = request?.headwords;
      if (!Array.isArray(headwords) || headwords.some(headword => typeof headword !== "string")) {
        throw new Error("Word status requires an array of headwords.");
      }
      const options = await readOptions();
      return duplicateIndex.statuses(options.anki, headwords);
    } };
}
