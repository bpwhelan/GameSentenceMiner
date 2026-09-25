const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { rendererFixtureSource, line, overlayRoot, readRenderer } = require('./helpers/overlay-render.cjs');

function setup(t) {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom;
  Object.defineProperty(window, 'innerWidth', { value: 1920 });
  Object.defineProperty(window, 'innerHeight', { value: 1080 });
  window.HTMLElement.prototype.getBoundingClientRect = () => new window.DOMRect();
  window.eval(rendererFixtureSource(readRenderer(), fs.readFileSync(path.join(overlayRoot, 'block_detection.js'), 'utf8')));
  return window;
}

test('Japanese lookup crosses a wrapped line despite an extra OCR whitespace box', t => {
  const window = setup(t);
  const first = line('やさか', 0.1, 0.4, 0.12, 0.04, false, true);
  const second = line('い、', 0.1, 0.45, 0.06, 0.04, false, true);
  first.words.push({ text: ' ', bounding_rect: {
    x1: first.bounding_rect.x3, y1: first.bounding_rect.y1,
    x3: first.bounding_rect.x3, y3: first.bounding_rect.y3,
  } });
  const payload = { data: [first, second] };
  const original = JSON.stringify(payload);
  window.renderFixture(payload);

  const blocks = [...window.document.querySelectorAll('.text-block-container')];
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].dataset.translationSource, 'やさか\nい、');
  assert.equal(blocks[0].textContent, 'やさかい、');
  assert.equal(JSON.stringify(payload), original, 'rendering must not modify OCR data');

  const strings = fs.readFileSync(path.join(overlayRoot, 'yomitan/js/data/string-util.js'), 'utf8');
  const scanner = fs.readFileSync(path.join(overlayRoot, 'yomitan/js/dom/dom-text-scanner.js'), 'utf8');
  window.eval(`
    ${strings.replace(/^export /gm, '')}
    ${scanner.replace(/^import .*;\r?\n/gm, '').replace('export class DOMTextScanner', 'class DOMTextScanner')}
    window.DOMTextScanner = DOMTextScanner;
  `);
  const firstBox = blocks[0].querySelector('.text-box');
  const scan = new window.DOMTextScanner(firstBox.firstChild, 0, false, false);
  assert.equal(scan.seek(5).content, 'やさかい、');
});

test('Japanese source whitespace remains lookupable when OCR boxes omit it', t => {
  const window = setup(t);
  const spaced = line('やさ', 0.1, 0.4, 0.08, 0.04, false, true);
  spaced.text = 'や さ';
  window.renderFixture({ data: [spaced] });
  assert.equal(window.document.querySelector('.text-block-container').textContent, 'や さ');
});

test('Japanese lookup drops extra OCR whitespace when word coverage is inconsistent', t => {
  const window = setup(t);
  const first = line('わしら全員には固有の––【プロダクト｜Ｄ】が設定されと', 0.1, 0.775, 0.78, 0.05, false, true);
  first.words.push({ text: ' ', bounding_rect: {
    x1: first.bounding_rect.x3, y1: first.bounding_rect.y1,
    x3: first.bounding_rect.x3, y3: first.bounding_rect.y3,
  } });
  first.words.push({ text: '誤' });
  const second = line('る。できればそれで。色）', 0.1, 0.84, 0.33, 0.05, false, true);
  window.renderFixture({ data: [first, second] });
  const block = window.document.querySelector('.text-block-container');
  assert.equal(block.dataset.translationSource, `${first.text}\n${second.text}`);
  assert.equal(block.textContent, first.text + second.text);
});
