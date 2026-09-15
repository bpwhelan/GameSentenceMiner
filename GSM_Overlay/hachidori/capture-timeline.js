// SPDX-License-Identifier: GPL-3.0-or-later

export const CAPTURE_RECORD_LIMIT = 1000;
export const CAPTURE_TEXT_LIMIT = 4096;
const TIMED_SOURCES = new Set(["texthooker", "cue", "dom"]);

export function normaliseCaptureText(value) {
  if (typeof value !== "string") return "";
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function finiteTime(value, label) {
  if (!Number.isFinite(value)) throw new Error(`${label} must be a finite timeline value`);
  return value;
}

function recordKey(record) {
  return `${record.sourceKind}\0${record.sourceId}\0${record.sourceEpoch}\0${record.occurrenceId}`;
}

export function createCaptureTimeline({ limit = CAPTURE_RECORD_LIMIT, textLimit = CAPTURE_TEXT_LIMIT } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(textLimit) || textLimit < 1) {
    throw new Error("capture timeline limits must be positive integers");
  }
  const records = [];
  const current = new Map();

  function begin(value) {
    if (!TIMED_SOURCES.has(value?.sourceKind)
        || typeof value.sourceId !== "string" || !value.sourceId
        || typeof value.sourceEpoch !== "string" || !value.sourceEpoch
        || typeof value.occurrenceId !== "string" || !value.occurrenceId) {
      throw new Error("capture timeline record identity is incomplete");
    }
    if (typeof value.text !== "string" || value.text.length > textLimit) {
      throw new Error(`capture timeline text must be at most ${textLimit} characters`);
    }
    const text = normaliseCaptureText(value.text);
    if (!text) throw new Error("capture timeline text is empty");
    const startMs = finiteTime(value.startMs, "capture start");
    const candidate = {
      sourceKind: value.sourceKind,
      sourceId: value.sourceId,
      sourceEpoch: value.sourceEpoch,
      occurrenceId: value.occurrenceId,
      text: value.text,
      normalizedText: text,
      startMs,
      endMs: null,
      onsetKnown: value.onsetKnown !== false,
    };
    const key = recordKey(candidate);
    const existing = current.get(key);
    if (existing) {
      existing.text = candidate.text;
      existing.normalizedText = candidate.normalizedText;
      existing.onsetKnown = existing.onsetKnown && candidate.onsetKnown;
      return { ...existing };
    }
    records.push(candidate);
    current.set(key, candidate);
    while (records.length > limit) {
      const removed = records.shift();
      if (current.get(recordKey(removed)) === removed) current.delete(recordKey(removed));
    }
    return { ...candidate };
  }

  function close(identity, endMs) {
    const key = recordKey(identity);
    const record = current.get(key);
    if (!record) return null;
    const end = finiteTime(endMs, "capture end");
    if (end < record.startMs) throw new Error("capture end precedes its start");
    record.endMs = end;
    current.delete(key);
    return { ...record };
  }

  function closeSource(sourceKind, sourceId, sourceEpoch, endMs) {
    const closed = [];
    for (const record of current.values()) {
      if (record.sourceKind !== sourceKind || record.sourceId !== sourceId
          || (sourceEpoch !== undefined && record.sourceEpoch !== sourceEpoch)) continue;
      const result = close(record, endMs);
      if (result) closed.push(result);
    }
    return closed;
  }

  function reset() {
    records.length = 0;
    current.clear();
  }

  return {
    begin,
    close,
    closeSource,
    reset,
    snapshot: () => records.map(record => ({ ...record })),
  };
}

function temporalMatches(record, lookupTimeMs) {
  return record.startMs <= lookupTimeMs && (record.endMs == null || lookupTimeMs <= record.endMs);
}

function matchingRecord(records, sourceKind, lookupText, occurrenceId, occurrenceSourceKind, lookupTimeMs,
  texthookerSource) {
  const normalized = normaliseCaptureText(lookupText);
  const matches = records.filter(record => record.sourceKind === sourceKind
    && record.onsetKnown !== false
    && (sourceKind === "texthooker"
      ? record.sourceId === texthookerSource?.sourceId && record.sourceEpoch === texthookerSource?.sourceEpoch
        && record.startMs <= lookupTimeMs
      : temporalMatches(record, lookupTimeMs))
    && (occurrenceId && occurrenceSourceKind === sourceKind ? record.occurrenceId === occurrenceId
      : (record.normalizedText ?? normaliseCaptureText(record.text)) === normalized));
  return matches.length === 1 ? matches[0] : null;
}

function timedInterval(record, lookupTimeMs, clipMs, offsetMs) {
  const startMs = record.startMs + offsetMs;
  const naturalEnd = record.endMs == null ? startMs + clipMs : record.endMs + offsetMs;
  return {
    startMs,
    endMs: Math.min(naturalEnd, startMs + clipMs),
    pendingTail: record.endMs == null && lookupTimeMs < naturalEnd,
  };
}

/**
 * Resolve one lookup to exactly one source interval. `availableStartMs` is the
 * oldest retained recorder timestamp and may shorten only the recent fallback.
 */
export function resolveCaptureInterval({
  records,
  lookupText,
  occurrenceId = "",
  occurrenceSourceKind = "",
  lookupTimeMs,
  availableStartMs,
  timingMode = "auto",
  clipSeconds = 10,
  estimatedOffsetMs = -500,
  texthookerActive = false,
  texthookerSource = null,
}) {
  finiteTime(lookupTimeMs, "lookup time");
  finiteTime(availableStartMs, "available capture start");
  const clipMs = clipSeconds * 1000;
  if (![5000, 10000].includes(clipMs)) throw new Error("capture clip length is invalid");
  let priorities = [];
  if (timingMode !== "recent") {
    priorities = ["cue", "dom"];
    if (timingMode !== "page" && texthookerActive) priorities.unshift("texthooker");
  }
  const labels = {
    texthooker: "Texthooker estimate",
    cue: "Video cue",
    dom: "Page-text estimate",
  };
  for (const kind of priorities) {
    const record = matchingRecord(records, kind, lookupText, occurrenceId, occurrenceSourceKind, lookupTimeMs,
      texthookerSource);
    if (!record) continue;
    const interval = timedInterval(record, lookupTimeMs, clipMs, kind === "cue" ? 0 : estimatedOffsetMs);
    if (interval.startMs < availableStartMs || interval.endMs <= interval.startMs) continue;
    return {
      ...interval,
      sourceKind: kind,
      sourceLabel: labels[kind],
      sourceId: record.sourceId,
      sourceEpoch: record.sourceEpoch,
      occurrenceId: record.occurrenceId,
    };
  }
  const startMs = Math.max(availableStartMs, lookupTimeMs - clipMs);
  if (lookupTimeMs <= startMs) return null;
  return {
    sourceKind: "recent",
    sourceLabel: "Recent clip",
    sourceId: "",
    sourceEpoch: "",
    occurrenceId: "",
    startMs,
    endMs: lookupTimeMs,
    pendingTail: false,
    partial: startMs > lookupTimeMs - clipMs,
  };
}
