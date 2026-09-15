// SPDX-License-Identifier: GPL-3.0-or-later
// Shared retention policy for candidate metadata and offscreen-owned media.
// A value too large to retain is still usable by its caller, uncached.
export function createAudioCache({ maxEntries, maxBytes, ttlMs, onEvict, now = () => performance.now() }) {
  const entries = new Map();
  let retainedBytes = 0;

  function remove(key) {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    retainedBytes -= entry.bytes;
    onEvict?.(entry.value);
  }

  return {
    delete: remove,
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) { remove(key); return undefined; }
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    set(key, value, bytes) {
      remove(key);
      if (bytes > maxBytes) return false;
      entries.set(key, { value, bytes, expiresAt: now() + ttlMs });
      retainedBytes += bytes;
      while (entries.size > maxEntries || retainedBytes > maxBytes) remove(entries.keys().next().value);
      return true;
    },
    clear() { for (const key of entries.keys()) remove(key); },
  };
}
