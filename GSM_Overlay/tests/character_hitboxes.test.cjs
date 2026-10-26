const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { rendererFixtureSource, overlayRoot, readRenderer } = require('./helpers/overlay-render.cjs');

const width = 1920, height = 1080;

function setup(t) {
  const { window } = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  t.after(() => window.close());
  Object.defineProperty(window, 'innerWidth', { value: width });
  Object.defineProperty(window, 'innerHeight', { value: height });
  window.HTMLElement.prototype.getBoundingClientRect = () => new window.DOMRect();
  window.eval(rendererFixtureSource(readRenderer(), fs.readFileSync(path.join(overlayRoot, 'block_detection.js'), 'utf8')));
  return window;
}

function glyph(text, x, y = 200, w = 34, h = 56) {
  return { text, bounding_rect: { x1: x / width, y1: y / height, x3: (x + w) / width, y3: (y + h) / height } };
}

function payload(words, isVertical = false) {
  return { data: [{
    text: words.map(word => word.text).join(''), words, isVertical,
    bounding_rect: {
      x1: Math.min(...words.map(word => word.bounding_rect.x1)),
      y1: Math.min(...words.map(word => word.bounding_rect.y1)),
      x3: Math.max(...words.map(word => word.bounding_rect.x3)),
      y3: Math.max(...words.map(word => word.bounding_rect.y3)),
    },
  }] };
}

function bounds(box) {
  const left = parseFloat(box.style.left) * width / 100;
  const top = parseFloat(box.style.top) * height / 100;
  const w = parseFloat(box.style.width) * width / 100;
  const h = parseFloat(box.style.height) * height / 100;
  return { left, top, right: left + w, bottom: top + h, width: w, height: h };
}

function boxes(window) {
  return [...window.document.querySelectorAll('.text-box')].filter(box => box.textContent.trim());
}

test('thin Japanese character boxes extend rightward while preserving every recognized start', t => {
  const window = setup(t);
  const source = payload(Array.from('なんで本当').map((text, i) => glyph(text, 100 + i * 52)));
  const original = JSON.stringify(source);
  window.renderFixture(source);
  const rendered = boxes(window);
  const rects = rendered.map(bounds);
  const target = rects[3];
  assert.ok(target.width > 45, 'the 34px-wide 本 box should cover more of its 56px-tall character');
  assert.ok(target.right > 290, 'extend the right edge of a thin glyph');
  for (let i = 0; i < rects.length; i++) {
    assert.ok(Math.abs(rects[i].left - (100 + i * 52)) < 1e-8, 'every recognized left edge must stay fixed');
  }
  for (let i = 1; i < rects.length; i++) {
    assert.ok(rects[i - 1].right <= rects[i].left + 1e-8, 'neighboring lookup boxes must not overlap');
    assert.ok(rects[i].left - rects[i - 1].right < 6, 'extend most of the small gap toward the next recognized start');
  }
  assert.ok(Math.abs(rects[0].left - 100) < 1e-8, 'do not expand beyond the line start');
  assert.ok(Math.abs(rects.at(-1).right - 342) < 1e-8, 'do not expand beyond the line end');
  assert.equal(rendered.map(box => box.textContent).join(''), source.data[0].text);
  assert.equal(JSON.stringify(source), original);

  // Repeated OCR must keep the nodes held by a pending dictionary lookup and
  // recompute padding from source bounds, without accumulating it each frame.
  const textNode = rendered[3].firstChild;
  const range = window.document.createRange();
  range.selectNodeContents(textNode);
  window.renderFixture(source);
  assert.equal(boxes(window)[3], rendered[3]);
  assert.equal(boxes(window)[3].firstChild, textNode);
  assert.equal(range.toString(), '本');
  assert.deepEqual(boxes(window).map(bounds), rects);

  const adjacent = payload(Array.from('なんで本当').map((text, i) => glyph(text, 100 + i * 34)));
  window.renderFixture(adjacent);
  assert.equal(boxes(window)[3].firstChild, textNode);
  for (const box of boxes(window)) {
    assert.ok(Math.abs(bounds(box).width - 34) < 1e-8);
    assert.equal(box.style.letterSpacing, '', 'discard the previous text fitting when padding is no longer needed');
  }
});

test('vertical Chinese text extends downward while preserving every recognized top', t => {
  const window = setup(t);
  window.renderFixture(payload(Array.from('中文字符').map((text, i) => glyph(text, 100, 200 + i * 52, 56, 34)), true));
  const rects = boxes(window).map(bounds);
  assert.ok(rects[1].height > 45);
  assert.ok(Math.abs(rects[1].width - 56) < 1e-8);
  for (let i = 0; i < rects.length; i++) {
    assert.ok(Math.abs(rects[i].top - (200 + i * 52)) < 1e-8, 'every recognized top edge must stay fixed');
  }
  for (let i = 1; i < rects.length; i++) assert.ok(rects[i - 1].bottom <= rects[i].top + 1e-8);
});

test('punctuation, half-width kana, Latin letters and Korean keep their original widths', t => {
  const window = setup(t);
  for (const text of ['「本。」', 'ｶﾅ本A', '한국文字']) {
    window.resetFixture();
    const words = Array.from(text).map((char, i) => glyph(char, 100 + i * 52));
    window.renderFixture(payload(words));
    for (const box of boxes(window)) {
      if (box.textContent === '本') continue;
      assert.ok(Math.abs(bounds(box).width - 34) < 1e-8, `${text}: preserve ${box.textContent}`);
    }
  }
});

test('whitespace and large gaps stay open, and adjacent or overlapping OCR boxes never grow', t => {
  const window = setup(t);
  for (const words of [
    [glyph('本', 100), glyph(' ', 140, 200, 18), glyph('当', 164)],
    [glyph('本', 100), glyph('当', 200)],
    [glyph('本', 100), glyph('当', 134)],
    [glyph('本', 100), glyph('当', 130)],
  ]) {
    window.resetFixture();
    window.renderFixture(payload(words));
    for (const box of boxes(window)) assert.ok(Math.abs(bounds(box).width - 34) < 1e-8);
  }
});

test('very narrow glyphs get only a bounded rightward expansion even with room on both sides', t => {
  const window = setup(t);
  window.renderFixture(payload([glyph('本', 100), glyph('し', 158, 200, 8), glyph('当', 190)]));
  const target = bounds(boxes(window)[1]);
  assert.ok(target.width > 9);
  assert.ok(Math.abs(target.left - 158) < 1e-8);
  assert.ok(target.width <= 8 + 56 * 0.4 + 1e-8, 'the right edge can grow by at most 40% of the glyph height');
});

test('full-width cells and subdivided word boxes retain their original geometry', t => {
  const window = setup(t);
  for (const words of [
    Array.from('本当').map((text, i) => glyph(text, 100 + i * 66, 200, 56)),
    [glyph('本当', 100, 200, 112)],
  ]) {
    window.resetFixture();
    window.renderFixture(payload(words));
    for (const box of boxes(window)) {
      assert.ok(Math.abs(bounds(box).width - 56) < 1e-8);
      assert.equal(box.style.letterSpacing, '');
    }
  }
});
