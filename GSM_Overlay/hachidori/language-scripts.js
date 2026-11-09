// SPDX-License-Identifier: GPL-3.0-or-later
import { siteScriptSwitch } from "./site-scripts.js";

// The language layer (docs/languages.md 5): the registry's copy for content
// scripts and the display transforms, registered beside the manifest's
// content scripts in every frame while the records have profiles. A frame
// that was open when they gained profiles imports the same files itself
// (content.js).
export const LANGUAGE_SCRIPTS = Object.freeze([
  Object.freeze({
    id: "hachidori-language-layer",
    matches: ["<all_urls>"],
    js: ["vendor/languages/registry-reader.js", "language-text.js"],
    runAt: "document_idle",
    allFrames: true,
  }),
]);

export const applyLanguageScripts = siteScriptSwitch(LANGUAGE_SCRIPTS);
