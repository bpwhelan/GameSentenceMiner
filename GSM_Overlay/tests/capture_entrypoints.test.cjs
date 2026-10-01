const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { between } = require('./helpers/overlay-startup.cjs');

const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');

function loadFunctions(context, names) {
  for (const name of names) {
    const match = source.match(new RegExp(`^function ${name}\\([\\s\\S]*?^}`, 'm'));
    assert.ok(match, `Missing production function ${name}`);
    vm.runInContext(match[0], context);
  }
}

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
  loadFunctions(context, names);
  vm.runInContext(between(source, 'const GAMEPAD_FOCUS_RETRY_DELAYS_MS', 'let gamepadToggleRequestSeq'), context);
  vm.runInContext(between(source, '  ipcMain.on("show",', '  ipcMain.on("yomitan-event"'), context);
  return { context, effects, messages, ipcMain };
}

function setupTextfeed(t) {
  const fixture = setup(t);
  const { context: c, effects } = fixture;
  const hotkeys = new Map();
  let visible = false;
  Object.assign(c, {
    texthookerWindow: {
      isDestroyed: () => false, isVisible: () => visible,
      show: () => { visible = true; }, hide: () => { visible = false; },
      setBounds() {}, setIgnoreMouseEvents() {}, setAlwaysOnTop() {}, focus() {},
    },
    DEFAULT_TEXTHOOKER_HOTKEY: 'Alt+Shift+W', TOGGLE_HOTKEY_COOLDOWN_MS: 300,
    OVERLAY_PAUSE_SOURCE_TEXTHOOKER_HOTKEY: 'textfeed',
    OVERLAY_PAUSE_SOURCE_GAMEPAD_MANUAL: 'gamepad-manual',
    overlayPauseSourceActive: {},
    shouldOverlayHotkeyRequestPause: () => true,
    sendOverlayPauseRequest: (action, source) => { effects.push(`${action}:${source}`); return true; },
    ensureManualAndTexthookerHotkeysDistinct: () => false,
    setOverlaySettingValue: (key, value) => { c.userSettings[key] = value; },
    safeUnregisterHotkey() {},
    setAppHotkey: (name, _key, handler) => { hotkeys.set(name, handler); return true; },
    getCurrentOverlayMonitor: () => ({}),
    getOverlayBoundsForDisplay: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    requestBackendFocusRestore: () => effects.push('restore-game-focus'),
    blurAndRestoreFocus() {},
    revealAutomaticOverlayForSignal: () => effects.push('automatic-reveal'),
  });
  loadFunctions(c, [
    'registerTexthookerHotkey', 'requestOverlayPauseForSource',
    'requestOverlayResumeForSource', 'releaseAllOverlayPauseRequests',
  ]);
  c.registerTexthookerHotkey();
  return { ...fixture, toggleTextfeed: hotkeys.get('texthooker') };
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

test('an open TextFeed survives obscured capture updates and keeps its pause until closed', t => {
  const { context: c, effects, messages, toggleTextfeed } = setupTextfeed(t);
  c.updateOverlayCaptureStatus({ available: true, window_state: 'active' });
  toggleTextfeed();
  effects.length = 0;
  for (let heartbeat = 0; heartbeat < 6; heartbeat++) {
    t.mock.timers.tick(1000);
    c.updateOverlayCaptureStatus({ available: true, window_state: 'obscured' });
    assert.equal(c.texthookerWindow.isVisible(), true, 'covering the game must not dismiss TextFeed');
    assert.equal(c.isTexthookerMode, true);
    assert.equal(c.overlayPauseSourceActive.textfeed, true);
    assert.equal(c.canUseOverlayCapture(), false, 'TextFeed still suppresses normal overlay interaction');
  }
  assert.ok(!effects.includes('resume:textfeed'));
  assert.equal(messages.filter(([name]) => name === 'overlay-capture-state').at(-1)[1].available, false);
  toggleTextfeed();
  assert.equal(c.texthookerWindow.isVisible(), false);
  assert.equal(c.isTexthookerMode, false);
  assert.equal(c.overlayPauseSourceActive.textfeed, false);
  assert.ok(effects.includes('resume:textfeed'));
  assert.ok(effects.includes('restore-game-focus'));
  assert.equal(c.canUseOverlayCapture(), false, 'closing must wait for the game to become visible');
  assert.ok(!effects.includes('show'));
  c.updateOverlayCaptureStatus({ available: true, window_state: 'background' });
  assert.equal(c.canUseOverlayCapture(), true);
  assert.ok(effects.includes('automatic-reveal'));
});

for (const [label, loseCapture] of [
  ['game minimized after focus changes', c => c.updateOverlayCaptureStatus({ available: false, window_state: 'minimized' })],
  ['game closed or no longer captured', c => c.updateOverlayCaptureStatus({ available: false, window_state: 'closed' })],
  ['obscured game without valid capture', c => c.updateOverlayCaptureStatus({ available: false, window_state: 'obscured' })],
  ['capture heartbeat expired', (_c, t) => t.mock.timers.tick(5001)],
  ['backend disconnected', c => c.publishOverlaySocketState('ws2', false)],
]) {
  test(`TextFeed still releases capture and pause with ${label}`, t => {
    const { context: c, effects, messages, toggleTextfeed } = setupTextfeed(t);
    c.updateOverlayCaptureStatus({ available: true, window_state: 'active' });
    toggleTextfeed();
    assert.equal(c.texthookerWindow.isVisible(), true);
    assert.equal(c.overlayPauseSourceActive.textfeed, true);

    effects.length = 0;
    loseCapture(c, t);
    assert.equal(c.texthookerWindow.isVisible(), false);
    assert.equal(c.isTexthookerMode, false);
    assert.equal(c.overlayPauseSourceActive.textfeed, false);
    assert.ok(effects.includes('resume:textfeed'));
    assert.equal(c.hasValidOverlayCapture(), false);
    assert.equal(c.canUseOverlayCapture(), false);
    assert.equal(messages.filter(([name]) => name === 'overlay-capture-state').at(-1)[1].available, false);

    assert.ok(!effects.includes('show'), 'capture loss must not restore the overlay');
    toggleTextfeed();
    assert.equal(c.texthookerWindow.isVisible(), false, 'reopening still requires fresh capture');
  });
}

test('capture recovery keeps the overlay hidden until TextFeed is closed', t => {
  const { context: c, effects, toggleTextfeed } = setupTextfeed(t);
  c.updateOverlayCaptureStatus({ available: true, window_state: 'active' });
  toggleTextfeed();
  c.updateOverlayCaptureStatus({ available: true, window_state: 'obscured' });
  effects.length = 0;
  c.updateOverlayCaptureStatus({ available: true, window_state: 'background' });
  assert.equal(c.texthookerWindow.isVisible(), true);
  assert.equal(c.hasValidOverlayCapture(), true);
  assert.equal(c.canUseOverlayCapture(), false);
  assert.ok(!effects.includes('show'));
  assert.ok(!effects.includes('automatic-reveal'));
  toggleTextfeed();
  assert.equal(c.texthookerWindow.isVisible(), false);
  assert.equal(c.canUseOverlayCapture(), true);
  assert.ok(effects.includes('show'));
});

test('full overlay cleanup still releases the TextFeed pause', t => {
  const { context: c, toggleTextfeed } = setupTextfeed(t);
  c.updateOverlayCaptureStatus({ available: true, window_state: 'active' });
  toggleTextfeed();
  c.releaseAllOverlayPauseRequests();
  assert.equal(c.overlayPauseSourceActive.textfeed, false);
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
