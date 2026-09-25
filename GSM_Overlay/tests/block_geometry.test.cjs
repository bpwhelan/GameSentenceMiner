const assert = require('node:assert/strict');
const test = require('node:test');
const { buildLineMetrics, detectTextBlocks, prepareTextLines } = require('../block_detection.js');

// Coordinates match the normalized rectangles supplied by OCR. Each fixture
// has real inter-character whitespace instead of dividing a padded line box.
function glyphLine(text, x, y, glyphWidth = 0.015, height = 0.03, gap = 0.002) {
  const words = Array.from(text).map((symbol, index) => ({
    text: symbol,
    bounding_rect: {
      x1: x + index * (glyphWidth + gap),
      y1: y,
      x3: x + index * (glyphWidth + gap) + glyphWidth,
      y3: y + height,
    },
  }));
  return {
    text,
    words,
    bounding_rect: {
      x1: words[0].bounding_rect.x1,
      y1: y,
      x3: words.at(-1).bounding_rect.x3,
      y3: y + height,
    },
  };
}

function blockGroups(result) {
  const groups = new Map();
  for (const [lineIndex, blockId] of result.lineBlocks) {
    if (!groups.has(blockId)) groups.set(blockId, []);
    groups.get(blockId).push(lineIndex);
  }
  return [...groups.values()].map(group => group.sort((a, b) => a - b))
    .sort((a, b) => a[0] - b[0]);
}

function assertNear(actual, expected) {
  assert(Math.abs(actual - expected) < 1e-9, `Expected ${expected}, received ${actual}`);
}

test('line metrics fit visible words instead of padded OCR line rectangles', () => {
  const line = glyphLine('日本語。', 0.12, 0.40);
  line.bounding_rect = { x1: 0.08, y1: 0.36, x3: 0.30, y3: 0.48 };

  const [metric] = buildLineMetrics([line]);

  assert.equal(metric.index, 0);
  assertNear(metric.x1, 12);
  assertNear(metric.x3, 18.6);
  assertNear(metric.y1, 40);
  assertNear(metric.y3, 43);
  assertNear(metric.width, 6.6);
  assertNear(metric.height, 3);
});

test('malformed and whitespace word boxes cannot expand the visible text bounds', () => {
  const line = glyphLine('日本語。', 0.12, 0.40);
  line.bounding_rect = { x1: 0.08, y1: 0.36, x3: 0.30, y3: 0.48 };
  line.words.push(
    { text: ' ', bounding_rect: { x1: 0, y1: 0, x3: 1, y3: 1 } },
    { text: '', bounding_rect: { x1: 0, y1: 0, x3: 1, y3: 1 } },
    { text: '誤', bounding_rect: { x1: NaN, y1: 0, x3: 1, y3: 1 } },
    { text: '誤', bounding_rect: { x1: 0.5, y1: 0.5, x3: 0.5, y3: 0.5 } },
    { text: '誤' },
  );

  const [metric] = buildLineMetrics([line]);

  assertNear(metric.x1, 12);
  assertNear(metric.x3, 18.6);
  assertNear(metric.y1, 40);
  assertNear(metric.y3, 43);
});

test('OCR without usable words still falls back to its line rectangle', () => {
  const rect = { x1: 0.12, y1: 0.4, x3: 0.3, y3: 0.43 };
  for (const words of [undefined, [], [{ text: '日本語。' }]]) {
    const [metric] = buildLineMetrics([{ text: '日本語。', bounding_rect: rect, words }]);
    assertNear(metric.x1, 12);
    assertNear(metric.x3, 30);
    assertNear(metric.y1, 40);
    assertNear(metric.y3, 43);
  }
});

