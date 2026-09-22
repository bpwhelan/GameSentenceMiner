const assert = require('node:assert/strict');
const test = require('node:test');
const { findRecentBlockMatchAt } = require('../block_detection.js');

function referenceSimilarity(left, right) {
  const normalize = value => String(value || '').normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '');
  left = normalize(left);
  right = normalize(right);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const longest = Math.max(left.length, right.length), shortest = Math.min(left.length, right.length);
  if (shortest < 6 || shortest / longest < 0.8) return 0;
  let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 0; i < left.length; i++) {
    const current = [i + 1];
    for (let j = 0; j < right.length; j++) {
      current.push(Math.min(current[j] + 1, previous[j + 1] + 1, previous[j] + (left[i] === right[j] ? 0 : 1)));
    }
    previous = current;
  }
  const similarity = 1 - previous[right.length] / longest;
  return similarity >= 0.85 ? similarity : 0;
}

function referenceMatch(indexes, start, lines, history) {
  let candidate = '', best = null;
  for (let end = start; end < indexes.length; end++) {
    candidate += lines[indexes[end]].text;
    for (let historyIndex = history.length - 1; historyIndex >= 0; historyIndex--) {
      const similarity = referenceSimilarity(candidate, history[historyIndex]);
      if (similarity && (!best || similarity > best.similarity || (similarity === best.similarity && candidate.length > best.rawText.length))) {
        best = { end: end + 1, historyIndex, rawText: candidate, similarity };
      }
    }
  }
  return best;
}

test('history matching retains exact UTF-16 edit distances and tie breaking', () => {
  let seed = 728341;
  const random = max => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  const alphabet = Array.from('日本語かなカナＡＢＣ123ｶﾞ𠮷🙂 ée\u0301ー！');
  for (let round = 0; round < 1400; round++) {
    const base = Array.from({ length: 6 + random(100) }, () => alphabet[random(alphabet.length)]).join('');
    const changed = Array.from(base);
    for (let i = 0; i < 1 + random(25); i++) changed[random(changed.length)] = alphabet[random(alphabet.length)];
    const split = random(base.length + 1);
    const lines = [{ text: base.slice(0, split) }, { text: base.slice(split) }, { text: changed.join('') }];
    const history = [changed.join(''), base, base.slice(1), base.repeat(2)];
    assert.deepEqual(findRecentBlockMatchAt([0, 1, 2], round % 3, lines, history), referenceMatch([0, 1, 2], round % 3, lines, history));
  }
  for (let length = 6; length < 160; length++) {
    const base = '漢'.repeat(length);
    for (let differences = 0; differences < length / 4; differences++) {
      const lines = [{ text: '字'.repeat(differences) + base.slice(differences) }];
      assert.deepEqual(findRecentBlockMatchAt([0], 0, lines, [base]), referenceMatch([0], 0, lines, [base]));
    }
  }
});

test('normalizes each history item and candidate only once per search', () => {
  const original = String.prototype.normalize;
  let count = 0;
  String.prototype.normalize = function (...args) { count++; return original.apply(this, args); };
  try {
    const lines = Array.from({ length: 10 }, () => ({ text: '日本語の長い文章です。' }));
    const history = Array.from({ length: 20 }, (_, i) => `以前の文章${i}です。`);
    findRecentBlockMatchAt(lines.map((_, i) => i), 0, lines, history);
    assert(count <= lines.length + history.length, `Repeated normalization: ${count}`);
  } finally {
    String.prototype.normalize = original;
  }
});

module.exports = { referenceMatch, referenceSimilarity };
