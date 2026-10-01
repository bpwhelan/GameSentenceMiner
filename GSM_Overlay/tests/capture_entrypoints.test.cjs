const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { between } = require('./helpers/overlay-startup.cjs');

const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');

function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  const effects = [], messages = [];
  const ipcMain = new EventEmitter();
  const context = vm.createContext({
    console: { log() {}, warn() {} }, Date, setTimeout, clearTimeout, ipcMain,
    overlayCaptureAvailable: false, overlayCaptureExpiryTimer: null,
    trackedGameWindowState: 'unknown', isTexthookerMode: false, texthookerWindow: null,
    settingsWindow: null, websocketStates: { ws1: false, ws2: false },
    mainWindow: {
      isDestroyed: () => false, isVisible: () => false, isMinimized: () => false,
      hide: () => effects.push('hide'), show: () => effects.push('show'),
      showInactive: () => effects.push('show'), focus: () => effects.push('focus'),
      setIgnoreMouseEvents: value => { if (!value) effects.push('mouse'); },
      webContents: { send: (...args) => messages.push(args), focus: () => effects.push('focus') },
    },
    userSettings: { gamepadEnabled: true },
    backend: { connected: true, send: data => effects.push(data.type) },
    gamepadNavigationActive: false, gamepadKeyboardToggleSuppressedUntil: 0,
    manualHotkeyPressed: false, manualModeToggleState: false, isOverlayVisible: false,
    yomitanShown: false, yomitanForegroundActive: false, resizeMode: false,
    currentMagpieState: { active: false },
    isManualMode: () => false, isWindows: () => true, isMac: () => false, isLinux: () => false,
    setTrackedGameWindowState: state => { context.trackedGameWindowState = state; return state; },
    resetOverlayInteractionStateForHiddenGameWindow: () => { context.gamepadNavigationActive = false; },
    releaseAllOverlayPauseRequests() {}, clearMagpieYomitanCloseVisibilityGuard() {},
    cancelManualBackgroundShowWait() {}, cancelManualBackgroundRelease() {},
    revealAutomaticOverlayForSignal() {}, shouldKeepOverlayVisibleWhenManualInactive: () => false,
    shouldDeferObscuredStateAfterYomitanClose: () => false,
    requestOverlayScanForActivation: () => effects.push('scan'),
    requestOverlayPauseForSource: () => effects.push('pause'),
    OVERLAY_PAUSE_SOURCE_GAMEPAD_NAVIGATION: 'gamepad',
    OVERLAY_PAUSE_SOURCE_MANUAL_HOTKEY: 'manual',
    ensureMainWindowIsOnConnectedDisplay() {}, syncOverlayWindowsToCurrentMonitor() {},
    forceForegroundWindow: () => effects.push('focus'),
    getManualModeBackgroundMode: () => 'on_demand',
  });
  const names = [
    'hasValidOverlayCapture', 'canUseOverlayCapture', 'publishOverlayCaptureAvailability',
    'invalidateOverlayCapture', 'updateOverlayCaptureStatus', 'publishOverlaySocketState',
    'showOverlayUsingManualFlow', 'setGamepadNavigationModeActive',
    'reassertOverlayTopmostWithoutFocus', 'aggressivelyShowOverlayAndReturnFocus',
    'requestManualOverlayScan', 'requestManualModeBackground', 'restoreAutomaticOverlayPassThrough',
    'showInactiveAndRestoreFocus', 'focusOverlayForYomitanLookup',
  ];
  for (const name of names) {
    const match = source.match(new RegExp(`^function ${name}\\([\\s\\S]*?^}`, 'm'));
    assert.ok(match, `Missing production function ${name}`);
    vm.runInContext(match[0], context);
  }
  vm.runInContext(between(source, 'const GAMEPAD_FOCUS_RETRY_DELAYS_MS', 'let gamepadToggleRequestSeq'), context);
  vm.runInContext(between(source, '  ipcMain.on("show",', '  ipcMain.on("yomitan-event"'), context);
  return { context, effects, messages, ipcMain };
}

test('every reveal, scan, and focus entry rejects unconfirmed capture', t => {
  const { context: c, effects, messages, ipcMain } = setup(t);
  c.showOverlayUsingManualFlow('test');
  c.setGamepadNavigationModeActive(true, 'test', { focusOverlay: true });
  c.reassertOverlayTopmostWithoutFocus('test', { forceShow: true });
  c.aggressivelyShowOverlayAndReturnFocus();
  c.aggressivelyFocusOverlayForGamepadNavigation();
  c.focusOverlayForYomitanLookup();
  c.showInactiveAndRestoreFocus();
  c.restoreAutomaticOverlayPassThrough();
  c.requestManualOverlayScan();
  c.requestManualModeBackground();
  ipcMain.emit('show', {});
  ipcMain.emit('resize-mode', {}, true);
  t.mock.timers.tick(1000);
  assert.deepEqual(effects.filter(effect => effect !== 'hide'), []);
  assert.equal(c.gamepadNavigationActive, false);
  assert.equal(c.resizeMode, false);
  assert.ok(messages.some(([name]) => name === 'overlay-capture-state'));
});

