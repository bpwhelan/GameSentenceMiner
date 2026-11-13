// SPDX-License-Identifier: GPL-3.0-or-later

// The release these files belong to: always manifest.json's "version"
// (scripts/check-release.mjs). The service worker compares it with the
// manifest it was started for to notice that it is running a previous
// release's cached scripts (background.js).
export const BUILD_VERSION = "0.5.2";
