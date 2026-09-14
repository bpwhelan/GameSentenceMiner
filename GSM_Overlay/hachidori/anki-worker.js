// SPDX-License-Identifier: GPL-3.0-or-later
import { createAnkiMiningService } from "./anki-mining.js";
import { enrichAnkiNote } from "./anki-enrichment.js";
import { ankiTemplateMarkerNames } from "./anki-templates.js";
import {
  CAPTURE_FILENAMES, CAPTURE_LIMITS, MAX_LINKED_SCREENSHOT_BYTES, decodedBase64Length,
  validateLinkedAnkiClientMedia,
} from "./anki-client-media.js";

function assertCapturePin(pin) {
  if (!pin || typeof pin !== "object"
      || typeof pin.token !== "string" || !pin.token || pin.token.length > 256
      || typeof pin.captureSessionId !== "string" || !pin.captureSessionId || pin.captureSessionId.length > 256
      || !["texthooker", "cue", "dom", "recent"].includes(pin.sourceKind)
      || typeof pin.sourceLabel !== "string" || !pin.sourceLabel || pin.sourceLabel.length > 100
      || typeof pin.partial !== "boolean"
      || !Number.isFinite(pin.readyAtMs)
      || !CAPTURE_FILENAMES.animation.test(pin.animationFilename)
      || !CAPTURE_FILENAMES.audio.test(pin.audioFilename)) {
    throw new Error("The captured-media pin is invalid or expired. Look up the text again.");
  }
}

// A note that was definitively not written leaves no picture of its own behind.
async function releaseScreenshot({ writeResources, invoke }) {
  const filename = writeResources?.screenshotFilename;
  if (typeof filename !== "string" || filename === "") return;
  await invoke("deleteMediaFile", { filename }, 10_000);
}

function validateCapture({ request, prepared, capture: selected }) {
  const media = prepared.config.mediaCapture;
  if (!media?.enabled) throw new Error("Enable media capture in Settings before using captured-media markers.");
  if (selected.requirements.includeAnimation && !media.includeAnimation) {
    throw new Error("This note maps captured animation, but animation capture is disabled.");
  }
  if (selected.requirements.includeAudio && !media.includeCapturedAudio) {
    throw new Error("This note maps captured audio, but captured-audio output is disabled.");
  }
  assertCapturePin(request.capturePin);
}

