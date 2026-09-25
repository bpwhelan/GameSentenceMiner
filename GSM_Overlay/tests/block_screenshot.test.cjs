const assert = require('node:assert/strict');
const test = require('node:test');
const fixture = require('./fixtures/nameplate-dialogue-oneocr.json');
const { prepareTextLines, detectTextBlocks } = require('../block_detection.js');

const viewport = {
  viewportWidth: fixture.imageWidth,
  viewportHeight: fixture.imageHeight,
};

// Match _convert_source_space_results_to_percentages_python for a full-frame
// capture at its original size, with no window offset. Preserve all quad points.
function normalizedFixture() {
  const normalizeRect = (rect) => Object.fromEntries(
    Object.entries(rect).map(([key, value]) => [
      key,
      value / (key.startsWith('x') ? fixture.imageWidth : fixture.imageHeight),
    ])
  );
  return fixture.lines.map((line) => ({
    ...line,
    bounding_rect: normalizeRect(line.bounding_rect),
    words: line.words.map((word) => ({
      ...word,
      bounding_rect: normalizeRect(word.bounding_rect),
    })),
  }));
}

function wordBounds(words) {
  const xs = words.flatMap(({ bounding_rect: rect }) => [rect.x1, rect.x2, rect.x3, rect.x4]);
  const ys = words.flatMap(({ bounding_rect: rect }) => [rect.y1, rect.y2, rect.y3, rect.y4]);
  return {
    x1: Math.min(...xs),
    y1: Math.min(...ys),
    x3: Math.max(...xs),
    y3: Math.max(...ys),
  };
}

// Model OCR segmentation differences without inventing character coordinates:
// every fragment retains real words and its exact slice of the source text.
function fragmentLine(line, wordCounts) {
  const starts = [];
  let cursor = 0;
  for (const word of line.words) {
    const start = line.text.indexOf(word.text, cursor);
    assert(start >= cursor, `Missing fixture word: ${word.text}`);
    starts.push(start);
    cursor = start + word.text.length;
  }
  let wordOffset = 0;
  return wordCounts.map((count, index) => {
    const words = line.words.slice(wordOffset, wordOffset + count);
    const start = index === 0 ? 0 : starts[wordOffset];
    wordOffset += count;
    const end = wordOffset === line.words.length ? line.text.length : starts[wordOffset];
    return {
      ...line,
      text: line.text.slice(start, end),
      words,
      bounding_rect: wordBounds(words),
    };
  });
}

function assertNameAndDialogue(lines) {
  const before = structuredClone(lines);
  const prepared = prepareTextLines(lines, viewport);
  const result = detectTextBlocks(prepared, undefined, null, viewport);
  assert.deepEqual(lines, before, 'Preparing layout must not alter the OCR payload');
  assert.equal(result.blockCount, 2);

  const texts = new Map();
  for (const [index, line] of prepared.entries()) {
    const blockId = result.lineBlocks.get(index);
    assert.notEqual(blockId, undefined, 'Every prepared line must belong to a block');
    texts.set(blockId, (texts.get(blockId) || '') + line.text);
  }
  assert.deepEqual([...texts.values()], fixture.lines.map((line) => line.text));
  const [nameId, dialogueId] = texts.keys();
  assert.equal(result.blockMetadata.get(nameId)?.role, 'character-name');
  assert.equal(result.blockMetadata.get(dialogueId)?.role, 'dialogue');
  assert.equal(result.blockMetadata.get(nameId)?.relatedBlockId, dialogueId);
  return prepared;
}

test('actual OneOCR screenshot keeps the nameplate separate and the entire dialogue together', () => {
  // Fresh local OneOCR already separated these lines under the old heuristic;
  // this is preservation coverage, not a claim to reproduce the live failure.
  const prepared = assertNameAndDialogue(normalizedFixture());
  assert.equal(prepared.length, 2);
  assert.deepEqual(prepared.map((line) => line.words.length), [3, 24]);
});

test('actual screenshot grouping and tight bounds survive padded OCR line boxes', () => {
  const lines = normalizedFixture();
  for (const line of lines) {
    // Both padded boxes now overlap even though the glyphs remain separated.
    line.bounding_rect = { x1: 0.05, y1: 0.6, x3: 0.95, y3: 0.9 };
  }
  const prepared = assertNameAndDialogue(lines);
  assert.equal(prepared.length, 2);
  for (const [index, line] of prepared.entries()) {
    const expected = wordBounds(lines[index].words);
    for (const key of ['x1', 'y1', 'x3', 'y3']) {
      const axisSize = key.startsWith('x') ? fixture.imageWidth : fixture.imageHeight;
      // OneOCR's slightly rotated quads can differ by a couple of pixels from
      // their diagonal corners; the result must still hug the actual glyphs.
      assert(Math.abs(line.bounding_rect[key] - expected[key]) * axisSize < 3,
        `${line.text}: ${key} should remain within 3px of its glyph bounds`);
    }
  }
});

test('actual name glyphs remain one name block when OCR returns one line per character', () => {
  const [name, dialogue] = normalizedFixture();
  assertNameAndDialogue([...fragmentLine(name, [1, 1, 1]), dialogue]);
});

test('actual dialogue fragments retain one dialogue block beside fragmented name glyphs', () => {
  const [name, dialogue] = normalizedFixture();
  assertNameAndDialogue([
    ...fragmentLine(name, [1, 1, 1]),
    ...fragmentLine(dialogue, [7, 6, 7, 4]),
  ]);
});

test('one OCR line containing both screenshot rows is rebuilt without losing text', () => {
  const [name, dialogue] = normalizedFixture();
  const words = [...name.words, ...dialogue.words];
  const prepared = assertNameAndDialogue([{
    text: name.text + dialogue.text,
    words,
    bounding_rect: wordBounds(words),
  }]);
  assert.equal(prepared.length, 2);
});
