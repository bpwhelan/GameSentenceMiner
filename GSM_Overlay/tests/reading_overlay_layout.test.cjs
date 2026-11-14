const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { between } = require('./helpers/overlay-startup.cjs');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');

function setup(t, { offsetX = 0, offsetY = 0, scale = 1 } = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom;
  Object.assign(window, {
    innerWidth: 1000, innerHeight: 800, offsetX, offsetY,
    readingLanguage: 'japanese', pinyinToneColorsEnabled: false,
    ReadingOverlay: require('../reading_overlay_utils'),
    FuriganaUtils: require('../furigana_utils'),
    mapPercentToMagpie: (x, y) => ({ x: x * scale, y: y * scale }),
  });
  window.eval([
    between(html, '  function isOverlayLineVertical(', '  function buildOverlayLineRenderUnits('),
    between(html, '  function roundFuriganaSignatureValue(', '  function getFuriganaBackendCacheSignature('),
    between(html, '  function buildLineCharacterBoxes(', '  async function renderFuriganaForFrame('),
  ].join('\n'));
  return window;
}

function line(text, vertical) {
  return {
    text, ...(vertical === undefined ? {} : { isVertical: vertical }),
    words: [{ text, bounding_rect: { x1: 0.2, y1: 0.1, x3: 0.24, y3: 0.3 } }],
  };
}

test('vertical readings split OCR word boxes down the column and sit to its right', t => {
  const window = setup(t);
  // OneOCR omits isVertical; exercise geometry inference as well as the flag.
  for (const vertical of [true, undefined]) {
    const source = line('日本', vertical);
    const chars = window.buildLineCharacterBoxes(source);
    assert.deepEqual(Array.from(chars, c => [c.x1, c.y1, c.x3, c.y3]), [
      [20, 10, 24, 20], [20, 20, 24, 30],
    ]);
    const [box] = window.createFuriganaBoxesForLine(source, [
      { text: '日本', start: 0, end: 2, reading: 'にほん' },
    ]);
    assert.ok(box.classList.contains('furigana-box--vertical'));
    assert.equal(box.style.left, '24%');
    assert.equal(box.style.top, '10%');
    assert.equal(box.style.height, '20%');
    assert.equal(box.style.width, '');
    assert.equal(box.style.getPropertyValue('--gsm-furigana-base-font-size'), '40px');
    assert.equal(box.textContent, 'にほん');
  }
});

test('vertical annotation ranges preserve UTF-16 offsets for supplementary kanji', t => {
  const window = setup(t, { offsetX: 1, offsetY: -2, scale: 2 });
  const source = line('𠮷田', true);
  const [box] = window.createFuriganaBoxesForLine(source, [
    { text: '𠮷田', start: 0, end: 3, annotations: [{ start: 2, end: 3, reading: 'だ' }] },
  ]);
  assert.equal(box.style.left, '49%');
  assert.equal(box.style.top, '38%');
  assert.equal(box.style.height, '20%');
  assert.equal(box.style.getPropertyValue('--gsm-furigana-base-font-size'), '80px');
});

test('horizontal readings keep their placement and size above the text', t => {
  const window = setup(t, { offsetX: 1, offsetY: -2 });
  const source = line('日本', false);
  source.words[0].bounding_rect = { x1: 0.2, y1: 0.1, x3: 0.4, y3: 0.15 };
  const [box] = window.createFuriganaBoxesForLine(source, [
    { text: '日本', start: 0, end: 2, reading: 'にほん' },
  ]);
  assert.equal(box.className, 'furigana-box');
  assert.equal(box.style.left, '21%');
  assert.equal(box.style.top, '8%');
  assert.equal(box.style.width, '20%');
  assert.equal(box.style.height, '');
  assert.equal(box.style.getPropertyValue('--gsm-furigana-base-font-size'), '40px');
});
