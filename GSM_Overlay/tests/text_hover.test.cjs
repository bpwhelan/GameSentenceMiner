const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTextHoverController, isClickableHoverTarget } = require('../text_hover');

function target(matches) {
  return { isConnected: true, events: [], closest(selector) {
    return selector.split(',').some(s => matches.includes(s.trim())) ? this : null;
  }, dispatchEvent(event) { this.events.push(event); } };
}

test('game text and padded text regions pass clicks; real controls and dictionary frames capture', () => {
  for (const matches of [['.text-box', '.interactive'], ['.nav-char-box'], ['.big-interactive-area', '.interactive'], ['#text', '.interactive'], []]) {
    assert.equal(isClickableHoverTarget(target(matches)), false);
  }
  for (const match of ['button', 'a[href]', 'input', '.interactive', 'iframe.yomitan-popup', 'yomitan-popup-tag-name', 'hachidori-host']) {
    assert.equal(isClickableHoverTarget(target([match])), true, match);
  }
  assert.equal(isClickableHoverTarget(target(['button', '.text-box'])), true);
});

function setup(clickThrough = true) {
  const listeners = new Map(), ignores = [], hoverStates = [];
  let current = target(['.text-box', '.interactive']);
  const win = {
    innerWidth: 960, innerHeight: 540,
    addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener() {},
    PointerEvent: class { constructor(type, init) { Object.assign(this, init, { type }); } },
    MouseEvent: class { constructor(type, init) { Object.assign(this, init, { type }); } },
    CustomEvent: class { constructor(type, init) { Object.assign(this, init, { type }); } },
    dispatchEvent(event) { if (event.type === 'gsm-overlay-hover') hoverStates.push(event.detail); },
  };
  const document = { documentElement: { dataset: {} }, elementFromPoint: () => current };
  const controller = createTextHoverController({ window: win,
    document, isClickThroughEnabled: () => clickThrough, onIgnore: value => ignores.push(value) });
  return { controller, ignores, document, hoverStates, setClickThrough: value => { clickThrough = value; },
    get target() { return current; }, setTarget: value => { current = value; },
    move: (x, y, buttons = 0) => listeners.get('pointermove')({ type: 'pointermove', clientX: x, clientY: y, buttons }),
    listeners };
}

test('forwarded text hover remains click-through while a popup can be entered and left', () => {
  const f = setup();
  f.move(20, 20);
  assert.deepEqual(f.ignores, [true]);
  f.setTarget(target(['iframe.yomitan-popup']));
  f.move(40, 40);
  assert.deepEqual(f.ignores, [true, false]);
  f.setTarget(target(['.text-box', '.interactive']));
  f.move(20, 20);
  assert.deepEqual(f.ignores, [true, false, true]);
});

test('hover reports leaving the viewport even when no DOM target can receive a scan', () => {
  const f = setup();
  f.controller.project({ x: 200, y: 100, captured: true });
  assert.equal(f.hoverStates.at(-1)?.overText, true);
  f.setTarget(target(['iframe.yomitan-popup']));
  f.controller.project({ x: 300, y: 200, captured: false });
  assert.equal(f.hoverStates.at(-1)?.overPopup, true);
  f.controller.project({ x: -1, y: -1, captured: true });
  assert.deepEqual(f.hoverStates.at(-1), { active: true, x: -1, y: -1, overText: false, overPopup: false });
  const count = f.hoverStates.length;
  f.controller.project({ x: -1, y: -1, captured: true });
  assert.equal(f.hoverStates.length, count, 'stationary samples do not restart auto-hide');
  f.controller.reset();
  assert.equal(f.hoverStates.at(-1).active, false, 'explicit interaction restores normal reader behavior');
});

test('click-through can be disabled without disabling Magpie projection', () => {
  const f = setup(false);
  f.move(20, 20);
  assert.deepEqual(f.ignores, [false]);
  assert.equal(f.controller.project({ x: 200, y: 100, captured: true }), true);
  assert.ok(f.target.events.some(e => e.type === 'pointermove' && e.clientX === 200));
  f.setClickThrough(true);
  assert.equal(f.controller.project({ x: 200, y: 100, captured: true }), false);
});

