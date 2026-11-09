// SPDX-License-Identifier: GPL-3.0-or-later
import { createAnkiMiningService } from "./anki-mining.js";
import { enrichAnkiNote } from "./anki-enrichment.js";
import { attachAnkiAddMedia, createAnkiMediaStore } from "./anki-media.js";
import { ankiTemplateMarkerNames } from "./anki-templates.js";
import { buildAnkiFields } from "./anki-values.js";
import { ankiLanguageConfig } from "./anki-setup.js";
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

const SENTENCE_FURIGANA_MARKERS = new Set(["sentence-furigana", "sentence-furigana-plain"]);
// The switch a recorded line's media need: Netflix mining's unless the YouTube
// service (background-video.js) names YouTube mining's.
const NETFLIX_MINING = { flag: "netflixMining", label: "Netflix mining" };

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

// A Template of a named profile (docs/languages.md 5.4). Once the records have
// profiles, background-anki.js gives the mining service this key in place of
// the Template id, so its caches and configuration digests belong to the
// profile; a plain id is the single-profile shape. Ids hold no control
// characters, so the key cannot be mistaken for one.
const PROFILE_TEMPLATE_SEPARATOR = "\u0000";

export function profileTemplateKey(profileId, templateId) {
  return `${PROFILE_TEMPLATE_SEPARATOR}${profileId}${PROFILE_TEMPLATE_SEPARATOR}${templateId ?? ""}`;
}

function profileTemplateTarget(key) {
  if (typeof key !== "string" || !key.startsWith(PROFILE_TEMPLATE_SEPARATOR)) return { profileId: undefined, templateId: key };
  const [, profileId, templateId] = key.split(PROFILE_TEMPLATE_SEPARATOR);
  return { profileId, templateId: templateId === "" ? undefined : templateId };
}

// The profile a mining request is for: its Template key's, or the one a
// request that reads no Template names.
function requestProfile(request) {
  return profileTemplateTarget(request?.templateId).profileId ?? request?.profileId;
}

