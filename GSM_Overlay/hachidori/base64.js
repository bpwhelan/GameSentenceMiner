// SPDX-License-Identifier: GPL-3.0-or-later
// Base64 for media, captured audio and screenshots. Uint8Array.prototype.toBase64
// and Uint8Array.fromBase64 (Chrome 143+, Firefox 133+) do in about 0.5 ms per
// megabyte what the String.fromCodePoint/btoa and atob/Uint8Array.from loops
// take 40–55 ms for, with identical results; both remain as the fallback.

const CHUNK = 0x8000;

export function encodeBase64(data, { btoa: toAscii = globalThis.btoa } = {}) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (typeof bytes.toBase64 === "function") {
    try {
      return bytes.toBase64();
    } catch {
      // Fall through to the portable path.
    }
  }
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + CHUNK));
  }
  return toAscii(binary);
}

export function decodeBase64(text, { atob: fromAscii = globalThis.atob } = {}) {
  if (typeof Uint8Array.fromBase64 === "function") {
    try {
      return Uint8Array.fromBase64(text);
    } catch {
      // Let the portable path produce its own result or error.
    }
  }
  const binary = fromAscii(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