test('padded OCR boxes do not merge the reported nameplate and single dialogue row', () => {
  const name = glyphLine('ファイ', 0.119, 0.680, 0.022, 0.050, 0.003);
  const text = '【03】と【01】が発見されたわけだから、当然……';
  const glyphWidth = (0.668 - (Array.from(text).length - 1) * 0.003) / Array.from(text).length;
  const dialogue = glyphLine(text, 0.119, 0.780, glyphWidth, 0.050, 0.003);
  // The inflated outer rectangles nearly touch despite the visible empty gap.
  name.bounding_rect = { x1: 0.105, y1: 0.670, x3: 0.202, y3: 0.755 };
  dialogue.bounding_rect = { x1: 0.105, y1: 0.762, x3: 0.835, y3: 0.852 };

  const result = detectTextBlocks([name, dialogue], undefined, null, { latestText: text });

  assert.deepEqual(blockGroups(result), [[0], [1]]);
  assert.equal(result.blockMetadata.get(result.lineBlocks.get(1)).isLatestLine, true);
});

test('nearby fragments with ordinary character spacing remain one horizontal block', () => {
  const first = glyphLine('ここから', 0.1, 0.4);
  const second = glyphLine('始まる。', first.bounding_rect.x3 + 0.009, 0.401);

  assert.deepEqual(blockGroups(detectTextBlocks([first, second])), [[0, 1]]);
});

test('a wide horizontal gap is measured against glyph spacing, not text height', () => {
  const first = glyphLine('セーブ', 0.1, 0.4, 0.012, 0.05);
  const second = glyphLine('ロード', first.bounding_rect.x3 + 0.052, 0.4, 0.012, 0.05);

  assert.deepEqual(blockGroups(detectTextBlocks([first, second])), [[0], [1]]);
});

test('close parallel columns stay separate even when the gutter is less than text height', () => {
  const lines = [];
  for (const y of [0.20, 0.26, 0.32]) {
    lines.push(glyphLine('左の文章です。', 0.10, y, 0.014, 0.040));
  }
  const rightX = lines[0].bounding_rect.x3 + 0.040;
  for (const y of [0.20, 0.26, 0.32]) {
    lines.push(glyphLine('右の文章です。', rightX, y, 0.014, 0.040));
  }

  assert.deepEqual(blockGroups(detectTextBlocks(lines)), [[0, 1, 2], [3, 4, 5]]);
});

test('consistent loose spacing across several rows stays one paragraph', () => {
  const lines = [0.10, 0.165, 0.230, 0.295].map((y, index) => (
    glyphLine(`同じ段落の${index}行。`, 0.1, y, 0.015, 0.030)
  ));

  assert.deepEqual(blockGroups(detectTextBlocks(lines)), [[0, 1, 2, 3]]);
});

test('a larger gap between otherwise regularly spaced rows starts another paragraph', () => {
  const lines = [0.10, 0.14, 0.18, 0.245, 0.285, 0.325].map((y, index) => (
    glyphLine(`文章の${index}行目です。`, 0.1, y, 0.015, 0.030)
  ));

  assert.deepEqual(blockGroups(detectTextBlocks(lines)), [[0, 1, 2], [3, 4, 5]]);
});

test('large heading and small caption do not merge just because their boxes are close', () => {
  const heading = glyphLine('見出し', 0.10, 0.40, 0.045, 0.080);
  const caption = glyphLine('補足説明。', heading.bounding_rect.x3 + 0.010, 0.45, 0.012, 0.024);

  assert.deepEqual(blockGroups(detectTextBlocks([heading, caption])), [[0], [1]]);
});

test('large unrelated fonts do not make small UI rows merge over a large gap', () => {
  const lines = [
    glyphLine('設定。', 0.1, 0.1, 0.01, 0.018),
    glyphLine('終了。', 0.1, 0.16, 0.01, 0.018),
    glyphLine('大きい文字。', 0.5, 0.35, 0.04, 0.08),
    glyphLine('別の大文字。', 0.5, 0.50, 0.04, 0.08),
    glyphLine('次の大文字。', 0.5, 0.65, 0.04, 0.08),
  ];

  const result = detectTextBlocks(lines);

  assert.notEqual(result.lineBlocks.get(0), result.lineBlocks.get(1));
});