export function createAnkiWorkerService({
  gateway,
  readOptions,
  // `readProfile(profileId)` is the profile's `{ language, packSettings }` once
  // the records have profiles, else null (docs/languages.md 12);
  // `readOptionsAndProfile` gives both from one read where it can.
  readProfile = async () => null,
  readOptionsAndProfile = async profileId => Promise.all([readOptions(profileId), readProfile(profileId)]),
  readDictionaries,
  engine,
  offscreen,
  duplicateIndex,
}) {
  const linkedClientMedia = new WeakMap();
  // A Template's configuration in its profile's language, which decides how
  // the note is written and what its duplicate index recognises; the
  // single-profile shape's is today's.
  const inLanguage = (config, profile) => ankiLanguageConfig(config, profile?.language);
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
      // URL templates fill {language} from the profile's pack (docs/languages.md 13).
      ...(config.profile ? { language: config.profile.language } : {}),
      ...(linkedClientPreflights.has(request) ? { clientSpeechProbe: true } : {}),
      ...(clientSpeech ? { clientSpeech } : {}),
    });
  };
  // The words of the text before and after the match, split as a hover splits
  // them, for templates that ask for the sentence with furigana. A language
  // without ruby has none, so its sentence stays plain (docs/languages.md 12).
  async function sentenceSegments(request, templates, profile) {
    if (!Object.values(templates).some(template => ankiTemplateMarkerNames(template.value)
      .some(name => SENTENCE_FURIGANA_MARKERS.has(name)))) return null;
    if (profile !== null && !globalThis.HDReaderOptions.optionRequirementMet("ruby", profile.language, profile.packSettings)) {
      return null;
    }
    const profileId = requestProfile(request);
    const options = await readOptions(profileId);
    const end = request.matchOffset + request.matched.length;
    const reply = await engine({
      type: "hd_segment",
      ...(profileId === undefined ? {} : { profileId }),
      chunks: [{ id: 0, text: request.sentence.slice(0, request.matchOffset) }, { id: 1, text: request.sentence.slice(end) }],
      scanLength: options.scanLength,
      options: { frequencyDictionary: options.frequencyDictionary, frequencyOrder: options.frequencyOrder,
        personalDictionary: options.personalDictionaryEnabled },
    });
    return reply.segments.map(segment => segment.spans);
  }
  const render = async (request, templates, audio, resources) => {
    const profile = resources.profile ?? null;
    const segments = await sentenceSegments(request, templates, profile);
    return offscreen({ type: "hd_anki_fields", request: segments ? { ...request, sentenceSegments: segments } : request,
      templates, audio, dictionaryPaths: resources.dictionaryPaths, compactGlossary: resources.compactGlossary === true,
      compactGlossaries: resources.compactGlossaries === true,
      // The note builder writes the profile's language (docs/languages.md 12).
      ...(profile === null ? {} : { profile }) });
  };

  // One pending item of each kind at a time: a later capture supersedes an
  // earlier one, and a note that is written consumes it. Nothing is uploaded
  // until then, so a rejected note leaves no unreferenced media in Anki.
  const pendingMedia = { screenshot: null, "sentence-audio": null, gif: null };
  let screenshotRequestToken = null;

  // Stored inside the queued write, once the generation, configuration and
  // duplicate decisions have been made. A refused upload is a warning, and the
  // fields that referenced the media are emptied so the note never points at
  // a file Anki does not have.
  function takePendingMedia(kind, { request, appliedFields }) {
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
    return { filename, pending, without };
  }

  async function storePendingMedia(kind, context) {
    const taken = takePendingMedia(kind, context);
    if (!taken.pending) return taken;
    const { filename, pending, without } = taken;
    const { invoke } = context;
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

  async function prepareAdd(context) {
    const { request, config, note, resources, resolved, invoke } = context;
    const warnings = [], files = [], captured = {};
    // Only ordinary non-first-field audio reaches this path. Resolve it once
    // and put it in the original note, avoiding a second field mutation.
    const audioTemplates = Object.fromEntries(Object.entries(resolved.templates)
      .filter(([, template]) => ankiTemplateMarkerNames(template.value).includes("audio")));
    if (Object.keys(audioTemplates).length && config.audioSources.length) {
      try {
        const file = await audio(request, config);
        const built = await render(request, audioTemplates, `[sound:${file.filename}]`, resources);
        Object.assign(note.fields, built.fields);
        resources.media.push(...built.media);
        files.push({ ...file, type: "audio", kind: "pronunciation" });
      } catch (error) { warnings.push(`Pronunciation: ${error.message}`); }
    }
    for (const [kind, specification] of Object.entries(CAPTURED_MEDIA)) {
      const taken = takePendingMedia(kind, context);
      if (taken.warning) warnings.push(taken.warning);
      if (!taken.pending) continue;
      captured[specification.resourceKey] = taken.filename;
      files.push({ filename: taken.filename, data: taken.pending.data,
        type: kind === "sentence-audio" ? "audio" : "picture", kind: specification.label });
    }
    try {
      const media = new Map(resources.media.map(item => [item.filename, item]));
      const referenced = [...media.values()].filter(item => Object.values(note.fields).some(value => value.includes(item.filename)));
      files.push(...await Promise.all(referenced.map(async item => ({
        filename: item.filename, data: await dictionaryMedia(item, request.generation),
        type: "picture", kind: "dictionary image", required: true,
      }))));
      await currentGeneration(request);
      warnings.push(...await attachAnkiAddMedia(note, files, invoke));
    } catch (error) {
      await releaseCapturedMedia({ writeResources: captured, invoke });
      throw error;
    }
    return { warnings, ...captured };
  }

  // Audio in the first field is part of Anki's duplicate identity. A
  // failed/stale selection must not turn that identity into text-only.
  // Browser speech is audible work, so preflight verifies only that the
  // active capture can record it and defers the exact duplicate identity
  // until the user submits.
  async function prepareFirstFieldAudio(request, current, resources, preflight) {
    const first = current.resolved.templates[current.discovery.fields[0]];
    if (!ankiTemplateMarkerNames(first.value).includes("audio") || !current.config.audioSources.length) return;
    const prepared = await audio(request, current.config, { recordSpeech: !preflight });
    if (prepared?.recordingRequired === true) {
      if (!preflight) throw new Error("Browser text-to-speech was not recorded for this note.");
      if (prepared.clientSpeech) resources.clientSpeech = prepared.clientSpeech;
      resources.deferDuplicateCheck = true;
    } else {
      resources.audioPrepared = true;
      resources.audio = prepared;
    }
  }

  const mining = createAnkiMiningService({ gateway,
    readConfig: async key => {
      const { profileId, templateId } = profileTemplateTarget(key);
      const [options, profile] = await readOptionsAndProfile(profileId);
      const template = globalThis.HDReaderOptions.ankiTemplateConfig(options.anki, templateId);
      if (template === null) return null;
      return {
        ...inLanguage(template, profile),
        audioSources: options.audioSources.filter(source => source.enabled),
        // Part of the checked configuration, so toggling Smaller Anki cards or
        // Compact popup and Anki between a preflight and Add refuses the stale Add.
        compactGlossary: options.smallerAnkiCards === true,
        compactGlossaries: options.glossaryLayoutMode === "compact-popup-anki",
        // Likewise for the experimental Netflix and YouTube mining switches,
        // which decide whether a request from the site gets its sentence audio.
        netflixMining: options.experimental.netflixMining === true,
        youtubeMining: options.experimental.youtubeMining === true,
        // And for the profile's language, which decides how the note is written.
        ...(profile === null ? {} : { profile }),
      };
    },
    buildFields: async (request, current, { preflight = false } = {}) => {
      if (!Number.isSafeInteger(request?.generation) || request.generation < 0
          || typeof request.term?.expression !== "string" || !request.term.expression
          || typeof request.term.reading !== "string") throw new Error("Mining requires a current dictionary result.");
      const resources = { dictionaryPaths: {}, compactGlossary: current.config.compactGlossary === true,
        compactGlossaries: current.config.compactGlossaries === true,
        audioPrepared: false, audio: null, deferDuplicateCheck: false,
        ...(current.config.profile ? { profile: current.config.profile } : {}) };
      if (preflight && Object.values(current.resolved.templates).length === 1
          && /^\{expression\}$/iu.test(current.resolved.templates[current.discovery.fields[0]]?.value ?? "")) {
        // No offscreen document, dictionary reads or engine wake-up just to
        // ask Anki about a word already supplied by this lookup.
        return { ...resources, fields: await buildAnkiFields(request, current.resolved.templates, {}), media: [] };
      }
      await currentGeneration(request);
      const dictionaries = await readDictionaries(requestProfile(request));
      resources.dictionaryPaths = Object.fromEntries(dictionaries.filter(item => item.enabled !== false)
        .map(item => [item.title, item.path]));
      await prepareFirstFieldAudio(request, current, resources, preflight);
      const pronunciation = resources.audio ? `[sound:${resources.audio.filename}]`
        : resources.deferDuplicateCheck ? "[sound:hachidori_pending_speech.wav]" : "";
      const built = await render(request, current.resolved.templates, pronunciation, resources);
      return { ...resources, ...built };
    },
    beforeWrite: prepareWrite,
    prepareAdd,
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
  async function screenshot(captureViewport, key) {
    const token = crypto.randomUUID();
    screenshotRequestToken = token;
    const { profileId, templateId } = profileTemplateTarget(key);
    const options = await readOptions(profileId);
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

  // Experimental Netflix and YouTube mining: the WAV of the subtitle line the
  // reader just had replayed and recorded. Like the screenshot it is held here
  // and stored only inside the note's write. `feature` is the site's switch.
  async function sentenceAudio(data, key, feature = NETFLIX_MINING) {
    const { profileId, templateId } = profileTemplateTarget(key);
    const options = await readOptions(profileId);
    if (options.experimental[feature.flag] !== true) throw new Error(`${feature.label} is turned off in Settings.`);
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

  // Experimental Netflix and YouTube mining: the animated GIF of the subtitle
  // line the reader just had replayed and recorded. Held here and stored only
  // inside the note's write, exactly like the screenshot and the WAV.
  async function gifImage(data, key, feature = NETFLIX_MINING) {
    const { profileId, templateId } = profileTemplateTarget(key);
    const options = await readOptions(profileId);
    if (options.experimental[feature.flag] !== true) throw new Error(`${feature.label} is turned off in Settings.`);
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
    const options = await readOptions(requestProfile(request));
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
      const profileId = requestProfile(request);
      const [options, profile] = await readOptionsAndProfile(profileId);
      return { mature: options.definitionBlurAnkiMature === true
        && await duplicateIndex.has(inLanguage(options.anki, profile), request?.term?.expression) };
    } catch {
      // Missing local evidence never prevents dictionary lookup.
      return { mature: false };
    }
  },
    // Page-wide word status (#520): the cached index rows of the requested
    // profile's first Template, read locally without contacting Anki. The
    // reader reconciles against revision.
    async wordStatus(request) {
      const headwords = request?.headwords;
      if (!Array.isArray(headwords) || headwords.some(headword => typeof headword !== "string")) {
        throw new Error("Word status requires an array of headwords.");
      }
      const profileId = requestProfile(request);
      const [options, profile] = await readOptionsAndProfile(profileId);
      return duplicateIndex.statuses(inLanguage(options.anki, profile), headwords);
    } };
}
