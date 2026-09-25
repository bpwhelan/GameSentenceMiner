// SPDX-License-Identifier: GPL-3.0-or-later

// Yomitan's sentence boundaries, ported from its extractSentence
// (ext/js/dom/text-source-generator.js) with its default termination
// characters. Shared by the content script and its tests.
(function () {
  "use strict";

  // How far the sentence may reach back from the match; the whole window is
  // twice this, so room the backward walk does not use goes forward.
  const SENTENCE_SCAN_EXTENT = 200;

  // A terminator ends the sentence and belongs to it.
  const TERMINATORS = new Set(["。", "．", ".", "！", "!", "？", "?", "…", "︒", "︕", "︖", "︙"]);
  // A pair enclosing the match is left out of the sentence; a pair inside the
  // sentence is kept whole, terminators and all.
  const PAIRS = [
    ["「", "」"], ["『", "』"], ["（", "）"], ["(", ")"], ["［", "］"], ["[", "]"],
    ["｛", "｝"], ["{", "}"], ["〈", "〉"], ["《", "》"], ["【", "】"], ["〔", "〕"],
    ["〘", "〙"], ["〚", "〛"], ["“", "”"], ["‘", "’"],
  ];
  const CLOSER_OF = new Map(PAIRS);
  const OPENER_OF = new Map(PAIRS.map(([opener, closer]) => [closer, opener]));

  function isWhitespace(character) {
    return character.trim().length === 0;
  }

  function isLowSurrogate(text, index) {
    const unit = text.codePointAt(index);
    return unit >= 0xdc00 && unit <= 0xdfff;
  }

  /**
   * Tracks the pairs a walk passes through. `opening` maps a character that
   * begins a pair in the walking direction to the one that ends it, `closing`
   * the reverse. True when the walk reaches the end of a pair the match is
   * inside: the sentence stops before it. Yomitan pushes with unshift and
   * removes with pop, which loses nesting; this is the stack it means.
   */
  function leavesPair(pending, character, opening, closing) {
    if (closing.has(character)) {
      if (pending.length === 0) return true;
      if (pending[pending.length - 1] === character) pending.pop();
      return false;
    }
    if (opening.has(character)) pending.push(opening.get(character));
    return false;
  }

  /** Walks backward from `from` to `limit`; a terminator stays out of the sentence. */
  function sentenceStart(text, from, limit) {
    const pending = [];
    let start = from;
    for (; start > limit; start -= 1) {
      const character = text[start - 1];
      if (character === "\n" || (pending.length === 0 && TERMINATORS.has(character))) break;
      if (leavesPair(pending, character, OPENER_OF, CLOSER_OF)) break;
    }
    return start;
  }

  /** Walks forward from `from` to `limit`; a run of terminators ends the sentence and belongs to it. */
  function sentenceEnd(text, from, limit) {
    const pending = [];
    let end = from;
    for (; end < limit; end += 1) {
      const character = text[end];
      if (character === "\n") break;
      if (pending.length === 0 && TERMINATORS.has(character)) {
        while (end < limit && TERMINATORS.has(text[end])) end += 1;
        break;
      }
      if (leavesPair(pending, character, CLOSER_OF, OPENER_OF)) break;
    }
    return end;
  }

  /**
   * The sentence of `text` around the match at `matchOffset` of `matchLength`
   * UTF-16 code units, and the match's offset inside that sentence. The walk
   * never enters the match itself, so a terminator inside the matched word
   * (U.S.A.) does not end its sentence.
   */
  function extractSentence(text, matchOffset, matchLength, extent = SENTENCE_SCAN_EXTENT) {
    const matchStart = Math.max(0, Math.min(text.length, matchOffset));
    const matchEnd = Math.max(matchStart, Math.min(text.length, matchStart + matchLength));
    let windowStart = Math.max(0, matchStart - extent);
    let windowEnd = Math.min(text.length, matchEnd + extent * 2 - (matchStart - windowStart));
    // Only the window's edges can land inside a surrogate pair; step inside it.
    if (windowStart < matchStart && isLowSurrogate(text, windowStart)) windowStart += 1;
    if (windowEnd > matchEnd && isLowSurrogate(text, windowEnd)) windowEnd -= 1;
    let start = sentenceStart(text, matchStart, windowStart);
    let end = sentenceEnd(text, matchEnd, windowEnd);
    while (start < matchStart && isWhitespace(text[start])) start += 1;
    while (end > matchEnd && isWhitespace(text[end - 1])) end -= 1;
    return { sentence: text.slice(start, end), matchOffset: matchStart - start };
  }

  globalThis.HDSentence = { SENTENCE_SCAN_EXTENT, extractSentence };
})();