test('one coarse OCR line is split into its visual rows with tight rectangles', () => {
  const first = glyphLine('最初の文章。', 0.12, 0.40);
  const second = glyphLine('次の文章。', 0.12, 0.45);
  const source = {
    text: `${first.text}\n${second.text}`,
    words: [...first.words, ...second.words],
    bounding_rect: { x1: 0.08, y1: 0.36, x3: 0.40, y3: 0.52 },
  };

  const prepared = prepareTextLines([source]);

  assert.equal(prepared.length, 2);
  assert.equal(prepared.map(line => line.text).join(''), source.text);
  assert.equal(prepared[0].text.trim(), first.text);
  assert.equal(prepared[1].text.trim(), second.text);
  assertNear(prepared[0].bounding_rect.x1, first.bounding_rect.x1);
  assertNear(prepared[0].bounding_rect.y3, first.bounding_rect.y3);
  assertNear(prepared[1].bounding_rect.y1, second.bounding_rect.y1);
  assertNear(prepared[1].bounding_rect.x3, second.bounding_rect.x3);
  assert.deepEqual(blockGroups(detectTextBlocks(prepared)), [[0, 1]]);
});

test('CJK word-level OCR keeps ordinary word gaps but splits a distant label in one row', () => {
  const words = [
    { text: 'ここから', bounding_rect: { x1: 0.100, y1: 0.4, x3: 0.168, y3: 0.43 } },
    { text: '始まる。', bounding_rect: { x1: 0.180, y1: 0.4, x3: 0.248, y3: 0.43 } },
    { text: '設定', bounding_rect: { x1: 0.370, y1: 0.4, x3: 0.402, y3: 0.43 } },
  ];
  const source = {
    text: 'ここから始まる。　設定',
    words,
    bounding_rect: { x1: 0.09, y1: 0.38, x3: 0.42, y3: 0.46 },
  };

  const prepared = prepareTextLines([source]);

  assert.equal(prepared.length, 2);
  assert.equal(prepared[0].text.trim(), 'ここから始まる。');
  assert.equal(prepared[1].text.trim(), '設定');
  assert.equal(prepared.map(line => line.text).join(''), source.text);
  assert.deepEqual(prepared.map(line => line.words.length), [2, 1]);
  assert.deepEqual(blockGroups(detectTextBlocks(prepared)), [[0], [1]]);
});

test('preparing geometry preserves exact Unicode and whitespace, word references, and source data', () => {
  const source = {
    text: '  𠮷野家🙂　 セーブ\tロード  ',
    words: [
      { text: '𠮷野家🙂', bounding_rect: { x1: 0.10, y1: 0.4, x3: 0.168, y3: 0.43 }, confidence: 0.9 },
      { text: 'セーブ', bounding_rect: { x1: 0.18, y1: 0.4, x3: 0.229, y3: 0.43 }, confidence: 0.8 },
      { text: 'ロード', bounding_rect: { x1: 0.60, y1: 0.4, x3: 0.649, y3: 0.43 }, confidence: 0.7 },
    ],
    bounding_rect: { x1: 0.08, y1: 0.38, x3: 0.70, y3: 0.46 },
    confidence: 0.85,
  };
  const snapshot = structuredClone(source);

  const prepared = prepareTextLines([source]);

  assert.equal(prepared.length, 2);
  assert.equal(prepared.map(line => line.text).join(''), source.text);
  const preparedWords = prepared.flatMap(line => line.words);
  assert.equal(preparedWords.length, source.words.length);
  preparedWords.forEach((word, index) => assert.equal(word, source.words[index]));
  assert.deepEqual(source, snapshot);
});