test('capture loss and heartbeat expiry cancel pending focus and reject stale entry', t => {
  const { context: c, effects } = setup(t);
  c.updateOverlayCaptureStatus({ available: true, window_state: 'active' });
  assert.equal(c.canUseOverlayCapture(), true);
  c.gamepadNavigationActive = true;
  c.aggressivelyFocusOverlayForGamepadNavigation();
  c.updateOverlayCaptureStatus({ available: false, window_state: 'closed' });
  t.mock.timers.tick(1000);
  assert.equal(c.canUseOverlayCapture(), false);
  assert.ok(!effects.includes('focus'));
  c.updateOverlayCaptureStatus({ available: true, window_state: 'background' });
  assert.equal(c.canUseOverlayCapture(), true);
  t.mock.timers.tick(5001);
  assert.equal(c.canUseOverlayCapture(), false);
});

test('TextFeed cannot leave stale game state available for overlay entry', t => {
  const { context: c } = setup(t);
  c.updateOverlayCaptureStatus({ available: true, window_state: 'active' });
  c.isTexthookerMode = true;
  assert.equal(c.canUseOverlayCapture(), false);
  c.updateOverlayCaptureStatus({ available: false, window_state: 'closed' });
  c.isTexthookerMode = false;
  assert.equal(c.canUseOverlayCapture(), false);
});

test('backend reconnection requires new capture confirmation', t => {
  const { context: c } = setup(t);
  c.publishOverlaySocketState('ws2', true);
  c.updateOverlayCaptureStatus({ available: true, window_state: 'active' });
  assert.equal(c.canUseOverlayCapture(), true);
  c.publishOverlaySocketState('ws2', false);
  c.publishOverlaySocketState('ws2', true);
  assert.equal(c.canUseOverlayCapture(), false);
  c.updateOverlayCaptureStatus({ available: true, window_state: 'background' });
  assert.equal(c.canUseOverlayCapture(), true);
});

test('renderer capture state suppresses controller and keyboard entry and clears a latched session', t => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<body></body>', { runScripts: 'outside-only' });
  const { window } = dom;
  window.console.log = () => {};
  window.document.elementFromPoint = () => null;
  const listeners = new Map();
  window.testIpc = { send() {}, on: (channel, handler) => listeners.set(channel, handler) };
  for (const file of ['dictionary_navigation.js', 'gamepad.js']) {
    window.eval(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));
  }
  const renderer = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  window.eval(`
    const ipcRenderer = window.testIpc;
    let overlayCaptureAvailable = false, gamepadInputSuppressed = false;
    const dictionaryReader = 'yomitan', showFurigana = false, pendingManualRevealForBackground = false;
    const isManualInteractionSuppressed = () => false;
    const cancelDeferredManualReveal = () => {}, closeYomitanLookups = () => {};
    const updateGamepadStatusIndicator = () => {};
    const gamepadSettings = { enabled: true, controllerEnabled: true, keyboardEnabled: true };
    ${between(renderer, '  function shouldUseGamepadHandler()', '  async function ensureGamepadModuleLoaded()')}
    const gamepadHandler = new window.GamepadHandler({
      ...getGamepadHandlerConfig(), connectToServer: false, focusOverlayOnEntry: false,
    });
    window.handler = gamepadHandler;
    ${between(renderer, "  ipcRenderer.on('overlay-capture-state'", '  // IPC: Manual navigation commands')}
  `);
  const handler = window.handler;
  t.after(() => { handler.destroy(); window.close(); });
  handler.activateNavigation({ type: 'gamepad' });
  assert.equal(handler.isActive, false, 'startup is unavailable');
  listeners.get('overlay-capture-state')(null, { available: true });
  handler.activateNavigation({ type: 'gamepad' });
  assert.equal(handler.isActive, true);
  listeners.get('overlay-capture-state')(null, { available: false });
  assert.equal(handler.isActive, false);
  assert.equal(handler.toggleModeActive, false);
  assert.equal(handler.overlayFocusHeld, false);
  handler.activateNavigation({ type: 'keyboard' });
  handler.manualToggle();
  assert.equal(handler.isActive, false, 'stale input cannot reopen navigation');
  listeners.get('gamepad-input-test-active')(null, { active: false });
  assert.equal(handler.isInputSuppressed(), true, 'leaving input test cannot bypass missing capture');
  listeners.get('overlay-capture-state')(null, { available: true });
  assert.equal(handler.isActive, false, 'recovery requires a fresh activation');
  handler.activateNavigation({ type: 'keyboard' });
  assert.equal(handler.isActive, true);
});
