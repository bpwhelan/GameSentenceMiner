// SPDX-License-Identifier: GPL-3.0-or-later
import { MAX_ANIMATED_AVIF_BYTES } from "./avif-sequence.js";
import { MAX_WAV_BYTES } from "./capture-buffer.js";

export const MAX_LINKED_SCREENSHOT_BYTES = 6 * 1024 * 1024;
export const MAX_LINKED_SPEECH_BYTES = MAX_WAV_BYTES;
export const CAPTURE_FILENAMES = Object.freeze({
  animation: /^hachidori-[a-z0-9]+\.avif$/u,
  audio: /^hachidori-[a-z0-9]+\.wav$/u,
});
export const CAPTURE_LIMITS = Object.freeze({
  animation: MAX_ANIMATED_AVIF_BYTES,
  audio: MAX_WAV_BYTES,
});
const SCREENSHOT_FILENAME = /^hachidori-screenshot-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jpg$/u;
const SPEECH_FILENAME = /^hachidori_[0-9a-f]{64}\.wav$/u;
const CLIENT_MEDIA_FIELDS = new Set(["screenshot", "capture", "speech"]);
const SCREENSHOT_FIELDS = new Set(["token", "filename", "data"]);
const CAPTURE_FIELDS = new Set(["jobId", "warnings", "assets"]);
const ASSET_FIELDS = new Set(["filename", "byteLength", "data"]);
const SPEECH_PLAN_FIELDS = new Set(["sourceId", "sourceKey", "expression", "reading"]);
const SPEECH_FIELDS = new Set([...SPEECH_PLAN_FIELDS, "filename", "byteLength", "data"]);
const CAPTURE_KINDS = ["animation", "audio"];

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactFields(value, allowed, label) {
  if (!record(value) || Object.keys(value).some(key => !allowed.has(key))) {
    throw new Error(`The linked ${label} payload is invalid.`);
  }
}

export function decodedBase64Length(value) {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0
      || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) return null;
  if (value.endsWith("==")) return value.length / 4 * 3 - 2;
  return value.length / 4 * 3 - Number(value.endsWith("="));
}

function unavailable(request, kind) {
  return Array.isArray(request?.captureUnavailable) && request.captureUnavailable.includes(kind);
}

function validateScreenshot(request, value) {
  exactFields(value, SCREENSHOT_FIELDS, "screenshot");
  const expected = request?.screenshot;
  const byteLength = decodedBase64Length(value.data);
  if (!record(expected) || unavailable(request, "screenshot")
      || typeof value.token !== "string" || value.token === "" || value.token.length > 256
      || value.token !== expected.token || value.filename !== expected.filename
      || !SCREENSHOT_FILENAME.test(value.filename)
      || byteLength === null || !value.data.startsWith("/9j/")
      || byteLength > MAX_LINKED_SCREENSHOT_BYTES) {
    throw new Error("The linked screenshot payload is invalid, stale, or exceeds its size limit.");
  }
  return { token: value.token, filename: value.filename, data: value.data };
}

function validateAsset(request, kind, value) {
  exactFields(value, ASSET_FIELDS, `captured ${kind}`);
  const expectedFilename = request?.capturePin?.[kind === "animation" ? "animationFilename" : "audioFilename"];
  const byteLength = decodedBase64Length(value.data);
  if (typeof expectedFilename !== "string" || value.filename !== expectedFilename
      || !CAPTURE_FILENAMES[kind].test(value.filename)
      || !Number.isSafeInteger(value.byteLength) || value.byteLength < 1
      || value.byteLength > CAPTURE_LIMITS[kind]
      || byteLength === null || byteLength !== value.byteLength) {
    throw new Error(`The linked captured ${kind} payload is invalid, stale, or exceeds its size limit.`);
  }
  return { filename: value.filename, byteLength: value.byteLength, data: value.data };
}

function validateCapture(request, value) {
  exactFields(value, CAPTURE_FIELDS, "captured-media");
  if (typeof request?.captureJobId !== "string" || request.captureJobId === ""
      || request.captureJobId.length > 256 || value.jobId !== request.captureJobId
      || !Array.isArray(value.warnings) || value.warnings.length > 64
      || value.warnings.some(warning => typeof warning !== "string" || warning.length > 500)
      || !record(value.assets) || Object.keys(value.assets).some(kind => !CAPTURE_KINDS.includes(kind))) {
    throw new Error("The linked captured-media payload is invalid or stale.");
  }
  const assets = {};
  for (const kind of CAPTURE_KINDS) {
    if (value.assets[kind] !== undefined) assets[kind] = validateAsset(request, kind, value.assets[kind]);
  }
  return { jobId: value.jobId, warnings: [...value.warnings], assets };
}

function validateSpeechPlan(value, label = "browser-speech plan") {
  exactFields(value, SPEECH_PLAN_FIELDS, label);
  if (typeof value.sourceId !== "string" || value.sourceId === "" || value.sourceId.length > 256
      || typeof value.sourceKey !== "string" || value.sourceKey === "" || value.sourceKey.length > 16_384
      || typeof value.expression !== "string" || value.expression === "" || value.expression.length > 4096
      || typeof value.reading !== "string" || value.reading.length > 4096) {
    throw new Error(`The linked ${label} is invalid.`);
  }
  return {
    sourceId: value.sourceId,
    sourceKey: value.sourceKey,
    expression: value.expression,
    reading: value.reading,
  };
}

function validateSpeech(request, value) {
  exactFields(value, SPEECH_FIELDS, "browser-speech payload");
  const expected = validateSpeechPlan(request?.clientSpeech);
  const actual = validateSpeechPlan(Object.fromEntries(
    [...SPEECH_PLAN_FIELDS].map(field => [field, value[field]]),
  ), "browser-speech identity");
  const byteLength = decodedBase64Length(value.data);
  if (Object.keys(expected).some(field => actual[field] !== expected[field])
      || !SPEECH_FILENAME.test(value.filename)
      || !Number.isSafeInteger(value.byteLength) || value.byteLength < 1
      || value.byteLength > MAX_LINKED_SPEECH_BYTES
      || byteLength === null || byteLength !== value.byteLength
      || !value.data.startsWith("UklG")) {
    throw new Error("The linked browser-speech payload is invalid, stale, or exceeds its size limit.");
  }
  return { ...actual, filename: value.filename, byteLength: value.byteLength, data: value.data };
}

// Returns a new allowlisted envelope so the host never retains caller-owned
// objects or unrecognised fields after validating the cross-browser boundary.
export function validateLinkedAnkiClientMedia(request, value) {
  exactFields(value, CLIENT_MEDIA_FIELDS, "client-media envelope");
  const expectsScreenshot = record(request?.screenshot) && !unavailable(request, "screenshot");
  const expectsCapture = typeof request?.captureJobId === "string" && request.captureJobId !== "";
  const expectsSpeech = record(request?.clientSpeech);
  if (expectsScreenshot !== (value.screenshot !== undefined)
      || expectsCapture !== (value.capture !== undefined)
      || expectsSpeech !== (value.speech !== undefined)) {
    throw new Error("The linked client-media envelope is missing media for this mining request.");
  }
  return {
    ...(value.screenshot === undefined ? {} : { screenshot: validateScreenshot(request, value.screenshot) }),
    ...(value.capture === undefined ? {} : { capture: validateCapture(request, value.capture) }),
    ...(value.speech === undefined ? {} : { speech: validateSpeech(request, value.speech) }),
  };
}
