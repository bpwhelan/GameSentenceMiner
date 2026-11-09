// The reader in an extension page that hosts it: first-run setup's practice
// step and the search page (#610). Content scripts never run in extension
// pages, so the page loads them itself, in the one authoritative order: the
// manifest's own content-script list, minus `reader-options.js`, which the
// page's module has already loaded. This includes new reader dependencies
// without a second static list. Each script carries `data-<marker>` so a test
// can find the ones a page loaded. It resolves with the reader's readiness
// API once the reader has adopted its first stored options and dictionaries.
// SPDX-License-Identifier: GPL-3.0-or-later

function loadScript(document, src, marker) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.dataset[marker] = "true";
    script.addEventListener("load", () => { resolve(); });
    script.addEventListener("error", () => { reject(new Error(`${src} could not be loaded`)); });
    document.head.appendChild(script);
  });
}

export function loadReaderScripts(document, api, marker) {
  const [injected] = api.runtime.getManifest().content_scripts ?? [];
  return (injected?.js ?? []).filter((src) => src !== "reader-options.js").reduce(
    (chain, src) => chain.then(() => loadScript(document, src, marker)), Promise.resolve(),
  ).then(() => globalThis.HDReaderReady);
}
