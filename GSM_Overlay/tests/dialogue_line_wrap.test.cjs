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

// Replay the visible glyph bounds from the reported HTML. OCR omitted the
// dash entirely, leaving an empty gap between the first two fragments.
function missingDashDialogueLines() {
  return [
    ['「そう。あなたは、あの女の', 77.968, 4.20045, [
      [21.7361, 1.11111], [22.9167, 1.38889], [24.6528, 1.38889],
      [26.3889, 1.45833], [28.75, 1.38889], [31.0417, 1.38889],
      [32.7778, 1.45833], [34.8611, 1.38889], [36.5972, 1.11111],
      [38.2639, 2.36111], [40.9028, 1.45833], [43.2639, 1.38889], [45, 2.5],
    ]],
    ['贄の血を引く家', 78.0915, 3.82982, [
      [51.1111, 1.38889], [53.125, 1.31944], [55.3472, 1.31944],
      [57.5, 1.38889], [59.1667, 1.45833], [61.1806, 1.59722], [63.6111, 2.08333],
    ]],
    ['の子だから」', 82.9097, 3.70628, [
      [20.8333, 1.11111], [22.7778, 1.31944], [24.7222, 1.25],
      [26.875, 1.31944], [28.75, 1.31944], [30.625, 1.31944],
    ]],
  ].map(([text, y, height, bounds]) => ({
    text,
    bounding_rect: {
      x1: bounds[0][0] / 100, y1: y / 100,
      x3: (bounds.at(-1)[0] + bounds.at(-1)[1]) / 100, y3: (y + height) / 100,
    },
    words: Array.from(text, (glyph, index) => ({
      text: glyph,
      bounding_rect: {
        x1: bounds[index][0] / 100, y1: y / 100,
        x3: (bounds[index][0] + bounds[index][1]) / 100, y3: (y + height) / 100,
      },
    })),
  }));
}

test('reported dialogue stays one block when OCR omits the long dash', () => {
  const [first, continuation, wrapped] = missingDashDialogueLines();
  const combined = {
    ...first, text: first.text + continuation.text, words: [...first.words, ...continuation.words],
  };
  for (const lines of [[first, continuation, wrapped], [combined, wrapped]]) {
    const original = structuredClone(lines);
    const prepared = prepareTextLines(lines, viewport);

    assert.equal(detectTextBlocks(prepared, undefined, null, viewport).blockCount, 1);
    assert.deepEqual(prepared.map(line => line.text), lines.map(line => line.text));
    assert.deepEqual(prepareTextLines(prepared, viewport), prepared);
    assert.deepEqual(lines, original);
  }
});

test('reported dialogue spacing allowance still separates a wider same-row gap', () => {
  const [first, continuation, wrapped] = missingDashDialogueLines();
  for (const rect of [continuation.bounding_rect, ...continuation.words.map(word => word.bounding_rect)]) {
    rect.x1 += 0.01;
    rect.x3 += 0.01;
  }
  const prepared = prepareTextLines([first, continuation, wrapped], viewport);

  assert.equal(detectTextBlocks(prepared, undefined, null, viewport).blockCount, 2);
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
