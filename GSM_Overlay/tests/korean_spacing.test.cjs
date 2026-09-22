const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { rendererFixtureSource, line, overlayRoot, readRenderer } = require('./helpers/overlay-render.cjs');

const sentence = '음성 파일 다운로드가 완료되었습니다.';

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

function ocrLine(text, fragments, y = 0.4) {
  let offset = 0;
  const words = fragments.map(fragment => {
    const start = text.indexOf(fragment, offset);
    assert.ok(start >= offset);
    offset = start + fragment.length;
    return line(fragment, 0.1 + start * 0.015, y, fragment.length * 0.015, 0.035).words[0];
  });
  return { text, words, bounding_rect: { x1: 0.1, y1: y, x3: 0.1 + text.length * 0.015, y3: y + 0.035 } };
}

for (const [name, fragments] of [
  ['word boxes', sentence.split(' ')],
  ['character boxes', Array.from(sentence.replace(/ /g, ''))],
  ['existing separators', sentence.match(/\S+\s*/gu)],
  ['mixed word and character boxes', ['음성', '파', '일', '다운로드가', '완료되었습니다.']],
  ['Lens fragments and separators', ['음성 ', '파', '일 ', '다운로드가 ', '완료되었습니다.']],
]) {
  test(`Korean lookup text retains word boundaries with ${name}`, t => {
    const window = setup(t);
    const payload = { data: [ocrLine(sentence, fragments)] };
    const original = JSON.stringify(payload);
    window.renderFixture(payload);
    const block = window.document.querySelector('.text-block-container');
    assert.equal(block.textContent, sentence);
    assert.ok(block.textContent.includes('일 다'), 'lookup must not combine 일 with 다 from the next word');
    if (name === 'word boxes' || name === 'character boxes') {
      const boxes = [...block.querySelectorAll('.text-box')];
      const lastFileSyllable = boxes.find(box => box.textContent === '일');
      assert.ok(lastFileSyllable, 'keep per-syllable lookup boxes aligned with Korean glyphs');
      assert.ok(Math.abs(parseFloat(lastFileSyllable.style.left) - 16) < 1e-8);
      assert.ok(Math.abs(parseFloat(lastFileSyllable.style.width) - 1.5) < 1e-8);
    }
    assert.equal(JSON.stringify(payload), original);
  });
}

test('Korean containing Hanja and Latin words preserves only the source boundaries', t => {
  const window = setup(t);
  const text = '韓國 파일 GSM입니다.';
  window.renderFixture({ data: [ocrLine(text, ['韓國', '파일', 'GSM', '입니다', '.'])] });
  assert.equal(window.document.querySelector('.text-block-container').textContent, text);
});

test('Korean line wrapping keeps a word boundary in the lookup block', t => {
  const window = setup(t);
  window.renderFixture({ data: [
    ocrLine('음성 파일', ['음성', '파일'], 0.4),
    ocrLine('다운로드가 완료되었습니다.', ['다운로드가', '완료되었습니다.'], 0.445),
  ] });
  const blocks = [...window.document.querySelectorAll('.text-block-container')];
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].textContent, sentence);
});

test('Yomitan scans the Korean space between separately positioned syllables', t => {
  const window = setup(t);
  // Exercise the bundled scanner without modifying generated Yomitan files.
  const strings = fs.readFileSync(path.join(overlayRoot, 'yomitan/js/data/string-util.js'), 'utf8');
  const scanner = fs.readFileSync(path.join(overlayRoot, 'yomitan/js/dom/dom-text-scanner.js'), 'utf8');
  window.eval(`
    ${strings.replace(/^export /gm, '')}
    ${scanner.replace(/^import .*;\r?\n/gm, '').replace('export class DOMTextScanner', 'class DOMTextScanner')}
    window.DOMTextScanner = DOMTextScanner;
  `);
  window.renderFixture({ data: [ocrLine(sentence, sentence.split(' '))] });
  const syllable = [...window.document.querySelectorAll('.text-box')].find(box => box.textContent === '일');
  // Overlay scanning disables layout-generated newlines between absolute boxes.
  const scan = new window.DOMTextScanner(syllable.firstChild, 0, false, false);
  assert.equal(scan.seek(3).content, '일 다');
});

for (const text of ['音声ファイル', '音频文件']) {
  test(`unspaced lookup text stays unchanged: ${text}`, t => {
    const window = setup(t);
    window.renderFixture({ data: [ocrLine(text, Array.from(text))] });
    assert.equal(window.document.querySelector('.text-block-container').textContent, text);
  });
}