test('preparing partial or inconsistent word coverage cannot discard source text', () => {
  for (const wordText of ['この', '誤認識']) {
    const source = {
      text: 'この文章を失わない。',
      words: [{ text: wordText, bounding_rect: { x1: 0.1, y1: 0.4, x3: 0.15, y3: 0.43 } }],
      bounding_rect: { x1: 0.1, y1: 0.4, x3: 0.5, y3: 0.43 },
    };

    const prepared = prepareTextLines([source]);

    assert.equal(prepared.length, 1);
    assert.equal(prepared[0].text, source.text);
    assert.deepEqual(prepared[0].bounding_rect, source.bounding_rect);
    assert.deepEqual(prepared[0].words, source.words);
    const [metric] = buildLineMetrics(prepared);
    assertNear(metric.x1, source.bounding_rect.x1 * 100);
    assertNear(metric.x3, source.bounding_rect.x3 * 100);
  }
});

test('preparing a vertical OCR column does not turn its individual characters into rows', () => {
  const source = {
    text: '日本語。',
    words: Array.from('日本語。').map((text, index) => ({
      text,
      bounding_rect: { x1: 0.5, y1: 0.10 + index * 0.04, x3: 0.52, y3: 0.132 + index * 0.04 },
    })),
    bounding_rect: { x1: 0.50, y1: 0.10, x3: 0.52, y3: 0.252 },
    isVertical: true,
  };

  const prepared = prepareTextLines([source]);

  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].text, source.text);
  assert.equal(prepared[0].isVertical, true);
  assert.equal(prepared[0].words.length, 4);
});

test('shallow punctuation fragments remain attached to the adjoining dialogue baseline', () => {
  const dialogue = glyphLine('本当に', 0.10, 0.40);
  const punctuation = glyphLine('……', dialogue.bounding_rect.x3 + 0.002, 0.423, 0.012, 0.006);

  assert.deepEqual(blockGroups(detectTextBlocks([dialogue, punctuation])), [[0, 1]]);
});

test('narrow punctuation inside an OCR line stays attached without changing source text', () => {
  const source = glyphLine('「本当……？」', 0.10, 0.40);
  for (const word of source.words) {
    if (word.text === '…') {
      word.bounding_rect.y1 = 0.423;
      word.bounding_rect.y3 = 0.429;
    }
    if (word.text === '「' || word.text === '」') {
      word.bounding_rect.x3 = word.bounding_rect.x1 + 0.004;
    }
  }

  const prepared = prepareTextLines([source]);

  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].text, source.text);
  assert.equal(prepared[0].words.length, source.words.length);
});

test('preparing mixed font sizes is idempotent and keeps small labels separated', () => {
  const save = glyphLine('保存', 0.10, 0.20, 0.008, 0.018);
  const exit = glyphLine('終了', 0.147, 0.20, 0.008, 0.018);
  const heading = glyphLine('大きい文字の見出し', 0.10, 0.60, 0.04, 0.08, 0.005);
  const source = {
    text: `${save.text}　${exit.text}\n${heading.text}`,
    words: [...save.words, ...exit.words, ...heading.words],
    bounding_rect: { x1: 0.09, y1: 0.18, x3: 0.7, y3: 0.7 },
  };

  const first = prepareTextLines([source]);
  const second = prepareTextLines(first);

  assert.deepEqual(second, first);
  assert.equal(first.length, 3);
  assert.equal(first.map(line => line.text).join(''), source.text);
});

test('explicit whitespace tokens and repeated words survive splitting and re-preparation', () => {
  const words = [
    { text: 'はい', bounding_rect: { x1: 0.1, y1: 0.4, x3: 0.135, y3: 0.43 } },
    { text: ' \n　', bounding_rect: { x1: 0.135, y1: 0.4, x3: 0.40, y3: 0.5 } },
    { text: 'はい', bounding_rect: { x1: 0.5, y1: 0.4, x3: 0.535, y3: 0.43 } },
    { text: '\t ', bounding_rect: { x1: 0.535, y1: 0.4, x3: 0.55, y3: 0.43 } },
  ];
  const source = {
    text: words.map(word => word.text).join(''),
    words,
    bounding_rect: { x1: 0.1, y1: 0.4, x3: 0.55, y3: 0.5 },
  };

  const first = prepareTextLines([source]);
  const second = prepareTextLines(first);

  assert.equal(first.length, 2);
  assert.equal(first.map(line => line.text).join(''), source.text);
  assert.equal(first.flatMap(line => line.words).map(word => word.text).join(''), source.text);
  first.flatMap(line => line.words).forEach((word, index) => assert.equal(word, words[index]));
  assert.deepEqual(second, first);
});

