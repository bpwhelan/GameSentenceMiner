const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { between } = require('./helpers/overlay-startup.cjs');

function setup(t) {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.innerWidth = 1000;
  window.innerHeight = 800;
  window.eval(fs.readFileSync(path.join(__dirname, '../window_occlusion.js'), 'utf8'));
  const controller = window.GSMWindowOcclusion;
  controller.setDisplayInfo({ physicalBounds: { x: -2000, y: -200, width: 2000, height: 1600 } });
  let reads = 0;
  const box = (left, top, className = 'text-box', parent = window.document.body) => {
    const node = window.document.createElement('span');
    node.className = className;
    node.textContent = '猫';
    node.getBoundingClientRect = () => {
      reads++;
      return { left, top, right: left + 20, bottom: top + 20, width: 20, height: 20 };
    };
    parent.appendChild(node);
    return node;
  };
  const update = rects => controller.update({ data: 'background', occlusion_rects: rects });
  const cover = { left: -1810, top: 0, right: -1760, bottom: 100 };
  const hidden = node => window.getComputedStyle(node).visibility === 'hidden';
  return { window, controller, box, update, cover, hidden, get reads() { return reads; } };
}

test('coverage hides only intersecting text and notation on a scaled negative-origin monitor', t => {
  const c = setup(t);
  const covered = c.box(100, 100);
  const visible = c.box(120, 100); // Touching the cover edge is not an overlap.
  const furigana = c.box(100, 100, 'furigana-box');
  const highlight = c.box(100, 100, 'gsm-jiten-hl');
  const popup = c.box(100, 100, 'yomitan-popup');
  const control = c.box(100, 100, 'interactive');
  c.update([c.cover]);
  assert.equal(c.hidden(covered), true);
  assert.equal(c.window.getComputedStyle(covered).pointerEvents, 'none');
  assert.equal(c.hidden(furigana), true);
  assert.equal(c.hidden(highlight), true);
  for (const node of [visible, popup, control]) assert.equal(c.hidden(node), false);
  assert.equal(covered.textContent, '猫');
});

test('unchanged coverage does no layout work; uncovered text keeps its original styling', t => {
  const c = setup(t);
  const covered = c.box(100, 100);
  covered.style.display = 'none';
  covered.style.visibility = 'visible';
  c.update([c.cover]);
  const reads = c.reads;
  c.update([c.cover]);
  assert.equal(c.reads, reads);
  c.update([]);
  assert.equal(c.reads, reads);
  assert.equal(covered.style.display, 'none');
  assert.equal(covered.style.visibility, 'visible');
  assert.equal(covered.classList.contains('gsm-window-occluded'), false);
  c.controller.refresh();
  assert.equal(c.reads, reads);
});

test('new and recalibrated text uses cached coverage, including deferred notation', t => {
  const c = setup(t);
  c.update([c.cover]);
  const covered = c.box(100, 100);
  const layer = c.window.document.createElement('div');
  c.window.document.body.appendChild(layer);
  const notation = c.box(100, 100, 'furigana-box', layer);
  c.controller.refresh();
  assert.equal(c.hidden(covered), true);
  assert.equal(c.hidden(notation), true);
  covered.getBoundingClientRect = () => ({ left: 500, top: 100, right: 520, bottom: 120 });
  c.controller.refresh();
  assert.equal(c.hidden(covered), false);
  c.update([]);
  assert.equal(c.hidden(notation), false);
});

test('display changes remap cached physical rectangles without stale hiding', t => {
  const c = setup(t);
  const covered = c.box(100, 100);
  c.update([c.cover]);
  assert.equal(c.hidden(covered), true);
  c.controller.setDisplayInfo({ physicalBounds: { x: 0, y: 0, width: 1000, height: 800 } });
  assert.equal(c.hidden(covered), false);
});

test('missing coverage from non-Windows or non-window capture clears previous masks', t => {
  const c = setup(t);
  const covered = c.box(100, 100);
  c.update([c.cover]);
  c.controller.update({ data: 'background', target_window_rect: null });
  assert.equal(c.hidden(covered), false);
});

test('changing the setting restores lookups immediately and reuses the last coverage', t => {
  const c = setup(t);
  const covered = c.box(100, 100);
  c.update([c.cover]);
  c.controller.setHideCoveredText(false);
  assert.equal(c.hidden(covered), false);
  assert.equal(c.window.getComputedStyle(covered).pointerEvents, 'auto');
  c.controller.setHideCoveredText(true);
  assert.equal(c.hidden(covered), true);
  c.controller.setHideCoveredText(false);
  c.update([]);
  c.controller.setHideCoveredText(true);
  assert.equal(c.hidden(covered), false);
});

test('only actual text overlaps report their window, once across redraws and partial refreshes', t => {
  const c = setup(t);
  const messages = [];
  c.window.ipcRenderer = { send: (...args) => messages.push(args) };
  const blocker = { ...c.cover, hwnd: 42, pid: 12, window_class: 'HotkeyOSD' };
  c.box(100, 100, 'line-box');
  c.update([blocker]);
  assert.equal(messages.length, 0);
  c.controller.setHideCoveredText(false);
  const first = c.box(100, 100);
  c.box(101, 100);
  c.controller.refresh();
  assert.equal(c.hidden(first), false);
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [
    ['overlay-text-covered', [{ window: blocker, textBoxes: 2, hidingEnabled: false }]],
  ]);
  first.remove();
  c.box(100, 100);
  c.controller.refresh(first);
  c.update([{ ...blocker, bottom: blocker.bottom + 5 }]);
  c.controller.refresh();
  assert.equal(messages.length, 1);
});

