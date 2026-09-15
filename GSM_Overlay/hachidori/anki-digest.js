// SPDX-License-Identifier: GPL-3.0-or-later
export async function ankiDigest(bytes) {
  const hash = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return [...hash].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
