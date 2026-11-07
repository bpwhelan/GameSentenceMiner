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
  Object.defineProperty(window, 'innerWidth', { value: 1280 });
  Object.defineProperty(window, 'innerHeight', { value: 800 });
  window.HTMLElement.prototype.getBoundingClientRect = () => new window.DOMRect();
  const html = readRenderer();
  const offsetFunction = html.includes('  function updateOverlayTextOffsets(')
    ? between(html, '  function updateOverlayTextOffsets(', '  ipcRenderer.on("settings-updated",')
    : '';
  const settingsHandler = between(html, '  ipcRenderer.on("settings-updated",', '  function updateManualMode(');
  const fixture = rendererFixtureSource(html, fs.readFileSync(path.join(overlayRoot, 'block_detection.js'), 'utf8'));
  window.eval(fixture.replace('    window.renderFixture =', `
    const ipcRenderer = { on(channel, handler) { window.applySettings = settings => handler(null, settings); } };
    const textHover = { refresh() {} };
    let lastFuriganaRenderSignature = null;
    const completeGamepadOverlayTextRender = () => {};
    ${offsetFunction}
    ${settingsHandler}
    window.renderFixture =`));
  return window;
}

const payload = { data: [line('日本語', 0.1, 0.4, 0.15, 0.04, false, true)] };

function position(node) {
  return [parseFloat(node.style.left), parseFloat(node.style.top)];
}

function assertMoved(node, before, dx, dy) {
  const after = position(node);
  assert.ok(Math.abs(after[0] - before[0] - dx) < 1e-8, `X: ${before[0]} -> ${after[0]}, expected delta ${dx}`);
  assert.ok(Math.abs(after[1] - before[1] - dy) < 1e-8, `Y: ${before[1]} -> ${after[1]}, expected delta ${dy}`);
}

test('offset settings move existing OCR text and indicators without another OCR result', t => {
  const window = setup(t);
  window.renderFixture(payload);
  const box = window.document.querySelector('.text-box');
  const indicator = window.document.querySelector('.line-box');
  const original = [position(box), position(indicator)];
  const textNode = box.firstChild;
  const lookup = window.document.createRange();
  lookup.selectNodeContents(textNode);

  window.applySettings({ offsetX: 2.5, offsetY: -1.25 });
  assertMoved(box, original[0], 2.5, -1.25);
  assertMoved(indicator, original[1], 2.5, -1.25);
  assert.equal(window.document.querySelector('.text-box'), box);
  assert.equal(box.firstChild, textNode);
  assert.equal(lookup.toString(), '日');

  window.applySettings({ offsetX: 2.5, offsetY: -1.25 });
  assertMoved(box, original[0], 2.5, -1.25);
  window.applySettings({ offsetY: 3 });
  assertMoved(box, original[0], 2.5, 3);
  window.applySettings({ offsetX: 0, offsetY: 0 });
  assertMoved(box, original[0], 0, 0);
  assertMoved(indicator, original[1], 0, 0);
});

test('calibration moves notation and navigation while refreshing dependent geometry', t => {
  const window = setup(t);
  window.renderFixture(payload, { recycled: true });
  const decorations = ['furigana-box', 'nav-char-box'].map(className => {
    const node = window.document.createElement('span');
    node.className = className;
    node.style.left = '10%';
    node.style.top = '40%';
    window.document.body.appendChild(node);
    return node;
  });
  decorations.push(window.document.querySelector('.recycled-indicator'));
  const before = decorations.map(position);
  let highlights = 0, occlusion = 0, stats = 0;
  window.GsmJitenHighlight = { reposition() { highlights++; } };
  window.GSMWindowOcclusion = { refresh() { occlusion++; } };
  window.GSMLiveStatsWidget = { handleTextBoundsUpdate(boxes) { stats = boxes.length; } };

  // The helper saves both axes in one settings-updated message.
  window.applySettings({ offsetX: -4, offsetY: 2 });
  decorations.forEach((node, index) => assertMoved(node, before[index], -4, 2));
  assert.equal(highlights, 1);
  assert.equal(occlusion, 1);
  assert.equal(stats, window.document.querySelectorAll('.text-box').length);
});

test('recycled markers start aligned with an already calibrated frame', t => {
  const window = setup(t);
  window.renderFixture(payload, { recycled: true });
  const before = position(window.document.querySelector('.recycled-indicator'));
  window.renderFixture(payload, { offsetX: 3, offsetY: -2, recycled: true });
  assertMoved(window.document.querySelector('.recycled-indicator'), before, 3, -2);
});

test('fresh OCR uses the new offsets once and repeated settings do not accumulate them', t => {
  const window = setup(t);
  window.renderFixture(payload);
  window.applySettings({ offsetX: 1.5, offsetY: -2 });
  const shifted = position(window.document.querySelector('.text-box'));
  window.renderFixture(payload, { offsetX: 1.5, offsetY: -2 });
  assert.deepEqual(position(window.document.querySelector('.text-box')), shifted);
  window.applySettings({ offsetX: 1.5, offsetY: -2 });
  assert.deepEqual(position(window.document.querySelector('.text-box')), shifted);
});
