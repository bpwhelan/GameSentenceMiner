const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function loadSettings() {
  const source = fs.readFileSync(path.join(__dirname, '../settings.html'), 'utf8');
  const section = (start, end) => {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `Settings section: ${start}`);
    return source.slice(from, to);
  };
  const saved = [];
  const timers = new Map();
  const inputs = new Map();
  const browserPads = [{ index: 0, id: 'Browser layout', buttons: [{ pressed: true }], axes: [] }];
  class Socket {
    static OPEN = 1;
    static CONNECTING = 0;
    constructor() { this.readyState = 1; Socket.current = this; }
    send() {}
    close() { this.readyState = 3; this.onclose?.(); }
    receive(data) { this.onmessage({ data: JSON.stringify(data) }); }
  }
  const context = vm.createContext({
    console, WebSocket: Socket,
    navigator: { getGamepads: () => browserPads },
    document: { getElementById: id => inputs.get(id) || null, activeElement: null },
    setInterval: fn => { const id = timers.size + 1; timers.set(id, fn); return id; },
    clearInterval: id => timers.delete(id), setTimeout: () => 1, clearTimeout() {},
    ipcRenderer: { send() {} }, window: { dispatchEvent() {} },
    addGamepadInputConsoleLine() {}, renderGamepadDeviceLists() {},
    isGamepadDeviceBlacklisted: name => name === 'Ignored pad',
    setGamepadDeviceBlacklist() {}, sendGamepadDeviceBlacklistToServer() {},
    getDisplayControllerLabel: value => value,
    commitSettingValue: (key, value) => saved.push([key, value]),
  });
  vm.runInContext([
    section('    const GAMEPAD_BUTTON_LABELS = {', '    const KEYBOARD_BINDING_INPUT_CONFIG = {'),
    section('    let gamepadStatusInterval = null;', '    function updateTokenizerBackendFieldState()'),
    section('    function getCaptureTargetGamepad(', '    // ==================== Keyboard Binding Capture'),
    section('    function getGamepadButtonLabel(', '    // Check gamepad status periodically'),
    'updateGamepadStatus = () => {};',
  ].join('\n'), context);
  const call = code => vm.runInContext(code, context);
  const pads = () => JSON.parse(call('JSON.stringify(getConnectedGamepads())'));
  const capture = (id = 'gamepadConfirmButton') => {
    inputs.set(id, { value: 'A', classList: { add() {}, remove() {} }, blur() {} });
    call(`startGamepadBindingCapture('${id}')`);
  };
  call('connectGamepadStatusSocket(7276)');
  return { call, pads, capture, saved, timers, inputs, socket: () => Socket.current };
}

test('capture uses server IDs even when the browser reports a different layout', () => {
  const f = loadSettings();
  f.socket().receive({ type: 'gamepad_connected', device: 'Generic USB pad', state: { buttons: { 803: true }, axes: { raw_9: 0.75 } } });
  assert.deepEqual(f.pads().map(pad => pad.id), ['Generic USB pad']);
  f.capture();
  for (const tick of f.timers.values()) tick();
  f.socket().receive({ type: 'button', device: 'Generic USB pad', button: 803, pressed: false });
  assert.deepEqual(f.saved, [['gamepadConfirmButton', 'Button 803']]);
});

test('short raw button taps and combos are captured between polling ticks', () => {
  const f = loadSettings();
  f.socket().receive({ type: 'gamepad_connected', device: 'Generic USB pad' });
  f.capture('gamepadNavigateLeft');
  for (const [button, pressed] of [[803, true], [806, true], [803, false], [806, false]]) {
    f.socket().receive({ type: 'button', device: 'Generic USB pad', button, pressed });
  }
  assert.deepEqual(f.saved, [['gamepadNavigateLeft', 'Button 803 + Button 806']]);
});

test('raw axis direction buttons can be captured and raw axes appear in the input test', () => {
  const f = loadSettings();
  f.socket().receive({ type: 'gamepad_state', device: 'Generic USB pad', buttons: {}, axes: {} });
  f.capture();
  f.socket().receive({ type: 'axis', device: 'Generic USB pad', axis: 'raw_65536', value: -0.9 });
  f.socket().receive({ type: 'button', device: 'Generic USB pad', button: 196641, pressed: true });
  const snapshot = JSON.parse(f.call('JSON.stringify(buildGamepadInputSnapshot(getConnectedGamepads()[0]))'));
  assert.equal(snapshot.axes.raw_65536, -0.9);
  assert.deepEqual(snapshot.buttons, [196641]);
  f.socket().receive({ type: 'button', device: 'Generic USB pad', button: 196641, pressed: false });
  assert.deepEqual(f.saved, [['gamepadConfirmButton', 'Button 196641']]);
});

test('disconnect and reconnect discard held capture state and ignored devices', () => {
  const f = loadSettings();
  f.socket().receive({ type: 'gamepad_connected', device: 'Generic USB pad' });
  f.socket().receive({ type: 'gamepad_connected', device: 'Ignored pad' });
  f.capture();
  f.socket().receive({ type: 'button', device: 'Generic USB pad', button: 803, pressed: true });
  f.socket().receive({ type: 'gamepad_disconnected', device: 'Generic USB pad' });
  assert.deepEqual(f.pads(), []);
  f.socket().receive({ type: 'gamepad_connected', device: 'Generic USB pad' });
  for (const tick of f.timers.values()) tick();
  assert.deepEqual(f.saved, []);
  f.socket().receive({ type: 'button', device: 'Generic USB pad', button: 806, pressed: true });
  f.socket().receive({ type: 'button', device: 'Generic USB pad', button: 806, pressed: false });
  assert.deepEqual(f.saved, [['gamepadConfirmButton', 'Button 806']]);
  f.socket().close();
  assert.equal(f.pads()[0].id, 'Browser layout');
  f.call('connectGamepadStatusSocket(7276)');
  assert.deepEqual(f.pads(), []);
});