test('unlabelled vertical CJK columns preserve orientation and join as one vertical paragraph', () => {
  const words = [];
  for (const x of [0.60, 0.56]) {
    Array.from('日本語の文章。').forEach((text, index) => words.push({
      text,
      bounding_rect: { x1: x, y1: 0.10 + index * 0.038, x3: x + 0.018, y3: 0.131 + index * 0.038 },
    }));
  }
  const source = {
    text: words.map(word => word.text).join(''),
    words,
    bounding_rect: { x1: 0.55, y1: 0.09, x3: 0.63, y3: 0.39 },
  };
  const options = { viewportWidth: 1920, viewportHeight: 1080 };

  const prepared = prepareTextLines([source], options);

  assert.equal(prepared.length, 2);
  assert(prepared.every(line => line.isVertical === true));
  assert.equal(prepared.map(line => line.text).join(''), source.text);
  assert.deepEqual(prepareTextLines(prepared, options), prepared);
  assert.deepEqual(blockGroups(detectTextBlocks(prepared, undefined, null, options)), [[0, 1]]);
});

test('paragraph spacing is inferred separately for columns with different line spacing', () => {
  const loose = [0.10, 0.165, 0.230, 0.295].map(y => glyphLine('左の文章です。', 0.10, y));
  const tight = [0.10, 0.14, 0.18, 0.245, 0.285, 0.325].map(y => glyphLine('右の文章です。', 0.60, y));

  assert.deepEqual(blockGroups(detectTextBlocks([...loose, ...tight])), [[0, 1, 2, 3], [4, 5, 6], [7, 8, 9]]);
});

test('a narrow detached nameplate separates at a gap smaller than a full character height', () => {
  const name = glyphLine('ファイ', 0.119, 0.680, 0.022, 0.050, 0.003);
  const dialogue = glyphLine('【03】と【01】が発見されたわけだから、当然……', 0.119, 0.765, 0.022, 0.050, 0.003);

  const result = detectTextBlocks([name, dialogue]);

  assert.deepEqual(blockGroups(result), [[0], [1]]);
  assert.equal(result.blockMetadata.get(result.lineBlocks.get(0)).role, 'character-name');
  assert.equal(result.blockMetadata.get(result.lineBlocks.get(1)).role, 'dialogue');
});

test('a short opening at normal line spacing remains part of its dialogue', () => {
  const opening = glyphLine('でも', 0.119, 0.680, 0.022, 0.050, 0.003);
  const dialogue = glyphLine('この先に何があるのか確かめてみたいんだ', 0.119, 0.748, 0.022, 0.050, 0.003);

  assert.deepEqual(blockGroups(detectTextBlocks([opening, dialogue])), [[0, 1]]);
});

test('thin CJK glyph ink does not divide words at long vowels or the single-stroke kanji', () => {
  for (const text of ['ゲームをする。', 'もう一人いる。']) {
    const source = glyphLine(text, 0.10, 0.40);
    for (const word of source.words) {
      if (word.text === 'ー' || word.text === '一') {
        word.bounding_rect.y1 = 0.414;
        word.bounding_rect.y3 = 0.418;
      }
    }

    const prepared = prepareTextLines([source]);

    assert.equal(prepared.length, 1, `Split one word around a thin glyph: ${text}`);
    assert.equal(prepared[0].text, text);
    assert.deepEqual(blockGroups(detectTextBlocks(prepared)), [[0]]);
  }
});
