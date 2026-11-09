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
  const api = globalThis.chrome;
  // A failed read releases the page to the browser preference, as before; the
  // settings.js read reports the failure.
  const release = () => { delete root.dataset.hoshidictsThemePending; };
  const reader = globalThis.HDReaderOptions;
  api.storage.local.get(["options", reader.LANGUAGE_SELECTION_KEY]).then(stored => {
    const { options } = stored;
    // With profiles, the theme of the profile the page shows: the one the
    // address names while Multiple languages is on, else this browser's
    // active one (docs/languages.md 5.3, 16.3).
    let flat = reader.normaliseOptions(options);
    if (reader.hasProfiles(options)) {
      const named = reader.languagesEnabled(options) ? new URLSearchParams(location.search).get("profile") : null;
      const id = reader.profiles(options).some(profile => profile.id === named)
        ? named : reader.activeProfileId(options, stored[reader.LANGUAGE_SELECTION_KEY]);
      flat = reader.projectOptions(options, id);
    }
    let theme = flat.popupTheme;
    if (theme === "auto") theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    if (globalThis.HDReaderOptions.popupRenderer(theme) !== "default") theme = "default";
    root.dataset.hoshidictsTheme = theme;
  }).then(release, release);
}());