test('captured cursor state reaches popup scanners and is cleared on explicit interaction', () => {
  const f = setup();
  const messages = [];
  const frame = { postMessage: message => messages.push(message) };
  f.controller.project({ x: 200, y: 100, captured: true });
  f.listeners.get('message')({ data: { type: 'gsm-magpie-pointer-state-request' }, source: frame });
  assert.deepEqual(messages.at(-1), { type: 'gsm-magpie-pointer-state', captured: true });
  f.controller.project({ x: 200, y: 100, captured: false });
  assert.equal(messages.at(-1).captured, false);
  f.controller.project({ x: 200, y: 100, captured: true });
  f.controller.reset();
  assert.equal(messages.at(-1).captured, false);
  frame.closed = true;
  const count = messages.length;
  f.controller.project({ x: 200, y: 100, captured: true });
  assert.equal(messages.length, count, 'closed popup frames are discarded');
});

test('a captured raw cursor cannot scan the projected popup or its shadow host', () => {
  const f = setup();
  f.setTarget(target(['hachidori-host']));
  f.controller.project({ x: 200, y: 100, captured: true });
  let stopped = false;
  f.listeners.get('pointermove')({ target: f.target, clientX: 100, clientY: 50,
    stopImmediatePropagation() { stopped = true; } });
  assert.equal(stopped, true);
  f.controller.project({ x: 200, y: 100, captured: false });
  stopped = false;
  f.listeners.get('pointermove')({ target: f.target, clientX: 200, clientY: 100,
    stopImmediatePropagation() { stopped = true; } });
  assert.equal(stopped, false, 'real popup interaction resumes after Magpie releases capture');
});

test('a button press stays with its original owner until release', () => {
  const f = setup();
  f.move(20, 20);
  f.setTarget(target(['button']));
  f.move(40, 40, 1);
  assert.deepEqual(f.ignores, [true]);
  f.move(40, 40, 0);
  assert.deepEqual(f.ignores, [true, false]);
  f.setTarget(target(['.text-box']));
  f.move(20, 20, 1);
  assert.deepEqual(f.ignores, [true, false]);
  f.move(20, 20, 0);
  assert.deepEqual(f.ignores, [true, false, true]);
});

test('projected hover supplies dictionary pointer movement without synthesizing clicks or repeatedly resetting its delay', () => {
  const f = setup();
  const sample = { x: 200, y: 100, buttons: 0, shiftKey: true };
  assert.equal(f.controller.project(sample), false);
  const events = f.target.events;
  assert.ok(events.some(e => e.type === 'pointermove' && e.clientX === 200 && e.shiftKey && e.pointerType === 'mouse' && e.isPrimary));
  assert.ok(events.some(e => e.type === 'mousemove'));
  const count = events.length;
  f.controller.project(sample);
  assert.equal(events.length, count);
  f.controller.project({ ...sample, ctrlKey: true });
  assert.ok(events.length > count, 'modifier-only changes must reach the scanner');
  assert.ok(events.every(e => !['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup'].includes(e.type)));
  assert.deepEqual(f.ignores, [], 'projected ownership is acknowledged through its sequenced native session');
});

test('raw source-coordinate movement cannot race projected movement', () => {
  const f = setup();
  f.controller.project({ x: 200, y: 100 });
  let stopped = false;
  f.listeners.get('pointermove')({ clientX: 10, clientY: 10, stopImmediatePropagation() { stopped = true; } });
  assert.equal(stopped, true);
  assert.deepEqual(f.ignores, []);
  f.controller.reset();
  assert.ok(f.target.events.some(e => e.type === 'pointerout'), 'mode changes cancel the old delayed hover');
  f.move(10, 10);
  assert.deepEqual(f.ignores, [true]);
});

test('leaving text cancels pending hover and hidden or removed controls release input on refresh', () => {
  const f = setup();
  const text = f.target;
  f.controller.project({ x: 200, y: 100 });
  f.setTarget(null);
  f.controller.project({ x: -1, y: -1 });
  assert.ok(text.events.some(e => e.type === 'pointerout'));
  f.controller.reset();
  f.setTarget(target(['button']));
  f.move(20, 20);
  f.setTarget(null);
  f.controller.refresh();
  assert.deepEqual(f.ignores, [false, true]);
});
