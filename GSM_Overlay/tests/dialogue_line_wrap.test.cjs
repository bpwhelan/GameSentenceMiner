const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const fixture = require('./fixtures/wrapped-dialogue-oneocr.json');
const { prepareTextLines, detectTextBlocks } = require('../block_detection.js');
const { rendererFixtureSource, overlayRoot, readRenderer } = require('./helpers/overlay-render.cjs');

const viewport = { viewportWidth: fixture.imageWidth, viewportHeight: fixture.imageHeight };

function dialogueLines() {
  const normalize = rect => Object.fromEntries(Object.entries(rect).map(([key, value]) => (
    [key, value / (key.startsWith('x') ? fixture.imageWidth : fixture.imageHeight)]
  )));
  return fixture.lines.map(line => ({
    ...line,
    bounding_rect: normalize(line.bounding_rect),
    words: line.words.map(word => ({ ...word, bounding_rect: normalize(word.bounding_rect) })),
  }));
}

test('screenshot dialogue stays in one block across the wide dash and wrapped row', () => {
  const lines = dialogueLines();
  const original = structuredClone(lines);
  const prepared = prepareTextLines(lines, viewport);
  const result = detectTextBlocks(prepared, undefined, null, viewport);

  assert.equal(result.blockCount, 1);
  assert.deepEqual(prepared.map(line => line.text), lines.map(line => line.text));
  assert.deepEqual(prepareTextLines(prepared, viewport), prepared);
  assert.deepEqual(lines, original, 'layout preparation must preserve the OCR payload');
});

test('screenshot dialogue also joins when OCR supplies separate fragments around the dash', () => {
  const [first, second] = dialogueLines();
  const dashEnd = first.words.findIndex(word => word.text === '–') + 1;
  const fragments = [first.words.slice(0, dashEnd), first.words.slice(dashEnd)].map(words => ({
    ...first, words, text: words.map(word => word.text).join(''),
  }));
  const prepared = prepareTextLines([...fragments, second], viewport);
  const result = detectTextBlocks(prepared, undefined, null, viewport);

  assert.equal(result.blockCount, 1);
  assert.equal(prepared.map(line => line.text).join(''), first.text + second.text);
});

test('Yomitan lookup reads across the screenshot dialogue wrap in the rendered paragraph', t => {
  const { window } = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  t.after(() => window.close());
  Object.defineProperty(window, 'innerWidth', { value: fixture.imageWidth });
  Object.defineProperty(window, 'innerHeight', { value: fixture.imageHeight });
  window.HTMLElement.prototype.getBoundingClientRect = () => new window.DOMRect();
  window.eval(rendererFixtureSource(readRenderer(), fs.readFileSync(path.join(overlayRoot, 'block_detection.js'), 'utf8')));

  const strings = fs.readFileSync(path.join(overlayRoot, 'yomitan/js/data/string-util.js'), 'utf8');
  const scanner = fs.readFileSync(path.join(overlayRoot, 'yomitan/js/dom/dom-text-scanner.js'), 'utf8');
  window.eval(`
    ${strings.replace(/^export /gm, '')}
    ${scanner.replace(/^import .*;\r?\n/gm, '').replace('export class DOMTextScanner', 'class DOMTextScanner')}
    window.DOMTextScanner = DOMTextScanner;
  `);

  const lines = dialogueLines();
  for (const isFinal of [false, true]) {
    window.renderFixture({ line_id: 'wrapped-dialogue', is_final: isFinal, data: lines });
    const blocks = [...window.document.querySelectorAll('.text-block-container')];
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].dataset.translationSource, lines.map(line => line.text).join('\n'));
    assert.equal(blocks[0].textContent, lines.map(line => line.text).join(''));

    const boxes = [...blocks[0].querySelectorAll('.text-box')];
    const start = boxes[Array.from(lines[0].text).length - 3];
    const scan = new window.DOMTextScanner(start.firstChild, 0, false, false);
    assert.equal(scan.seek(4).content, 'なんかで');
  }
});