test('flashing and overlapping windows are coalesced without losing a short-lived blocker', t => {
  const c = setup(t);
  const messages = [];
  const timers = [];
  c.window.ipcRenderer = { send: (_, reports) => messages.push(Array.from(reports, r => r.window.hwnd)) };
  c.window.setTimeout = (callback, delay) => {
    timers.push({ callback, delay });
    return timers.length;
  };
  c.box(100, 100);
  const a = { ...c.cover, hwnd: 1, pid: 10 };
  const b = { ...c.cover, hwnd: 2, pid: 10 };
  c.update([a]);
  c.update([a, b]);
  c.update([]);
  c.update([b]);
  c.update([]);
  assert.deepEqual(messages, [[1]]);
  assert.equal(timers.length, 1);
  assert.ok(timers[0].delay > 0 && timers[0].delay <= 5000);
  timers[0].callback();
  assert.deepEqual(messages, [[1], [2]]);
});

test('controller navigation rejects occluded lookup and navigation boxes', t => {
  const c = setup(t);
  c.window.eval(fs.readFileSync(path.join(__dirname, '../gamepad.js'), 'utf8'));
  const handler = Object.create(c.window.GamepadHandler.prototype);
  const covered = c.box(100, 100);
  const navigation = c.box(100, 100, 'nav-char-box');
  const visible = c.box(300, 100);
  for (const node of [covered, navigation, visible]) node.getClientRects = () => [node.getBoundingClientRect()];
  c.update([c.cover]);
  assert.equal(handler.isTextBoxSelectable(covered), false);
  assert.equal(handler.isTextBoxSelectable(navigation), false);
  assert.equal(handler.isTextBoxSelectable(visible), true);
  c.update([]);
  assert.equal(handler.isTextBoxSelectable(covered), true);
});

test('coverage-only websocket updates do not repeat main-process show/focus work', async t => {
  const c = setup(t);
  const sent = [];
  c.window.ipcRenderer = { send: (...args) => sent.push(args) };
  c.window.eval(`
    const isMagpieActive = false, currentMagpieInfo = null;
    const dispatchOverlayPayloadEvent = (name, data) => window.dispatchEvent(new CustomEvent(name, { detail: data }));
    ${between(fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8'), '  let lastOverlayWindowStateSignature =', '  ipcRenderer.on("overlay-websocket-data"')}
    window.receiveWindowState = handleOverlayWebSocketData;
  `);
  const covered = c.box(100, 100);
  await c.window.receiveWindowState({ type: 'window_state', data: 'background', occlusion_rects: [] });
  assert.deepEqual(sent.map(([channel]) => channel), ['window-state-changed']);
  await c.window.receiveWindowState({ type: 'window_state', data: 'background', occlusion_rects: [c.cover] });
  assert.deepEqual(sent.map(([channel]) => channel), ['window-state-changed', 'overlay-text-covered']);
  assert.equal(c.hidden(covered), true);
  await c.window.receiveWindowState({ type: 'window_state', data: 'active', occlusion_rects: [] });
  assert.deepEqual(sent.map(([channel]) => channel), ['window-state-changed', 'overlay-text-covered', 'window-state-changed']);
  assert.equal(c.hidden(covered), false);
});

test('block translations mask independently without hiding their full-screen parent', t => {
  const c = setup(t);
  const layer = c.window.document.createElement('div');
  layer.id = 'translation-display';
  layer.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 800 });
  c.window.document.body.appendChild(layer);
  const covered = c.box(100, 100, 'block-translation', layer);
  const visible = c.box(500, 100, 'block-translation', layer);
  c.update([c.cover]);
  assert.equal(c.hidden(covered), true);
  assert.equal(c.hidden(visible), false);
  assert.equal(c.hidden(layer), false);
});

test('revealing deferred furigana applies coverage after its layer becomes visible', t => {
  const c = setup(t);
  const layer = c.window.document.createElement('div');
  layer.style.display = 'none';
  c.window.document.body.appendChild(layer);
  const reading = c.box(100, 100, 'furigana-box', layer);
  reading.getBoundingClientRect = () => layer.style.display === 'none'
    ? { left: 0, top: 0, right: 0, bottom: 0 }
    : { left: 100, top: 100, right: 120, bottom: 120 };
  c.window.furiganaLayer = layer;
  c.window.shouldShowFuriganaLayer = () => true;
  c.window.eval(between(fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8'),
    '  function updateFuriganaVisibilityState()', '  function clearFuriganaAutoHideTimer()'));
  c.update([c.cover]);
  assert.equal(reading.classList.contains('gsm-window-occluded'), false);
  c.window.updateFuriganaVisibilityState();
  assert.equal(c.hidden(reading), true);
});
