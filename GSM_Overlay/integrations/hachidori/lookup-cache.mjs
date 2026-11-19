// Cache native JSON, not mutable rendered entries. This runs inside the engine's
// serialized turn, after ensureLoaded(), so its generation is authoritative.
export function createLookupCache({maxEntries = 128, maxBytes = 8 * 1024 * 1024} = {}) {
  const entries = new Map();
  let revision, bytes = 0;
  return {
    get size() { return entries.size; },
    get bytes() { return bytes; },
    call(generation, engine, check, name, returnType, argumentTypes, args) {
      if (generation !== revision) { entries.clear(); bytes = 0; revision = generation; }
      const key = JSON.stringify([name, args]);
      const hit = entries.get(key);
      if (hit) { entries.delete(key); entries.set(key, hit); return hit.value; }
      const value = engine.ccall(name, returnType, argumentTypes, args);
      check(name); // Never retain a failed engine call.
      const size = (key.length + value.length) * 2;
      if (maxEntries > 0 && size <= maxBytes) {
        while (entries.size >= maxEntries || bytes + size > maxBytes) {
          const oldest = entries.keys().next().value;
          bytes -= entries.get(oldest).size; entries.delete(oldest);
        }
        entries.set(key, {value, size}); bytes += size;
      }
      return value;
    },
  };
}
