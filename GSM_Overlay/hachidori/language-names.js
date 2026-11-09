/*
 * English names of languages for messages (docs/languages.md 17.6): the
 * pack's name, else the platform's name for a language this build has no pack
 * for. Shared by backups, the sharing host and client, and Settings → Sharing.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export function languageName(code) {
  const name = globalThis.HDLanguages?.get?.(code)?.name;
  if (typeof name === "string" && name !== "") return name;
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

// "Vietnamese", "Arabic and Vietnamese".
export function languageNames(codes) {
  return new Intl.ListFormat("en-GB", { type: "conjunction" }).format(codes.map(languageName));
}
