/*
 * The dictionary state and kanji-group replies as the reader reads them, for
 * content.js: the stored dictionaryState reduced to the fields the reader
 * uses, comparisons of dictionary lists, and a clicked kanji's results from
 * the members of a dictionary group, merged in group order.
 *
 * Copyright (C) 2026 Manhhao
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

(function () {
  "use strict";

  const { normaliseDictionaryGroups } = globalThis.HDDictionaryGroups;

  function nonnegativeCount(value) {
    const count = Math.trunc(Number(value));
    return Number.isFinite(count) && count > 0 ? count : 0;
  }

  function normalizeDictionaryState(stored) {
    const state = stored && typeof stored === "object" ? stored : {};
    const rows = Array.isArray(state.dictionaries) ? state.dictionaries : [];
    const normalized = rows.flatMap((entry) => {
      const title = typeof entry?.title === "string" ? entry.title : "";
      if (!title) {
        return [];
      }
      return [{
        id: typeof entry.id === "string" ? entry.id : "",
        title,
        displayName: typeof entry.displayName === "string" && entry.displayName.trim() !== ""
          ? entry.displayName.trim()
          : null,
        path: typeof entry.path === "string" ? entry.path : "",
        revision: typeof entry.revision === "string" ? entry.revision : "",
        enabled: entry.enabled !== false,
        favorite: entry.favorite === true,
        termCount: nonnegativeCount(entry.termCount),
        frequencyCount: nonnegativeCount(entry.frequencyCount),
        frequencyMode: entry.frequencyMode,
        pitchCount: nonnegativeCount(entry.pitchCount),
        kanjiCount: nonnegativeCount(entry.kanjiCount),
        longKeyLength: nonnegativeCount(entry.longKeyLength),
      }];
    });
    return {
      revision: Number.isInteger(state.revision) && state.revision >= 0 ? state.revision : 0,
      dictionaries: normalized,
      groups: normaliseDictionaryGroups(state.groups, normalized),
    };
  }

  function sameDictionaries(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  function sameDictionaryContents(left, right) {
    const contents = (entries) => entries.map(({ displayName, favorite, frequencyMode, ...dictionary }) => dictionary);
    return left === right || sameDictionaries(contents(left), contents(right));
  }

  function projectResultsToDictionary(results, title) {
    const projected = [];
    for (const result of results) {
      const glossaries = Array.isArray(result?.term?.glossaries)
        ? result.term.glossaries.filter((glossary) => glossary && glossary.dictionary === title)
        : [];
      if (glossaries.length > 0) {
        projected.push({
          ...result,
          term: { ...result.term, glossaries },
        });
      }
    }
    return projected;
  }

  function nativeKanjiEntries(reply) {
    const entries = Array.isArray(reply?.kanji?.entries) ? reply.kanji.entries : [];
    return entries.filter((entry) => entry && typeof entry === "object"
      && typeof entry.dictionary === "string" && entry.dictionary !== "");
  }

  // A group's members answer in group order. Entries sharing an expression and
  // reading merge their cards, as the engine does for an ordinary lookup, and a
  // native kanji entry becomes one structured card of its member.
  function mergeKanjiGroupResults(members, character, kanjiReply, termReplies) {
    const merged = [];
    const append = (result) => {
      const existing = merged.find((entry) => entry.term.expression === result.term.expression
        && entry.term.reading === result.term.reading);
      if (existing) existing.term.glossaries.push(...result.term.glossaries);
      else merged.push({ ...result, term: { ...result.term, glossaries: [...result.term.glossaries] } });
    };
    const nativeEntries = nativeKanjiEntries(kanjiReply);
    let termIndex = 0;
    for (const member of members) {
      if (member.kind === "term") {
        const reply = termReplies[termIndex++];
        for (const result of projectResultsToDictionary(Array.isArray(reply.results) ? reply.results : [], member.title)) {
          append(result);
        }
        continue;
      }
      for (const entry of nativeEntries.filter((candidate) => candidate.dictionary === member.title)) {
        append(window.HDPopup.kanjiEntryResult(character, entry));
      }
    }
    return merged;
  }

  globalThis.HDContent = {
    ...globalThis.HDContent, mergeKanjiGroupResults, nativeKanjiEntries, normalizeDictionaryState,
    projectResultsToDictionary, sameDictionaries, sameDictionaryContents,
  };
}());
