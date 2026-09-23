// Applies the saved Settings theme before the first paint.
//
// settings.js reads the same options later and stays authoritative through
// applyPageTheme(); this only closes the window between the first paint and
// that read, during which the page followed the browser's colour preference
// (#296). A classic script in <head> starts the read before the body exists;
// the extension CSP forbids inline scripts. reader-options.js is loaded just
// before it so the theme resolves exactly as settings.js resolves it.
// SPDX-License-Identifier: GPL-3.0-or-later
(function () {
  const root = document.documentElement;
  // settings.css hides the interface and its themed background while this is set.
  root.dataset.hoshidictsThemePending = "";
  const api = globalThis.browser ?? globalThis.chrome;
  // A failed read releases the page to the browser preference, as before; the
  // settings.js read reports the failure.
  const release = () => { delete root.dataset.hoshidictsThemePending; };
  api.storage.local.get("options").then(({ options }) => {
    let theme = globalThis.HDReaderOptions.normaliseOptions(options).popupTheme;
    if (theme === "auto") theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    root.dataset.hoshidictsTheme = theme;
  }).then(release, release);
}());