export function createAnkiWorkerService({
  gateway,
  readOptions,
  readDictionaries,
  engine,
  offscreen,
  capture = null,
  duplicateIndex,
}) {
  const confirmedCaptureUploads = new Map();
  const linkedClientMedia = new WeakMap();
  const linkedClientPreflights = new WeakSet();

  function isLinkedSubmission(request) {
    return linkedClientMedia.has(request);
  }

  async function currentGeneration(request) {
    const status = await engine({ type: "hd_status" });
    if (!status.ready || status.loading || status.generation !== request.generation) {
      throw new Error("The dictionary generation changed or is being updated. Look up this result again before adding it.");
    }
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
    dictionaryPaths: resources.dictionaryPaths });

  async function captureRequest(type, fields) {
    if (typeof capture !== "function") throw new Error("The captured-media host is unavailable.");
    const reply = await capture({ type, ...fields });
    if (!reply || reply.ok === false) throw new Error(reply?.error || "The captured-media host did not reply.");
    return reply;
  }

  async function uploadCaptureAsset(kind, expectedFilename, metadata, { request, invoke, configKey }) {
    if (!metadata || metadata.filename !== expectedFilename
        || !Number.isSafeInteger(metadata.byteLength) || metadata.byteLength < 1
        || metadata.byteLength > CAPTURE_LIMITS[kind]) {
      throw new Error(`The encoded captured ${kind} is invalid or exceeds its size limit.`);
    }
    // An upload confirmed by one Anki endpoint says nothing about another.
    const uploadKey = `${request.captureJobId}:${configKey}:${kind}`;
    if (confirmedCaptureUploads.get(uploadKey) === expectedFilename) return;
    const asset = isLinkedSubmission(request)
      ? metadata
      : await captureRequest("hd_capture_asset", { jobId: request.captureJobId, kind });
    const byteLength = decodedBase64Length(asset.data);
    if (asset.filename !== expectedFilename || byteLength !== metadata.byteLength
        || byteLength > CAPTURE_LIMITS[kind]) {
      throw new Error(`The captured ${kind} payload changed during preparation.`);
    }
    await currentGeneration(request);
    const stored = await invoke("storeMediaFile", {
      filename: expectedFilename,
      data: asset.data,
      deleteExisting: false,
    }, 30_000);
    if (stored !== expectedFilename) {
      throw new Error(`Anki stored the captured ${kind} under a different filename.`);
    }
    confirmedCaptureUploads.set(uploadKey, expectedFilename);
  }

  // One pending viewport picture at a time: a later capture supersedes an
  // earlier one, and a note that is written consumes it. Nothing is uploaded
  // until then, so a rejected note leaves no unreferenced media in Anki.
  let pendingScreenshot = null;
  let screenshotRequestToken = null;

  // Stored inside the queued write, once the generation, configuration and
  // duplicate decisions have been made. A refused upload is a warning, and the
  // fields that referenced the picture are emptied so the note never points at
  // an image Anki does not have.
  async function storePendingScreenshot({ request, appliedFields, invoke }) {
    const filename = request.screenshot?.filename;
    if (typeof filename !== "string" || filename === "") return { warnings: [] };
    const reference = `<img src="${filename}">`;
    const fields = Object.keys(appliedFields).filter(field => appliedFields[field].includes(reference));
    if (fields.length === 0) {
      // The fields this note actually applies keep their existing picture, so the
      // one that was captured for it is released rather than left held.
      if (!isLinkedSubmission(request) && pendingScreenshot?.token === request.screenshot.token) pendingScreenshot = null;
      return { warnings: [] };
    }
    const withoutPicture = reason => {
      // Pronunciation enrichment renders this request again after the note is
      // saved; keep that render from restoring a picture that was not stored.
      request.captureUnavailable = [...(request.captureUnavailable ?? []), "screenshot"];
      for (const field of fields) appliedFields[field] = appliedFields[field].replaceAll(reference, "");
      return { warnings: [`Screenshot: ${reason}`] };
    };
    const pending = isLinkedSubmission(request)
      ? linkedClientMedia.get(request)?.screenshot
      : pendingScreenshot;
    // Only this note's own picture is consumed: another Add's newer capture is
    // left where it is rather than taken away from it.
    if (!pending || pending.token !== request.screenshot.token || pending.filename !== filename) {
      return withoutPicture("the captured picture was replaced before this note was saved.");
    }
    if (!isLinkedSubmission(request)) pendingScreenshot = null;
    try {
      const stored = await invoke("storeMediaFile", { filename, data: pending.data, deleteExisting: false }, 30_000);
      if (stored !== filename) throw new Error("Anki stored it under a different filename.");
    } catch (error) {
      // The store may have happened even though its answer did not arrive, and
      // the note is about to be written without the picture: take it back out.
      await releaseScreenshot({ writeResources: { screenshotFilename: filename }, invoke }).catch(() => undefined);
      return withoutPicture(error.message);
    }
    return { warnings: [], screenshotFilename: filename };
  }

  async function prepareCapture(context) {
    const screenshot = await storePendingScreenshot(context);
    let clip;
    try {
      clip = await prepareClipCapture(context);
    } catch (error) {
      // No note will be written, and this rejection never reaches the caller's
      // own cleanup, so the picture is taken back out here.
      await releaseScreenshot({ writeResources: screenshot, invoke: context.invoke }).catch(() => undefined);
      throw error;
    }
    if (clip === null) {
      return screenshot.warnings.length === 0 && screenshot.screenshotFilename === undefined ? null : screenshot;
    }
    return { ...clip, ...screenshot, warnings: [...clip.warnings, ...screenshot.warnings] };
  }

  async function prepareClipCapture(context) {
    const { appliedFields, capture: selected, request } = context;
    await currentGeneration(request);
    if (!selected) return null;
    assertCapturePin(request.capturePin);
    if (typeof request.captureJobId !== "string" || !request.captureJobId || request.captureJobId.length > 256) {
      throw new Error("Encode the pinned clip before submitting this note.");
    }
    const supplied = linkedClientMedia.get(request)?.capture;
    const status = isLinkedSubmission(request)
      ? { state: "ready", warnings: supplied?.warnings, assets: supplied?.assets }
      : await captureRequest("hd_capture_job_status", { jobId: request.captureJobId });
    if (status.state === "finishing") throw new Error("The selected clip is still finishing.");
    if (status.state === "encoding") throw new Error("The selected clip is still encoding.");
    if (status.state !== "ready") throw new Error(status.error || "The selected clip could not be encoded.");

    const kinds = [
      ["animation", "includeAnimation", request.capturePin.animationFilename],
      ["audio", "includeAudio", request.capturePin.audioFilename],
    ];
    for (const [kind, requirement, expectedFilename] of kinds) {
      if (!selected.requirements[requirement]) continue;
      if (!Object.values(appliedFields).some(value => value.includes(expectedFilename))) {
        throw new Error(`The applied note fields do not reference the captured ${kind}.`);
      }
      await uploadCaptureAsset(kind, expectedFilename, status.assets?.[kind], context);
    }
    return {
      captureJobId: request.captureJobId,
      linkedClient: isLinkedSubmission(request),
      warnings: Array.isArray(status.warnings)
        ? status.warnings.filter(value => typeof value === "string").map(value => value.slice(0, 500)) : [],
    };
  }

  async function completeCapture({ writeResources }) {
    const jobId = writeResources?.captureJobId;
    if (!jobId) return;
    if (!writeResources.linkedClient) await captureRequest("hd_capture_complete", { jobId });
    for (const key of confirmedCaptureUploads.keys()) {
      if (key.startsWith(`${jobId}:`)) confirmedCaptureUploads.delete(key);
    }
  }

  async function beforeMutation({ request, writeResources }) {
    await currentGeneration(request);
    if (!writeResources?.captureJobId || writeResources.linkedClient) return;
    const status = await captureRequest("hd_capture_job_status", { jobId: writeResources.captureJobId });
    if (status.state !== "ready") throw new Error(status.error || "The captured-media export was cancelled or expired.");
  }

  const mining = createAnkiMiningService({ gateway,
    readConfig: async () => {
      const options = await readOptions();
      return {
        ...options.anki,
        audioSources: options.audioSources.filter(source => source.enabled),
        mediaCapture: options.mediaCapture,
      };
    },
    buildFields: async (request, current, { preflight = false } = {}) => {
      if (!Number.isSafeInteger(request?.generation) || request.generation < 0
          || typeof request.term?.expression !== "string" || !request.term.expression
          || typeof request.term.reading !== "string") throw new Error("Mining requires a current dictionary result.");
      await currentGeneration(request);
      const dictionaries = await readDictionaries();
      const resources = { dictionaryPaths: Object.fromEntries(dictionaries.filter(item => item.enabled !== false)
        .map(item => [item.title, item.path])), audioPrepared: false, audio: null, deferDuplicateCheck: false };
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
    validateCapture,
    beforeWrite: prepareCapture,
    beforeMutation,
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
    afterConfirmed: completeCapture,
    afterRejected: releaseScreenshot,
    duplicateIndex,
    enrich: context => enrichAnkiNote(context, { audio, render, media: async (item, generation) => {
      const reply = await engine({ type: "hd_media", dictionary: item.dictionary, path: item.path, generation });
      if (!reply.dataUrl) throw new Error("The dictionary image is no longer available.");
      return reply.dataUrl.slice(reply.dataUrl.indexOf(",") + 1);
    } }),
  });

  // One viewport screenshot for the mining action being taken now. The caller
  // owns the capture itself, because only it knows which page asked; the picture
  // is held here under a name a field may reference and uploaded only when the
  // note is written, so this reply is immediate and the reader can show itself
  // again without waiting for Anki.
  async function screenshot(captureViewport) {
    const token = crypto.randomUUID();
    screenshotRequestToken = token;
    const { anki } = await readOptions();
    if (anki.captureScreenshot !== true) throw new Error("Screenshots when mining are turned off in Settings.");
    const dataUrl = await captureViewport();
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
    pendingScreenshot = { token, filename: `hachidori-screenshot-${crypto.randomUUID()}.jpg`, data };
    return { token: pendingScreenshot.token, filename: pendingScreenshot.filename };
  }

  // An abandoned or definitively rejected submission releases only its own
  // pending bytes; uploaded media has a separate write-outcome cleanup path.
  function discardScreenshot(request) {
    if (pendingScreenshot !== null && pendingScreenshot.token === request?.token) pendingScreenshot = null;
    return { discarded: true };
  }

  async function submitRequest(request) {
    try {
      const result = await mining.submit(request);
      if (["duplicate", "invalid"].includes(result.state)) discardScreenshot(request.screenshot);
      return result;
    } catch (error) {
      // The mining service reports a possibly sent mutation as uncertain;
      // a rejection here confirms that its note write never happened.
      discardScreenshot(request.screenshot);
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
      const screenshot = pendingScreenshot;
      if (!screenshot || screenshot.token !== request.screenshot.token
          || screenshot.filename !== request.screenshot.filename) {
        throw new Error("The screenshot was replaced before it could be sent to the linked Hachidori.");
      }
      value.screenshot = { token: screenshot.token, filename: screenshot.filename, data: screenshot.data };
    }
    if (typeof request?.captureJobId === "string" && request.captureJobId !== "") {
      assertCapturePin(request.capturePin);
      const status = await captureRequest("hd_capture_job_status", { jobId: request.captureJobId });
      if (status.state === "finishing") throw new Error("The selected clip is still finishing.");
      if (status.state === "encoding") throw new Error("The selected clip is still encoding.");
      if (status.state !== "ready") throw new Error(status.error || "The selected clip could not be encoded.");
      const assets = {};
      for (const kind of ["animation", "audio"]) {
        const metadata = status.assets?.[kind];
        if (!metadata) continue;
        const asset = await captureRequest("hd_capture_asset", { jobId: request.captureJobId, kind });
        assets[kind] = { filename: asset.filename, byteLength: metadata.byteLength, data: asset.data };
      }
      value.capture = {
        jobId: request.captureJobId,
        warnings: Array.isArray(status.warnings)
          ? status.warnings.filter(warning => typeof warning === "string")
            .map(warning => warning.slice(0, 500)).slice(0, 64)
          : [],
        assets,
      };
    }
    if (request?.clientSpeech) value.speech = await clientSpeech(request);
    return validateLinkedAnkiClientMedia(request, value);
  }

  async function settleClientMedia(request, state) {
    discardScreenshot(request?.screenshot);
    const jobId = request?.captureJobId;
    if (typeof jobId !== "string" || jobId === "") return { settled: true };
    if (["added", "updated"].includes(state)) {
      await captureRequest("hd_capture_complete", { jobId });
    } else if (["duplicate", "invalid"].includes(state)) {
      await captureRequest("hd_capture_cancel", { jobId });
    }
    return { settled: true };
  }

  return { ...mining, preflightClient, preflightClientSpeech, submit: submitRequest, submitClient,
    clientMedia, settleClientMedia,
    screenshot, discardScreenshot, async maturity(request) {
    try {
      const options = await readOptions();
      return { mature: options.definitionBlurAnkiMature === true
        && await duplicateIndex.has(options.anki, request?.term?.expression) };
    } catch {
      // Missing local evidence never prevents dictionary lookup.
      return { mature: false };
    }
  } };
}
