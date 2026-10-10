// SPDX-License-Identifier: GPL-3.0-or-later

// A residency budget, never a limit on the packages or results we load.
// Chosen from the measured tradeoffs in docs/benchmarks/index-residency.md
// (Low memory mode) and docs/benchmarks/default-ram.md (normal mode).
export const RESIDENT_HASH_BUDGET_BYTES = 32 * 1024 * 1024;
export const DEFAULT_RESIDENT_HASH_BUDGET_BYTES = 65 * 1024 * 1024;

export function residentHashBudgetBytes(lowMemory) {
  return lowMemory ? RESIDENT_HASH_BUDGET_BYTES : DEFAULT_RESIDENT_HASH_BUDGET_BYTES;
}

// Code-unit order, so a plan never depends on the browser's locale.
function compareIds(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function planIndexStorage(dictionaries, storage, hashBytes, budget = RESIDENT_HASH_BUDGET_BYTES) {
  const paged = new Set();
  if (storage === "resident") return paged;
  const unique = new Map(dictionaries.filter(item => item.enabled !== false).map(item => [item.path, item]));
  const candidates = [...unique.values()].map(item => ({ id: item.id, path: item.path, bytes: hashBytes(item.path) }));
  candidates.sort((a, b) => a.bytes - b.bytes || compareIds(a.id, b.id));
  let remaining = storage === "paged" ? 0 : budget;
  for (const item of candidates) {
    if (storage !== "paged" && item.bytes <= remaining) remaining -= item.bytes;
    else paged.add(item.path);
  }
  return paged;
}

// Only threaded OPFS is measured. Automatic follows the default RAM preference;
// the other runtimes retain resident indexes, including explicit requests.
export function actualIndexPolicy(requested, storageBackend, lowMemory, useLessRamByDefault = true) {
  if (storageBackend !== "opfs") return "resident";
  if (requested !== "auto") return requested;
  return lowMemory || useLessRamByDefault ? "budget" : "resident";
}
