// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Copyright (C) 2023-2026  Yomitan Authors
 * Copyright (C) 2021-2022  Yomichan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

// Adapted from Manabitan's SortFrequencyDictionaryController. Settings handles
// declared modes synchronously; sample undeclared dictionaries on demand.
const COMMON_TERMS = ["来る", "言う", "出る", "入る", "方", "男", "女", "今", "何", "時"];
const LESS_COMMON_TERMS = ["行なう", "論じる", "過す", "行方", "人口", "猫", "犬", "滝", "理", "暁"];

// Another language samples with its pack's `host.frequencySamples`
// ({ common, rare }) and reports no direction without them
// (docs/languages.md 9.4); Japanese keeps the twenty words above.
// The range of a dictionary's frequency values for a term in a lookup reply,
// or null when it has none.
function sampleRange(reply, term, title) {
  const values = reply.results.flatMap(result => result.term.expression === term
    ? result.term.frequencies.filter(group => group.dictionary === title)
      .flatMap(group => group.frequencies.map(frequency => frequency.value)).filter(Number.isFinite)
    : []);
  if (!values.length) return null;
  let min = Infinity, max = -Infinity;
  for (const value of values) { min = Math.min(min, value); max = Math.max(max, value); }
  return { min, max };
}

// Positive when common terms have larger values than rare ones (descending).
function directionScore(commonSamples, rareSamples) {
  let score = 0;
  for (const common of commonSamples) {
    for (const rare of rareSamples) score += Math.sign(common.max - rare.min) + Math.sign(common.min - rare.max);
  }
  return score;
}

export async function inferFrequencyDirection(dictionary, lookup, { language = "ja", samples } = {}) {
  if (dictionary.language && dictionary.language !== language) return null;
  const commonTerms = language === "ja" && samples === undefined ? COMMON_TERMS : samples?.common;
  const rareTerms = language === "ja" && samples === undefined ? LESS_COMMON_TERMS : samples?.rare;
  if (!Array.isArray(commonTerms) || !Array.isArray(rareTerms)) return null;

  const samplesFound = [];
  for (const term of [...commonTerms, ...rareTerms]) {
    const reply = await lookup(term); // NOSONAR: one engine turn at a time lets obsolete sampling stop and releases each glossary reply before the next.
    samplesFound.push(sampleRange(reply, term, dictionary.title));
  }
  const score = directionScore(samplesFound.slice(0, commonTerms.length).filter(sample => sample !== null),
    samplesFound.slice(commonTerms.length).filter(sample => sample !== null));
  if (score < 0) return "ascending";
  if (score > 0) return "descending";
  return null;
}
