// SPDX-License-Identifier: GPL-3.0-or-later
//
// Word status overrides (#520): the words marked as known or ignored from the
// popup's Mark as known and Ignore. An override wins over the word's Anki
// status in word highlighting, and no Anki note is involved. The service
// worker owns the stored record and changes one headword per write; the
// content script, backups and the sharing mirror read the same shape. A
// classic script, so the content script can use it; modules import it for its
// side effect.
//
// The record is { revision, known: [headword…], ignored: [headword…] }, each
// list in the order its words were set. Headwords are the engine's, as the
// popup shows them and as hd_segment returns them.
(function () {
  "use strict";

  const WORD_STATUS_OVERRIDES_KEY = "wordStatusOverrides";
  const OVERRIDE_STATUSES = ["known", "ignored"];

  function emptyWordStatusOverrides() {
    return { revision: 0, known: [], ignored: [] };
  }

  // A stored record with anything malformed dropped: a missing or malformed
  // record is empty, a malformed revision is 0, and a headword is kept once,
  // under the first status that lists it.
  function normaliseWordStatusOverrides(value) {
    const record = { revision: Number.isSafeInteger(value?.revision) && value.revision >= 0 ? value.revision : 0 };
    const seen = new Set();
    for (const status of OVERRIDE_STATUSES) {
      record[status] = (Array.isArray(value?.[status]) ? value[status] : []).filter(headword => {
        if (typeof headword !== "string" || headword === "" || seen.has(headword)) return false;
        seen.add(headword);
        return true;
      });
    }
    return record;
  }

  // Headword → status, for the reader.
  function wordStatusOverrideMap(value) {
    const record = normaliseWordStatusOverrides(value);
    return new Map(OVERRIDE_STATUSES.flatMap(status => record[status].map(headword => [headword, status])));
  }

  // A normalised record with `headword` set to `status`, or cleared with null,
  // at the next revision. The record itself when that is no change.
  function withWordStatusOverride(record, headword, status) {
    if (typeof headword !== "string" || headword === "") throw new TypeError("A word status override needs a headword.");
    if (status !== null && !OVERRIDE_STATUSES.includes(status)) {
      throw new TypeError("A word status override is known, ignored or null.");
    }
    const current = OVERRIDE_STATUSES.find(candidate => record[candidate].includes(headword)) ?? null;
    if (current === status) return record;
    const next = { revision: record.revision + 1 };
    for (const candidate of OVERRIDE_STATUSES) {
      next[candidate] = record[candidate].filter(word => word !== headword);
      if (candidate === status) next[candidate].push(headword);
    }
    return next;
  }

  globalThis.HDWordStatusOverrides = {
    WORD_STATUS_OVERRIDES_KEY, OVERRIDE_STATUSES,
    emptyWordStatusOverrides, normaliseWordStatusOverrides, wordStatusOverrideMap, withWordStatusOverride,
  };
}());
