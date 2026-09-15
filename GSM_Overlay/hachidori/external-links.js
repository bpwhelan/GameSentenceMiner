// SPDX-License-Identifier: GPL-3.0-or-later

// Shared by classic content scripts and the module service worker.
(function () {
  "use strict";

  function normaliseExternalUrl(value) {
    if (typeof value !== "string") return null;
    const source = value.trim();
    if (/[\u0000-\u001f\u007f]/u.test(source)) return null;
    try {
      const url = new URL(source);
      return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
        ? url.href : null;
    } catch {
      return null;
    }
  }

  // GSM popup links use %w for the word and %s for the sentence. Reading is
  // useful to dictionary providers too; encode each value before substitution.
  function expandCustomLinkUrl(template, { word = "", reading = "", sentence = "" } = {}) {
    if (typeof template !== "string") return null;
    const values = { w: word, r: reading, s: sentence };
    const expanded = template.replace(/%([wrs])/gu, (_, marker) => encodeURIComponent(String(values[marker])));
    return normaliseExternalUrl(expanded);
  }

  globalThis.HDExternalLinks = { normaliseExternalUrl, expandCustomLinkUrl };
})();
