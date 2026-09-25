// Canonical persistent lookup rows, shared by the storage owner and backup validator.
// SPDX-License-Identifier: GPL-3.0-or-later
import "./lookup-stats-identity.js";
export const { normaliseLookupTerm, lookupStatsPrefix, lookupStatsKey } = globalThis.HDLookupStats;
export const LOOKUP_STATS_KEY = "lookupStats";
export const LOOKUP_STATS_ROW_PREFIX = "lookupStats:";

export function emptyLookupStats() {
  return { generation: null, revision: 0 };
}

export function assertLookupStatsDescriptor(descriptor) {
  if (!descriptor || !Number.isSafeInteger(descriptor.revision) || descriptor.revision < 0
      || (descriptor.generation !== null && (typeof descriptor.generation !== "string" || descriptor.generation === ""))) {
    throw new Error("Invalid lookup statistics descriptor.");
  }
}

function assertLookupStatsRow(row) {
  if (!row || typeof row.term !== "string" || row.term.trim() === "" || typeof row.reading !== "string"
      || !Number.isSafeInteger(row.lookupCount) || row.lookupCount < 0
      || !Number.isFinite(row.firstLookedUpAt) || !Number.isFinite(row.lastLookedUpAt)
      || row.firstLookedUpAt > row.lastLookedUpAt) {
    throw new Error("Invalid lookup statistics row.");
  }
  const canonical = normaliseLookupTerm(row.term, row.reading);
  if (row.term !== canonical.term || row.reading !== canonical.reading) {
    throw new Error("The lookup statistics row is not canonical.");
  }
}

export function assertLookupStatsRows(descriptor, rows) {
  assertLookupStatsDescriptor(descriptor);
  if (!Array.isArray(rows) || (descriptor.generation === null && rows.length !== 0)) {
    throw new Error("Invalid lookup statistics collection.");
  }
  const keys = new Set();
  for (const row of rows) {
    assertLookupStatsRow(row);
    const key = lookupStatsKey(descriptor, row);
    if (keys.has(key)) throw new Error("Duplicate lookup statistics rows.");
    keys.add(key);
  }
}

export function incrementLookupStats(previous, term, now) {
  if (previous !== undefined) {
    assertLookupStatsRow(previous);
    if (previous.term !== term.term || previous.reading !== term.reading) {
      throw new Error("The lookup statistics row does not match its key.");
    }
  }
  const row = { ...term, lookupCount: (previous?.lookupCount ?? 0) + 1,
    firstLookedUpAt: Math.min(previous?.firstLookedUpAt ?? now, now),
    lastLookedUpAt: Math.max(previous?.lastLookedUpAt ?? now, now) };
  // Safe integers are the persisted JSON representation, not a product cap.
  assertLookupStatsRow(row);
  return row;
}
