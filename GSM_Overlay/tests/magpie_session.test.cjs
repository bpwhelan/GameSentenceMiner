const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMagpieSession } = require('../magpie_session');
const { mapCursorToMagpie, mapPointToMagpie } = require('../magpie');

const info = {
  source_hwnd: 42, scaling_hwnd: 99, windowed: false,
  sourceWindowLeftEdgePosition: 320, sourceWindowTopEdgePosition: 196,
  sourceWindowRightEdgePosition: 2240, sourceWindowBottomEdgePosition: 1276,
  magpieWindowLeftEdgePosition: 0, magpieWindowTopEdgePosition: 0,
  magpieWindowRightEdgePosition: 2560, magpieWindowBottomEdgePosition: 1440,
};

function setup() {
  let notification, tick, blocked = false, visible = true;
  let snapshot = info;
  let cursor = { x: 1280, y: 736, captured: true };
  const events = [], samples = [], ignores = [], refreshes = [];
  const native = {
    watch(_win, callback) { notification = callback; return () => { notification = null; }; },
    read(expected) { return snapshot?.source_hwnd === expected ? snapshot : null; },
    cursor() { return cursor; },
  };
  const session = createMagpieSession({
    native, window: { isDestroyed: () => false, isVisible: () => visible },
    canTrackPointer: () => !blocked, onScaling: e => events.push(e),
    onPointer: p => samples.push(p), setIgnoreMouseEvents: v => ignores.push(v),
    requestRefresh: () => refreshes.push(true),
    setIntervalFn: fn => { tick = fn; return 1; }, clearIntervalFn: () => { tick = null; },
  });
  return { session, events, samples, ignores, refreshes,
    notify: (...args) => notification(...args), tick: () => tick?.(),
    setCursor: v => { cursor = v; }, setSnapshot: v => { snapshot = v; },
    setBlocked: v => { blocked = v; }, setVisible: v => { visible = v; },
    hasTimer: () => !!tick,
  };
}

test('starts mid-session, scopes native state to the selected game, and disposes', () => {
  const f = setup();
  f.session.updateTarget(7);
  assert.equal(f.hasTimer(), false);
  f.session.updateTarget(42);
  assert.equal(f.hasTimer(), true);
  assert.equal(f.events.at(-1).info.source_hwnd, 42);
  f.session.updateTarget(7);
  assert.equal(f.events.at(-1).info, null);
  assert.equal(f.hasTimer(), false);
  f.session.dispose();
});

test('projects the captured cursor into the visible image and only changes mouse ownership on a hit result', () => {
  const f = setup();
  f.session.updateTarget(42);
  f.tick();
  assert.equal(f.samples.at(-1).x, 1280);
  assert.equal(f.samples.at(-1).y, 720);
  assert.equal(f.ignores.length, 0);
  f.session.handleHit({ sequence: f.samples.at(-1).sequence, hit: true });
  assert.deepEqual(f.ignores, [false]);
  f.setCursor({ x: 1280, y: 720, captured: false });
  f.tick(); // Ignore the frame where Magpie is moving the hardware cursor.
  f.tick();
  f.session.handleHit({ sequence: f.samples.at(-1).sequence, hit: true });
  assert.deepEqual(f.ignores, [false]);
  f.setCursor({ x: 2400, y: 100, captured: false });
  f.tick();
  f.session.handleHit({ sequence: f.samples.at(-1).sequence, hit: false });
  assert.deepEqual(f.ignores, [false, true]);
});

test('queued pointer replies cannot release a dictionary, manual, or controller interaction', () => {
  const f = setup();
  f.session.updateTarget(42);
  f.tick();
  const reply = { sequence: f.samples.at(-1).sequence, hit: true };
  f.setBlocked(true);
  f.session.handleHit(reply);
  f.tick();
  assert.deepEqual(f.ignores, []);
  f.setBlocked(false);
  f.session.handleHit(reply);
  assert.deepEqual(f.ignores, []);
});

test('a button pressed during a renderer hit test keeps its native recipient until release', () => {
  const f = setup();
  f.session.updateTarget(42);
  f.tick();
  f.setCursor({ x: 1280, y: 736, captured: true, buttons: 1 });
  f.session.handleHit({ sequence: f.samples.at(-1).sequence, hit: true });
  assert.deepEqual(f.ignores, []);
  f.setCursor({ x: 1280, y: 736, captured: true, buttons: 0 });
  f.tick();
  f.session.handleHit({ sequence: f.samples.at(-1).sequence, hit: true });
  assert.deepEqual(f.ignores, [false]);
});

test('focus loss keeps geometry; end and unrelated scaling cannot raise this overlay', () => {
  const f = setup();
  f.session.updateTarget(42);
  f.notify(0, 1);
  assert.equal(f.events.at(-1).kind, 'background');
  assert.ok(f.events.at(-1).info);
  f.notify(1, 99);
  assert.equal(f.events.at(-1).kind, 'foreground');
  f.setSnapshot({ ...info, source_hwnd: 7 });
  f.notify(1, 99);
  assert.equal(f.events.at(-1).info, null);
  assert.ok(f.refreshes.length);
  f.setSnapshot(null);
  f.notify(0, 0);
  assert.equal(f.events.at(-1).info, null);
});

test('samples geometry during a windowed drag and stops on its completion', () => {
  const f = setup();
  f.session.updateTarget(42);
  f.notify(3, 99);
  f.setSnapshot({ ...info, magpieWindowLeftEdgePosition: -100 });
  f.tick();
  assert.equal(f.events.at(-1).info.magpieWindowLeftEdgePosition, -100);
  f.notify(2, 99);
  const count = f.events.length;
  f.tick();
  assert.equal(f.events.length, count);
});

test('pixel-center cursor mapping matches Magpie at both edges; drawing uses rectangle edges', () => {
  assert.deepEqual(mapCursorToMagpie({ x: 320, y: 196 }, info), { x: 0, y: 0 });
  assert.deepEqual(mapCursorToMagpie({ x: 2239, y: 1275 }, info), { x: 2559, y: 1439 });
  assert.deepEqual(mapPointToMagpie({ x: 2240, y: 1276 }, info), { x: 2560, y: 1440 });
  assert.equal(mapCursorToMagpie({ x: 2240, y: 1276 }, info), null);
});

test('scaling stop releases ordinary hover capture, but never a new interaction', () => {
  for (const blocked of [false, true]) {
    const f = setup();
    f.session.updateTarget(42);
    f.tick();
    f.session.handleHit({ sequence: f.samples.at(-1).sequence, hit: true });
    f.setBlocked(blocked);
    f.setSnapshot(null);
    f.notify(0, 0);
    assert.deepEqual(f.ignores, blocked ? [false] : [false, true]);
  }
});
