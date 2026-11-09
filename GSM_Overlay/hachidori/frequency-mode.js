// SPDX-License-Identifier: GPL-3.0-or-later

import { TextWriter, Uint8ArrayReader, ZipReader } from "./vendor/zip.js";

const META_BANK = /^(?:term|kanji)_meta_bank_\d+\.json$/u;

// A freq row's number in each Yomitan shape: n, {value} or either under
// {reading, frequency}.
function frequencyValue(data) {
  const frequency = data !== null && typeof data === "object" && "frequency" in data ? data.frequency : data;
  const value = frequency !== null && typeof frequency === "object" ? frequency.value : frequency;
  return Number.isFinite(value) ? value : null;
}

// Some generated lists declare `occurrence-based` but hold ranks (#684). In
// an occurrence count, words seen once are a large share of the list (Zipf's
// law); in a rank list only the top word, with its few readings, has 1. So a
// list whose smallest value is 1, held by at most 1% of its freq rows, is
// read as ranks.
export async function archiveHoldsRanks(bytes) {
  const reader = new ZipReader(new Uint8ArrayReader(bytes), { useWebWorkers: false });
  try {
    let rows = 0, ones = 0, smallest = Infinity;
    for (const entry of await reader.getEntries()) {
      if (entry.directory || !META_BANK.test(entry.filename)) continue;
      for (const row of JSON.parse(await entry.getData(new TextWriter(), { useWebWorkers: false }))) { // NOSONAR: banks are read one at a time, so one bank's JSON is in memory at once
        const value = row?.[1] === "freq" ? frequencyValue(row[2]) : null;
        if (value === null) continue;
        rows += 1;
        if (value === 1) ones += 1;
        smallest = Math.min(smallest, value);
      }
    }
    return smallest === 1 && ones * 100 <= rows;
  } finally {
    await reader.close();
  }
}
