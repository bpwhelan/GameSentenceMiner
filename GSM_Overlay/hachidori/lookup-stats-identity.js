// Shared by native modules and manifest-loaded content scripts.
// SPDX-License-Identifier: GPL-3.0-or-later
(function () {
  "use strict";

  function normaliseLookupTerm(term, reading = "") {
    if (typeof term !== "string" || typeof reading !== "string" || term.trim() === "") {
      throw new TypeError("Lookup statistics require a nonempty term and a reading string.");
    }
    return { term: term.trim().normalize("NFC"), reading: reading.trim().normalize("NFC") };
  }

  function lookupStatsPrefix(descriptor) {
    return `lookupStats:${JSON.stringify(descriptor.generation)}:`;
  }

  function lookupStatsKey(descriptor, { term, reading }) {
    return lookupStatsPrefix(descriptor) + JSON.stringify([term, reading]);
  }

  globalThis.HDLookupStats = { normaliseLookupTerm, lookupStatsPrefix, lookupStatsKey };
}());
