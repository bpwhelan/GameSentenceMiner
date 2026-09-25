const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { between } = require('./helpers/overlay-startup.cjs');
const { rendererFixtureSource, line, overlayRoot, readRenderer } = require('./helpers/overlay-render.cjs');

function setup(t) {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom;
  Object.defineProperty(window, 'innerWidth', { value: 1920 });
  Object.defineProperty(window, 'innerHeight', { value: 1080 });
  // DOM layout is irrelevant to block membership. Supply serializable empty
  // measurements so the production rendering branch also runs under jsdom.
  window.HTMLElement.prototype.getBoundingClientRect = () => new window.DOMRect();
  window.eval(rendererFixtureSource(readRenderer(), fs.readFileSync(path.join(overlayRoot, 'block_detection.js'), 'utf8')));
  return window;
}

test('one OCR line spanning a nameplate and dialogue renders two tight blocks without losing glyphs', t => {
  const window = setup(t);
  const name = line('ファイ', 0.12, 0.69, 0.075, 0.04, false, true);
  const dialogue = line('【03】と【01】が発見されたわけだから、当然……', 0.12, 0.78, 0.67, 0.045, false, true);
  const sourceLine = {
    text: name.text + dialogue.text,
    words: [...name.words, ...dialogue.words],
    bounding_rect: { x1: 0.1, y1: 0.67, x3: 0.82, y3: 0.85 },
  };
  const payload = { line_id: 'mixed-ocr-line', data: [sourceLine] };
  const original = JSON.stringify(payload);
  window.renderFixture(payload);
  const blocks = [...window.document.querySelectorAll('.text-block-container')];
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map(block => block.textContent.replace(/\s/gu, '')), [name.text, dialogue.text]);
  assert.deepEqual(blocks.map(block => block.dataset.translationSource), [name.text, dialogue.text]);
  assert.deepEqual(blocks.map(block => [...new Set([...block.querySelectorAll('.text-box')].map(box => box.dataset.lineIndex))]), [['0'], ['1']]);
  assert.equal(JSON.stringify(payload), original, 'rendering must leave the authoritative OCR payload intact');
  const indicators = [...window.document.querySelectorAll('.line-box')];
  assert.equal(indicators.length, 2);
  assert.ok(parseFloat(indicators[0].style.height) < 5, 'nameplate bounds must not include the body');
  assert.ok(parseFloat(indicators[1].style.height) < 5, 'dialogue bounds must not include the nameplate');
});

test('regrouping identical lexical text invalidates the renderer reuse signature', t => {
  const { window } = new JSDOM('<!doctype html>', { runScripts: 'outside-only' });
  t.after(() => window.close());
  const html = readRenderer();
  window.eval(`
    ${between(html, '  const CJK_LEXICAL_REGEX =', '  function requestMagpieMouseRelease(')}
    ${between(html, '  function isOverlayLineVertical(', '  function prepareGamepadForOverlayTextRender(')}
    ${between(html, '  function shouldPreserveLexicalWordBoxes(', '  function getViewportRectFromPercentBounds(')}
    window.signatureFor = getOverlayTextRenderSignature;
  `);
  const lines = [line('Settings ', 0.1, 0.1, 0.1, 0.03), line('Menu ', 0.1, 0.14, 0.1, 0.03)];
  const joined = window.signatureFor(lines, new Map([[0, 0], [1, 0]]), new Map([[0, { start: 0, end: 1 }]]), 1);
  const separate = window.signatureFor(lines, new Map([[0, 0], [1, 1]]), new Map([[0, { start: 0, end: 0 }], [1, { start: 1, end: 1 }]]), 2);
  assert.notEqual(joined.signature, separate.signature);
});

test('NVL blocks split only when the coordinate payload is final', t => {
  const window = setup(t);
  const oldLine = line('古い台詞。', 0.1, 0.4, 0.22, 0.04);
  const newLine = line('新しい台詞。', 0.1, 0.45, 0.26, 0.04);
  window.renderFixture({ line_id: 'old', is_final: true, data: [oldLine] });
  window.renderFixture({ line_id: 'new', data: [oldLine, newLine] });
  assert.equal(window.document.querySelectorAll('.text-block-container').length, 1);

  window.renderFixture({ line_id: 'new', is_final: true, data: [oldLine, newLine] });
  const blocks = [...window.document.querySelectorAll('.text-block-container')];
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map(block => block.dataset.translationSource), [oldLine.text, newLine.text]);
});

test('distant menu labels within one OCR row retain their own lookup and translation blocks', t => {
  const window = setup(t);
  const words = [
    line('New', 0.1, 0.4, 0.035, 0.035).words[0],
    line('Game', 0.143, 0.4, 0.045, 0.035).words[0],
    line('Load', 0.58, 0.4, 0.045, 0.035).words[0],
    line('Game', 0.633, 0.4, 0.045, 0.035).words[0],
  ];
  const text = 'New Game    Load Game';
  window.renderFixture({ data: [{
    text, words, bounding_rect: { x1: 0.1, y1: 0.4, x3: 0.678, y3: 0.435 },
  }] });
  const blocks = [...window.document.querySelectorAll('.text-block-container')];
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map(block => block.textContent.trim()), ['New Game', 'Load Game']);
  assert.equal(blocks.map(block => block.dataset.translationSource).join(''), text,
    'splitting an OCR row must preserve its original text and whitespace');
  const indicators = [...window.document.querySelectorAll('.line-box')];
  for (const [index, expected] of [[9.8, 9.2], [57.8, 10.2]].entries()) {
    assert.ok(Math.abs(parseFloat(indicators[index].style.left) - expected[0]) < 1e-8);
    assert.ok(Math.abs(parseFloat(indicators[index].style.width) - expected[1]) < 1e-8,
      'indicators should surround their own word bounds with only the existing 0.2% padding');
  }
});
