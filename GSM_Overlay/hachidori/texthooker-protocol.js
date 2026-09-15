// SPDX-License-Identifier: GPL-3.0-or-later

const IGNORED_PLAIN_MESSAGES = new Set(["True", "False"]);
export const MAX_TEXTHOOKER_FRAME_LENGTH = 64 * 1024;
export const MAX_TEXTHOOKER_TEXT_LENGTH = 4096;

export function parsePlainTexthookerMessage(value) {
  if (typeof value !== "string" || value.length > MAX_TEXTHOOKER_FRAME_LENGTH
      || !value.trim() || value.length > MAX_TEXTHOOKER_TEXT_LENGTH
      || IGNORED_PLAIN_MESSAGES.has(value.trim())) return null;
  try {
    JSON.parse(value);
    return null;
  } catch {
    return { type: "line", text: value };
  }
}

export function parseGsmTexthookerMessage(value) {
  if (typeof value === "string" && value.length > MAX_TEXTHOOKER_FRAME_LENGTH) return null;
  let payload;
  try {
    payload = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (["reset", "reset_checkboxes", "session_reset"].includes(payload.event)) return { type: "reset" };
  const data = payload.data;
  if (payload.event !== "text_received" || !data || typeof data !== "object" || Array.isArray(data)
      || typeof data.id !== "string" || !data.id
      || typeof data.session_id !== "string" || !data.session_id
      || data.history === true) return null;
  let text = payload.sentence;
  if (typeof text !== "string") text = typeof data.text === "string" ? data.text : "";
  if (!text.trim() || text.length > MAX_TEXTHOOKER_TEXT_LENGTH) return null;
  return {
    type: "line",
    id: data.id,
    sessionId: data.session_id,
    text,
  };
}

export function parseTexthookerMessage(format, value) {
  if (format === "plain") return parsePlainTexthookerMessage(value);
  if (format === "gsm") return parseGsmTexthookerMessage(value);
  throw new Error("unsupported texthooker format");
}
