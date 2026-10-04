// SPDX-License-Identifier: GPL-3.0-or-later
// Base64 for media, captured audio and screenshots. Uint8Array.prototype.toBase64
// and Uint8Array.fromBase64 (Chrome 143+) are used when present; the portable
// paths below give identical results on older Chrome and in Node.

const ALPHABET = new TextEncoder().encode("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/");
const PAD = 0x3d; // "="
const ASCII = new TextDecoder();

export function encodeBase64(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (typeof bytes.toBase64 === "function") {
    try {
      return bytes.toBase64();
    } catch {
      // Fall through to the portable path.
    }
  }
  // Encode RFC 4648 directly into ASCII bytes rather than through a per-byte
  // binary string for btoa; on Chrome 128 this is about twice as fast.
  const output = new Uint8Array(Math.ceil(bytes.length / 3) * 4);
  let at = 0;
  for (let index = 0; index < bytes.length; index += 3) {
    const remaining = bytes.length - index;
    const group = (bytes[index] << 16)
      | (remaining > 1 ? bytes[index + 1] << 8 : 0)
      | (remaining > 2 ? bytes[index + 2] : 0);
    output[at] = ALPHABET[group >> 18];
    output[at + 1] = ALPHABET[(group >> 12) & 63];
    output[at + 2] = remaining > 1 ? ALPHABET[(group >> 6) & 63] : PAD;
    output[at + 3] = remaining > 2 ? ALPHABET[group & 63] : PAD;
    at += 4;
  }
  return ASCII.decode(output);
}

export function decodeBase64(text, { atob: fromAscii = globalThis.atob } = {}) {
  if (typeof Uint8Array.fromBase64 === "function") {
    try {
      return Uint8Array.fromBase64(text);
    } catch {
      // Let the portable path produce its own result or error.
    }
  }
  // atob returns one code unit from 0 to 255 per byte, so no index starts a
  // surrogate pair and codePointAt reads exactly that byte.
  const binary = fromAscii(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.codePointAt(index);
  }
  return bytes;
}
