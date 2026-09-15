// SPDX-License-Identifier: GPL-3.0-or-later

const MAX_LOOKUP_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_MEDIA_RESPONSE_BYTES = 6 * 1024 * 1024;
// Browser adaptation of the source's 1 MiB control frame, only for reader
// options messages. Dictionary state, custom source, and archives are separate.
const MAX_OPTIONS_FRAME_BYTES = 1024 * 1024;
const BOUNDED_REQUESTS = new Set([
  "hd_lookup",
  "hd_lookup_dictionary",
  "hd_kanji",
  "hd_media",
  "hd_capture_asset",
  "hd_options_write",
]);
const responseFrameEncoder = new TextEncoder();

export function isBoundedRequest(type) {
  return BOUNDED_REQUESTS.has(type);
}

export function responseLimitError(type) {
  if (type === "hd_options_write" || type === "hd_options_write_result") {
    return "reader options message exceeds the 1 MiB serialized limit";
  }
  return ["hd_media", "hd_media_result", "hd_capture_asset", "hd_capture_asset_result"].includes(type)
    ? "media response exceeds the 6 MiB serialized limit"
    : "lookup response exceeds the 32 MiB serialized limit";
}

export function validResponseRequestId(value) {
  return value === null || typeof value === "string" || Number.isFinite(value);
}

export function responseFits(reply, nativeJsonLength = 0) {
  if (reply.type === "hd_options_write" || reply.type === "hd_options_write_result") {
    const json = JSON.stringify(reply);
    // UTF-8 cannot be shorter than JSON's UTF-16 code-unit count.
    if (json.length > MAX_OPTIONS_FRAME_BYTES) return false;
    return json.length * 3 <= MAX_OPTIONS_FRAME_BYTES
      || responseFrameEncoder.encode(json).byteLength <= MAX_OPTIONS_FRAME_BYTES;
  }
  if (reply.type === "hd_media_result" || reply.type === "hd_capture_asset_result") {
    // The producer constructs dataUrl only from fixed ASCII MIME strings and
    // base64. Count that payload exactly without serializing/copying it again.
    const field = reply.type === "hd_media_result" ? "dataUrl" : "data";
    const dataLength = typeof reply[field] === "string" ? reply[field].length : 0;
    const frame = JSON.stringify(dataLength ? { ...reply, [field]: "" } : reply);
    return frame.length * 3 + dataLength <= MAX_MEDIA_RESPONSE_BYTES
      || responseFrameEncoder.encode(frame).byteLength + dataLength <= MAX_MEDIA_RESPONSE_BYTES;
  }
  // Extra empty endpoint fields only enlarge this conservative envelope; near
  // the boundary we always measure the actual reply instead.
  const envelope = nativeJsonLength === 0 ? reply : { ...reply, results: [], kanji: null };
  const envelopeJson = JSON.stringify(envelope);
  // JSON escaping needs at most six bytes per UTF-16 code unit, including
  // lone surrogates. Ordinary native replies need no second full traversal.
  if ((nativeJsonLength + envelopeJson.length) * 6 <= MAX_LOOKUP_RESPONSE_BYTES) return true;
  const json = nativeJsonLength === 0 ? envelopeJson : JSON.stringify(reply);
  return responseFrameEncoder.encode(json).byteLength <= MAX_LOOKUP_RESPONSE_BYTES;
}

export function boundResponseFailure(reply) {
  if (!isBoundedRequest(reply.type.replace(/_result$/u, ""))) return reply;
  if (!validResponseRequestId(reply.requestId)) reply.requestId = null;
  if (!responseFits(reply)) {
    const limitError = responseLimitError(reply.type);
    const unchangedError = reply.error === limitError;
    reply.error = limitError;
    // Replacing an identical error cannot make the same oversized frame fit.
    if (unchangedError || !responseFits(reply)) reply.requestId = null;
  }
  return reply;
}
