// SPDX-License-Identifier: GPL-3.0-or-later
import { createAnkiMiningService } from "./anki-mining.js";
import { enrichAnkiNote } from "./anki-enrichment.js";
import { ankiTemplateMarkerNames } from "./anki-templates.js";
import { MAX_ANIMATED_AVIF_BYTES } from "./avif-sequence.js";
import { MAX_WAV_BYTES } from "./capture-buffer.js";

const CAPTURE_FILENAMES = {
  animation: /^hachidori-[a-z0-9]+\.avif$/u,
  audio: /^hachidori-[a-z0-9]+\.wav$/u,
};
const CAPTURE_LIMITS = {
  animation: MAX_ANIMATED_AVIF_BYTES,
  audio: MAX_WAV_BYTES,
};

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

function decodedBase64Length(value) {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0
      || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) return null;
  if (value.endsWith("==")) return value.length / 4 * 3 - 2;
  const padding = Number(value.endsWith("="));
  return value.length / 4 * 3 - padding;
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
  maturityCache,
}) {
  const confirmedCaptureUploads = new Map();

  async function currentGeneration(request) {
    const status = await engine({ type: "hd_status" });
    if (!status.ready || status.loading || status.generation !== request.generation) {
      throw new Error("The dictionary generation changed or is being updated. Look up this result again before adding it.");
    }
  }
  const audio = (request, config, { recordSpeech = true } = {}) => offscreen({ type: "hd_anki_audio", term: request.term,
    selection: request.audioSelection, sources: config.audioSources, recordSpeech });
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
    const asset = await captureRequest("hd_capture_asset", { jobId: request.captureJobId, kind });
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
      if (pendingScreenshot?.token === request.screenshot.token) pendingScreenshot = null;
      return { warnings: [] };
    }
    const withoutPicture = reason => {
      // Pronunciation enrichment renders this request again after the note is
      // saved; keep that render from restoring a picture that was not stored.
      request.captureUnavailable = [...(request.captureUnavailable ?? []), "screenshot"];
      for (const field of fields) appliedFields[field] = appliedFields[field].replaceAll(reference, "");
      return { warnings: [`Screenshot: ${reason}`] };
    };
    const pending = pendingScreenshot;
    // Only this note's own picture is consumed: another Add's newer capture is
    // left where it is rather than taken away from it.
    if (pending === null || pending.token !== request.screenshot.token || pending.filename !== filename) {
      return withoutPicture("the captured picture was replaced before this note was saved.");
    }
    pendingScreenshot = null;
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
    const status = await captureRequest("hd_capture_job_status", { jobId: request.captureJobId });
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
      warnings: Array.isArray(status.warnings)
        ? status.warnings.filter(value => typeof value === "string").map(value => value.slice(0, 500)) : [],
    };
  }

  async function completeCapture({ writeResources }) {
    const jobId = writeResources?.captureJobId;
    if (!jobId) return;
    await captureRequest("hd_capture_complete", { jobId });
    for (const key of confirmedCaptureUploads.keys()) {
      if (key.startsWith(`${jobId}:`)) confirmedCaptureUploads.delete(key);
    }
  }

  async function beforeMutation({ request, writeResources }) {
    await currentGeneration(request);
    if (!writeResources?.captureJobId) return;
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
    afterConfirmed: completeCapture,
    afterRejected: releaseScreenshot,
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
    const data = typeof dataUrl === "string" && dataUrl.startsWith("data:image/")
      ? dataUrl.slice(dataUrl.indexOf(",") + 1) : "";
    if (decodedBase64Length(data) === null) throw new Error("This page produced no screenshot.");
    pendingScreenshot = { token, filename: `hachidori-screenshot-${crypto.randomUUID()}.jpg`, data };
    return { token: pendingScreenshot.token, filename: pendingScreenshot.filename };
  }

  // An abandoned or definitively rejected submission releases only its own
  // pending bytes; uploaded media has a separate write-outcome cleanup path.
  function discardScreenshot(request) {
    if (pendingScreenshot !== null && pendingScreenshot.token === request?.token) pendingScreenshot = null;
    return { discarded: true };
  }

  async function submit(request) {
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

  return { ...mining, submit, screenshot, discardScreenshot, async maturity(request) {
    try {
      const options = await readOptions();
      return { mature: options.definitionBlurAnkiMature === true
        && await maturityCache.has(options.anki, request?.term?.expression) };
    } catch {
      // Missing local evidence never prevents dictionary lookup.
      return { mature: false };
    }
  } };
}
