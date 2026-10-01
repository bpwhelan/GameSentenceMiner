const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

function setup(t, options = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  const { window } = dom;
  window.console.log = () => {};
  const timers = new Map();
  let now = 10000, sequence = 0;
  window.Date.now = () => now;
  window.setTimeout = (fn, delay = 0) => {
    timers.set(++sequence, { fn, at: now + delay });
    return sequence;
  };
  window.clearTimeout = id => timers.delete(id);
  const tick = duration => {
    const end = now + duration;
    for (let count = 0; count < 1000; count++) {
      const next = [...timers].filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) { now = end; return; }
      timers.delete(next[0]); now = next[1].at; next[1].fn();
    }
    throw new Error('Timer loop did not settle');
  };
  const sockets = [];
  window.WebSocket = class {
    static OPEN = 1;
    constructor() { this.readyState = 0; sockets.push(this); }
    send() {}
    close() { this.readyState = 3; }
  };
  for (const file of ['dictionary_navigation.js', 'gamepad.js']) {
    window.eval(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));
  }
  const handler = new window.GamepadHandler({ connectToServer: false,
    focusOverlayOnEntry: false, activationMode: 'toggle', ...options });
  t.after(() => { handler.destroy(); window.close(); });
  handler.completeNavigationActivation = () => { handler.pendingNavigationActivation = false; };
  const button = (index, pressed, device = 'pad') => handler.onButtonEvent({ device, button: index, pressed });
  const key = (name, pressed, modifiers = {}) => handler.onKeyboardEvent({ key: name, pressed, modifiers });
  return { handler, tick, timers, sockets, button, key, window };
}

test('retired sockets cannot clear a replacement or reconnect a destroyed handler', t => {
  const { handler, sockets, tick } = setup(t, { connectToServer: true });
  const first = sockets[0], staleClose = first.onclose;
  handler.disconnectWebSocket();
  handler.connectWebSocket();
  const second = sockets[1];
  staleClose();
  assert.equal(handler.ws, second);
  const secondClose = second.onclose;
  handler.destroy();
  secondClose();
  tick(10000);
  assert.equal(sockets.length, 2);
});

test('connecting twice shares the pending socket', t => {
  const { handler, sockets } = setup(t, { connectToServer: true });
  handler.connectWebSocket();
  assert.equal(sockets.length, 1);
});

test('server disconnect clears held inputs, active navigation and repeats', t => {
  const { handler, button, tick } = setup(t);
  handler.activateNavigation();
  let moves = 0;
  handler.navigateCursorRight = () => moves++;
  button(15, true);
  handler.onWebSocketClose();
  tick(1000);
  assert.equal(moves, 1);
  assert.equal(handler.isActive, false);
  assert.equal(handler.toggleModeActive, false);
  assert.equal(handler.buttonStates.size, 0);
  assert.equal(handler.repeatTimers.size, 0);
});

test('duplicate button and OS key-down events only fire an action once per press', t => {
  const { handler, key, button, tick } = setup(t);
  handler.activateNavigation();
  let confirms = 0;
  handler.confirmSelection = () => confirms++;
  button(0, true); button(0, true);
  key('Enter', true); key('Enter', true);
  tick(800);
  assert.equal(confirms, 2);
  button(0, false); button(0, true);
  key('Enter', false); key('Enter', true);
  assert.equal(confirms, 4);
});

test('manual exit stops repeats and resets toggle activation', t => {
  const { handler, button, tick } = setup(t);
  handler.activateNavigation();
  let moves = 0;
  handler.navigateCursorRight = () => moves++;
  button(15, true);
  handler.manualDeactivate();
  tick(1000);
  assert.equal(moves, 1);
  assert.equal(handler.isNavigationActive(), false);
  assert.equal(handler.repeatTimers.size, 0);
});

test('exit popup cleanup cannot close a popup after reactivation', t => {
  const { handler, tick } = setup(t);
  handler.activateNavigation();
  handler.deactivateNavigation();
  handler.activateNavigation();
  let closes = 0;
  handler.closeDictionaryPopups = () => closes++;
  tick(600);
  assert.equal(closes, 0);
});

test('keyboard release does not cancel navigation owned by a gamepad modifier', t => {
  const { handler, button, key } = setup(t, { activationMode: 'modifier', keyboardModifierKey: 'Ctrl' });
  button(4, true);
  assert.equal(handler.isActive, true);
  key('KeyQ', false);
  assert.equal(handler.isActive, true);
  handler.onGamepadDisconnected({ device: 'pad' });
  assert.equal(handler.isActive, false);
});

test('modifier-only keyboard actions ignore unrelated key presses', t => {
  const { handler, key, tick } = setup(t, { keyboardToggleKey: 'Ctrl' });
  key('ControlLeft', true, { ctrl: true });
  assert.equal(handler.isActive, true);
  tick(400);
  key('KeyQ', true, { ctrl: true });
  assert.equal(handler.isActive, true);
});

