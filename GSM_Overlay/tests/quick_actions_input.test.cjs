const { test } = require('node:test');
const assert = require('node:assert/strict');
const GamepadHandler = require('../gamepad');
const { QuickActions } = require('../quick_actions');
global.window = { dispatchEvent() {} };
global.CustomEvent = class {};

function setup(options = {}) {
  const calls = [];
  const panel = new QuickActions({ runAction: async action => { calls.push(action); return { paused: action === 'toggle-intake' }; } });
  const handler = Object.create(GamepadHandler.prototype);
  Object.assign(handler, {
    config: { activationMode: 'toggle', controllerEnabled: true, keyboardEnabled: true,
      thumbstickNavigationThreshold: .7, repeatDelay: 15, repeatRate: 10,
      forwardEnterButton: 0, getQuickActions: () => panel, ...options },
    isActive: true, toggleModeActive: true, currentCursorIndex: 7,
    buttonStates: new Map(), gamepads: new Map([['pad', { buttons: {}, axes: {} }]]),
    repeatTimers: new Map(), pressedKeys: new Set(), keyboardModifiers: {}, thumbstickLatch: new Map(),
  });
  handler.getIpcRenderer = () => null;
  handler.hideVisuals = () => {};
  handler.closeDictionaryPopups = () => {};
  handler.forwardEnterToTargetWindow = () => calls.push('forward');
  handler.triggerMining = () => calls.push('mine');
  handler.navigateBlockDown = () => calls.push('text-down');
  handler.hideVirtualMouseCursorForDpadNavigation = () => {};
  handler.refreshButtonBindings(); handler.refreshKeyboardBindings();
  let time = 1000;
  handler.getToggleTimestamp = () => time;
  const press = button => {
    time += 300;
    handler.onButtonEvent({ device: 'pad', button, pressed: true });
    handler.onButtonEvent({ device: 'pad', button, pressed: false });
  };
  return { handler, panel, calls, press };
}

test('controller menu consumes confirm before mining or forwarded game input and restores text navigation', async () => {
  const { handler, panel, calls, press } = setup();
  press(9); await Promise.resolve();
  assert.equal(panel.isOpen, true);
  press(13); assert.equal(panel.selected, 2);
  assert.equal(handler.currentCursorIndex, 7);
  press(12); press(0); await Promise.resolve();
  assert.deepEqual(calls, ['state', 'toggle-intake']);
  press(1); assert.equal(panel.isOpen, false);
  press(13); assert.equal(calls.at(-1), 'text-down');
  press(0); assert.equal(calls.at(-1), 'forward');
  handler.stopNavigationRepeats();
});

test('remapped generic button chords open the menu without a standard Start button', async () => {
  const { handler, panel } = setup({ quickActionsButton: 'Button 803 + Button 809' });
  handler.onButtonEvent({ device: 'pad', button: 803, pressed: true });
  assert.equal(panel.isOpen, false);
  handler.onButtonEvent({ device: 'pad', button: 809, pressed: true }); await Promise.resolve();
  assert.equal(panel.isOpen, true);
  handler.stopNavigationRepeats(); panel.close();
});

test('both sticks navigate and repeat while held, then stop on neutral', async () => {
  const { handler, panel, press } = setup();
  press(9); await Promise.resolve();
  const moves = [];
  panel.navigate = direction => moves.push(direction);
  handler.onAxisEvent({ device: 'pad', axis: 'left_y', value: -1 });
  await new Promise(resolve => setTimeout(resolve, 45));
  handler.onAxisEvent({ device: 'pad', axis: 'left_y', value: 0 });
  assert(moves.length >= 2); assert(moves.every(direction => direction === 'Down'));
  const count = moves.length;
  await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(moves.length, count);
  handler.onAxisEvent({ device: 'pad', axis: 'right_x', value: 1 });
  handler.onAxisEvent({ device: 'pad', axis: 'right_x', value: 0 });
  assert.equal(moves.at(-1), 'Right');
  handler.stopNavigationRepeats(); panel.close();
});

test('keyboard menu navigation uses the same panel and input suppression stops all actions', async () => {
  const { handler, panel, calls } = setup();
  const key = key => {
    handler.onKeyboardEvent({ key, pressed: true }); handler.onKeyboardEvent({ key, pressed: false });
  };
  try {
    key('Tab'); await Promise.resolve(); assert.equal(panel.isOpen, true);
    key('ArrowRight'); assert.equal(panel.selected, 1);
    key('Escape'); assert.equal(panel.isOpen, false);
    handler.config.inputSuppressed = true; key('Tab'); assert.equal(panel.isOpen, false);
    assert.deepEqual(calls, ['state']);
  } finally { handler.stopNavigationRepeats(); }
});