test('keyboard repeat stops when its configured chord is no longer held', t => {
  const { handler, key, tick } = setup(t, { keyboardNavigateRight: 'Ctrl+ArrowRight' });
  handler.activateNavigation();
  let moves = 0;
  handler.navigateCursorRight = () => moves++;
  key('ControlLeft', true, { ctrl: true });
  key('ArrowRight', true, { ctrl: true });
  key('ControlLeft', false);
  tick(1000);
  assert.equal(moves, 1);
  assert.equal(handler.repeatTimers.size, 0);
});

test('rebinding while held cancels the old repeat without inventing a new press', t => {
  const { handler, button, tick } = setup(t);
  handler.activateNavigation();
  let moves = 0;
  handler.navigateCursorRight = () => moves++;
  button(15, true);
  handler.updateConfig({ dpadRight: 22 });
  tick(1000);
  assert.equal(moves, 1);
  assert.equal(handler.repeatTimers.size, 0);
  button(22, true);
  assert.equal(moves, 2);
});

test('disconnecting another controller leaves the held repeat running', t => {
  const { handler, button, tick } = setup(t);
  handler.activateNavigation();
  let moves = 0;
  handler.navigateCursorRight = () => moves++;
  button(15, true);
  handler.onGamepadDisconnected({ device: 'unused-pad' });
  tick(400);
  assert.equal(moves, 2);
});

test('capture suppression stops repeats and requires fresh action presses', t => {
  const { handler, key, tick } = setup(t);
  handler.activateNavigation();
  let confirms = 0;
  handler.confirmSelection = () => confirms++;
  handler.setInputSuppressed(true);
  key('Enter', true);
  handler.setInputSuppressed(false);
  handler.activateNavigation();
  key('Enter', true);
  tick(500);
  assert.equal(confirms, 0);
  key('Enter', false); key('Enter', true);
  assert.equal(confirms, 1);
});

test('queued text refresh does not run after disposal', t => {
  const { handler, window } = setup(t);
  let callback, refreshes = 0;
  window.requestAnimationFrame = fn => { callback = fn; };
  handler.refreshOnTextChange = () => refreshes++;
  handler.scheduleTextRefresh();
  handler.destroy();
  callback();
  assert.equal(refreshes, 0);
});

test('right-stick action latches are independent and reset on popup close', t => {
  const { handler } = setup(t);
  handler.dictionaryPopupVisible = true;
  handler.popupActionSelectionActive = true;
  const actions = [];
  handler.sendDictionaryControlMessage = action => actions.push(action);
  handler.processRightStickHorizontalForPopup(1, 0.7, 'first');
  handler.processRightStickHorizontalForPopup(1, 0.7, 'first');
  handler.processRightStickHorizontalForPopup(1, 0.7, 'second');
  assert.deepEqual(actions, ['select-action', 'select-action']);
  handler.onDictionaryPopupHidden({ detail: {} });
  assert.equal(handler.thumbstickLatch.size, 0);
});

test('invalid button arrays cannot silently become A or partial combos', t => {
  const { window } = setup(t);
  for (const value of [[null], [false], [''], [4, 'nope'], 1.5, 'Button 9007199254740992']) {
    const binding = window.GamepadHandler.normalizeButtonBindingValue(value, 8);
    assert.deepEqual(Array.from(binding.buttons), [8]);
  }
});

test('timing configuration is finite and bounded, including explicit zero delay', t => {
  const { handler } = setup(t, { repeatDelay: 0, repeatRate: -1 });
  assert.equal(handler.config.repeatDelay, 0);
  assert.equal(handler.config.repeatRate, 16);
  handler.updateConfig({ repeatRate: NaN, thumbstickNavigationThreshold: Infinity });
  assert.equal(handler.config.repeatRate, 150);
  assert.equal(handler.config.thumbstickNavigationThreshold, 0.7);
});

test('initial server configuration uses the selected Sudachi dictionary', t => {
  const { handler } = setup(t, { sudachiDictionary: 'full' });
  const messages = [];
  handler.ws = { readyState: 1, send: data => messages.push(JSON.parse(data)), close() {} };
  handler.sendServiceFeatureConfiguration();
  assert.equal(messages.find(message => message.type === 'configure_sudachi').dictionary, 'full');
});

test('a released modifier in a server snapshot ends its navigation session', t => {
  const { handler, button } = setup(t, { activationMode: 'modifier' });
  button(4, true);
  assert.equal(handler.isActive, true);
  handler.onGamepadState({ device: 'pad', buttons: {}, axes: {} });
  assert.equal(handler.isActive, false);
});
