const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { between } = require('./helpers/overlay-startup.cjs');
const { createManualHotkeyController } = require('../manual_hotkey_controller');

const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');

function setup(t, settings = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  const state = { focused: false, visible: true, ignoreMouseEvents: true, focusCalls: 0 };
  const restores = [];
  const pauseRequests = [];
  const rendererMessages = [];
  const ipcMain = new EventEmitter();
  const hotkeys = new Map();
  const textfeedState = { visible: false, destroyed: false };
  const texthookerWindow = Object.assign(new EventEmitter(), {
    isDestroyed: () => textfeedState.destroyed,
    isVisible: () => textfeedState.visible,
    show: () => { textfeedState.visible = true; },
    hide: () => { textfeedState.visible = false; },
    focus: () => { state.focused = false; },
    setBounds() {}, setIgnoreMouseEvents() {}, setAlwaysOnTop() {},
  });
  const mainWindow = {
    isDestroyed: () => false,
    isMinimized: () => false,
    isVisible: () => state.visible,
    isFocused: () => state.focused,
    show: () => { state.visible = true; state.focused = true; },
    showInactive: () => { state.visible = true; },
    hide: () => { state.visible = false; state.focused = false; },
    focus: () => { state.focused = true; state.focusCalls += 1; },
    blur: () => { state.focused = false; },
    setIgnoreMouseEvents: ignore => { state.ignoreMouseEvents = ignore; },
    setAlwaysOnTop() {},
    setVisibleOnAllWorkspaces() {},
    moveTop() {},
    webContents: { focus() {}, send: (...args) => rendererMessages.push(args) },
  };
  const context = vm.createContext({
    console: { log() {} }, Date, setTimeout, clearTimeout, ipcMain, mainWindow,
    userSettings: {
      manualMode: true, manualModeType: 'toggle',
      manualModeInactiveBehavior: 'disable-interaction',
      manualModeDisableInteractionFocusOverlay: true,
      focusOverlayOnYomitanLookup: false, ...settings,
    },
    MANUAL_MODE_INACTIVE_BEHAVIOR_HIDE_OVERLAY: 'hide-overlay',
    MANUAL_MODE_INACTIVE_BEHAVIOR_DISABLE_INTERACTION: 'disable-interaction',
    VALID_MANUAL_MODE_INACTIVE_BEHAVIORS: new Set(['hide-overlay', 'disable-interaction']),
    OVERLAY_PAUSE_SOURCE_MANUAL_HOTKEY: 'manual-hotkey',
    OVERLAY_PAUSE_SOURCE_GAMEPAD_NAVIGATION: 'gamepad-navigation',
    OVERLAY_PAUSE_SOURCE_TEXTHOOKER_HOTKEY: 'textfeed',
    FOCUS_RESTORE_THROTTLE_MS: 150,
    OVERLAY_TOPMOST_REASSERT_THROTTLE_MS: 1500,
    lastFocusRestoreRequestAt: 0, suppressBackendFocusRestoreUntil: 0,
    overlayFocusRequestVersion: 0,
    lastOverlayTopmostReassertAt: 0, pendingOverlayTopmostReassertTimer: null,
    manualHotkeyPressed: false, manualModeToggleState: false,
    gamepadNavigationActive: false, gamepadReleaseRecoveryVersion: 0,
    overlayCaptureAvailable: true, trackedGameWindowState: 'active', isTexthookerMode: false,
    trackedGameWindowStateUpdatedAt: 0, magpieYomitanCloseVisibilityGuardActive: false,
    isOverlayVisible: false, resizeMode: false, yomitanShown: false,
    yomitanForegroundActive: false, yomitanRecoveryVersion: 0, lastYomitanEventAt: 0,
    currentMagpieState: { active: false },
    backend: { connected: true, send: message => restores.push(message.type) },
    isWindows: () => true, isLinux: () => false, isMac: () => false,
    normalizeManualModeType: value => value,
    createManualHotkeyController, MANUAL_HOTKEY_ELECTRON_RELEASE_TIMEOUT_MS: 650,
    canStartManualHotkeyActivation: () => context.canUseOverlayCapture(),
    ensureMainWindowIsOnConnectedDisplay() {}, forceForegroundWindow() {},
    overlayPauseSourceActive: {}, shouldOverlayHotkeyRequestPause: () => true,
    sendOverlayPauseRequest: (action, source) => { pauseRequests.push([action, source]); return true; },
    requestOverlayScanForActivation() {}, clearGamepadManualPause() {},
    requestManualModeBackground() {}, getManualModeBackgroundMode: () => 'off',
    resetActivityTimer() {}, clearMagpieYomitanCloseVisibilityGuard() {},
    beginMagpieYomitanCloseVisibilityGuard() {},
    normalizeTrackedGameWindowState: value => value,
    createMagpieState: () => ({ active: false }),
    revealAutomaticOverlayForSignal() {},
    texthookerWindow, texthookerLoadToken: 0,
    DEFAULT_TEXTHOOKER_HOTKEY: 'Alt+Shift+W', TOGGLE_HOTKEY_COOLDOWN_MS: 300,
    ensureManualAndTexthookerHotkeysDistinct: () => false,
    setOverlaySettingValue: (key, value) => { context.userSettings[key] = value; },
    safeUnregisterHotkey() {},
    setAppHotkey: (name, _key, handler) => { hotkeys.set(name, handler); return true; },
    getCurrentOverlayMonitor: () => ({}),
    getOverlayBoundsForDisplay: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
  });
  const functions = [
    'hasValidOverlayCapture', 'canUseOverlayCapture', 'publishOverlayCaptureAvailability',
    'setTrackedGameWindowState',
    'requestOverlayPauseForSource', 'requestOverlayResumeForSource',
    'isManualMode', 'normalizeManualModeInactiveBehavior',
    'shouldKeepOverlayVisibleWhenManualInactive', 'shouldHideOverlayWindowForManualInactive',
    'requestBackendFocusRestore', 'blurAndRestoreFocus', 'hideAndRestoreFocus',
    'releaseOverlayFocusAfterTopmostRecovery', 'reassertOverlayTopmostWithoutFocus',
    'requestOverlayTopmostReassert', 'showOverlayWithoutFocusForManualVisibleMode',
    'aggressivelyShowOverlayAndReturnFocus', 'setGamepadNavigationModeActive',
    'showOverlayUsingManualFlow', 'hideOverlayUsingManualFlow', 'clearManualActivationState',
    'shouldReassertOverlayAroundYomitan', 'shouldPreserveOverlayFocusForYomitan',
    'requestYomitanOverlayTopmostReassert',
    'registerTexthookerHotkey', 'deactivateTexthookerMode',
  ].map(name => {
    const match = source.match(new RegExp(`^function ${name}\\([\\s\\S]*?^}`, 'm'));
    assert.ok(match, `Missing production function ${name}`);
    return match[0];
  });
  vm.runInContext([
    ...functions,
    between(source, 'const manualHotkeyController =', 'const FOCUS_RESTORE_THROTTLE_MS'),
    between(source, 'let manualBackgroundShowTimer =', 'function hideOverlayUsingManualFlow'),
    between(source, 'const MANUAL_BACKGROUND_RELEASE_DELAY_MS', 'function saveSettings()'),
    between(source, 'const GAMEPAD_FOCUS_RETRY_DELAYS_MS', 'let gamepadToggleRequestSeq'),
    between(source, '  ipcMain.on("gamepad-navigation-state"', '  // Curated keys'),
    between(source, '  ipcMain.on("yomitan-event"', "  ipcMain.on('release-mouse'"),
    between(source, '  ipcMain.on("window-state-changed"', '  ipcMain.on("open-settings"'),
    between(source, "  texthookerWindow.on('closed'", "  texthookerWindow.on('show'"),
  ].join('\n'), context);
  const send = (channel, ...args) => ipcMain.emit(channel, {}, ...args);
  const manualController = vm.runInContext('manualHotkeyController', context);
  context.registerTexthookerHotkey();
  return {
    state, restores, pauseRequests, rendererMessages, context, send, manualController,
    toggleTextfeed: hotkeys.get('texthooker'),
    closeTextfeed: () => {
      textfeedState.visible = false;
      textfeedState.destroyed = true;
      texthookerWindow.emit('closed');
    },
    pressManualHotkey: () => {
      manualController.handlePress('input_server');
      if (context.userSettings.manualModeType !== 'hold') {
        manualController.handleRelease('input_server');
      }
    },
    activate: (requestFocus = true) => {
      // GamepadHandler.activateNavigation publishes onModeChange before requesting focus.
      send('gamepad-navigation-state', { active: true });
      if (requestFocus) send('gamepad-request-focus');
    },
    deactivate: () => {
      send('gamepad-release-focus');
      send('gamepad-navigation-state', { active: false });
    },
  };
}

test('controller activation keeps focus through both activation messages and lookup changes', t => {
  const { activate, send, state, restores, rendererMessages } = setup(t);
  activate();
  assert.equal(state.focused, true);
  for (const shown of [true, false, true]) {
    send('yomitan-event', shown);
    t.mock.timers.tick(1000);
    assert.equal(state.focused, true, 'active controller lookup must retain overlay focus');
  }
  assert.deepEqual(restores, [], 'activation must not request game focus restoration');
  assert.equal(rendererMessages.filter(([channel]) => channel === 'show-overlay-hotkey').length, 1);
});

test('controller activation honors focus-on-activate without a separate gamepad focus request', t => {
  const { activate, state, restores } = setup(t);
  activate(false);
  t.mock.timers.tick(1000);
  assert.equal(state.focused, true);
  assert.deepEqual(restores, []);
});

test('controller activation leaves the game focused when focus-on-activate is disabled', t => {
  const { activate, send, state, restores } = setup(t, { manualModeDisableInteractionFocusOverlay: false });
  activate();
  send('yomitan-event', true);
  t.mock.timers.tick(1000);
  assert.equal(state.focused, false);
  assert.equal(state.visible, true);
  assert.deepEqual(restores, []);
});

test('controller exit restores game focus and leaves the overlay visible but inactive', t => {
  const { activate, deactivate, state, restores, rendererMessages } = setup(t);
  activate();
  deactivate();
  t.mock.timers.tick(1000);
  assert.equal(state.focused, false);
  assert.equal(state.visible, true);
  assert.equal(state.ignoreMouseEvents, true);
  assert.deepEqual(restores, ['restore-focus-request']);
  assert.equal(rendererMessages.at(-1)[1], false);
});

test('controller exit clears an active manual toggle even without Alt-Tab', t => {
  const { activate, deactivate, pressManualHotkey, context, state, restores } = setup(t);
  pressManualHotkey();
  activate();
  t.mock.timers.tick(1000);
  deactivate();
  t.mock.timers.tick(1000);
  assert.equal(context.manualModeToggleState, false);
  assert.equal(state.focused, false);
  assert.equal(state.ignoreMouseEvents, true);
  assert.deepEqual(restores, ['restore-focus-request']);
});

for (const manualModeType of ['hold', 'toggle']) {
  for (const requestFocus of [false, true]) {
    test(`controller entry and exit restore focus after manual ${manualModeType} and Alt-Tab (focus request: ${requestFocus})`, t => {
      const { activate, deactivate, pressManualHotkey, context, send, state, restores, rendererMessages, pauseRequests } = setup(t, { manualModeType });
      pressManualHotkey();
      assert.equal(state.focused, true);
      send('window-state-changed', { state: 'background' });

      // Alt-Tab returns to the game while the manual session stays visible.
      context.mainWindow.blur();
      send('window-state-changed', { state: 'active' });
      assert.equal(state.focused, false);
      assert.equal(context.isOverlayVisible, true);

      activate(requestFocus);
      assert.equal(state.focused, true);
      // A delayed game-state report must not invalidate the new activation.
      send('window-state-changed', { state: 'active' });
      t.mock.timers.tick(1000);
      assert.equal(state.focused, true);
      assert.equal(state.ignoreMouseEvents, false);
      assert.equal(state.focusCalls, 2, 'the second activation message must not refocus an already focused overlay');
      assert.equal(rendererMessages.filter(([channel]) => channel === 'show-overlay-hotkey').length, 1,
        'focus recovery must not restart the manual reveal');
      assert.deepEqual(pauseRequests, [
        ['pause', 'manual-hotkey'], ['pause', 'gamepad-navigation'],
      ], 'entry must not clear the manual session');
      assert.deepEqual(restores, [], 'the handoff must not restore game focus while entering navigation');

      deactivate();
      t.mock.timers.tick(1000);
      assert.equal(state.focused, false, 'controller exit must return focus to the game');
      assert.equal(state.visible, true);
      assert.equal(state.ignoreMouseEvents, true);
      assert.equal(context.isOverlayVisible, false);
      assert.equal(context.manualHotkeyPressed, false);
      assert.equal(context.manualModeToggleState, false);
      assert.equal(context.overlayPauseSourceActive['manual-hotkey'], false);
      assert.equal(context.overlayPauseSourceActive['gamepad-navigation'], false);
      assert.deepEqual(restores, ['restore-focus-request']);

      pressManualHotkey();
      assert.equal(state.focused, true, 'the next manual press must activate, rather than clear an old latch');
    });
  }
}

test('controller reentry into a visible manual session honors disabled focus-on-activate', t => {
  const { activate, deactivate, pressManualHotkey, context, send, state, restores } = setup(t, { manualModeDisableInteractionFocusOverlay: false });
  pressManualHotkey();
  send('window-state-changed', { state: 'active' });
  activate();
  t.mock.timers.tick(1000);
  assert.equal(state.focused, false);
  assert.equal(state.focusCalls, 0);
  deactivate();
  assert.equal(context.manualModeToggleState, false, 'exit clears manual activation even when focus-on-activate is disabled');
  assert.deepEqual(restores, []);
});

test('recovered controller focus does not schedule a focus steal after a second Alt-Tab', t => {
  const { activate, pressManualHotkey, context, send, state, restores } = setup(t);
  pressManualHotkey();
  context.mainWindow.blur();
  activate();
  assert.equal(state.focused, true);

  context.mainWindow.blur();
  send('window-state-changed', { state: 'active' });
  t.mock.timers.tick(1000);
  assert.equal(state.focused, false);
  assert.deepEqual(restores, []);
});

test('a new manual activation survives duplicate controller exit messages and delayed focus release', t => {
  const { activate, pressManualHotkey, context, send, state, restores } = setup(t);
  activate();
  send('gamepad-release-focus');
  pressManualHotkey();
  send('gamepad-navigation-state', { active: false });
  send('window-state-changed', { state: 'active' });
  t.mock.timers.tick(1000);
  assert.equal(context.manualModeToggleState, true);
  assert.equal(state.focused, true);
  assert.deepEqual(restores, []);
});

test('immediate controller reentry cancels the previous exit focus release', t => {
  const { activate, deactivate, state, restores } = setup(t);
  activate();
  deactivate();
  activate();
  t.mock.timers.tick(1000);
  assert.equal(state.focused, true);
  assert.deepEqual(restores, []);
});

test('controller exit clears a manual session that started during navigation', t => {
  const { activate, deactivate, pressManualHotkey, context, state } = setup(t);
  activate();
  pressManualHotkey();
  deactivate();
  t.mock.timers.tick(1000);
  assert.equal(context.manualModeToggleState, false);
  assert.equal(state.focused, false);
});

test('a late manual hold release after controller exit does not reapply the manual state', t => {
  const { activate, deactivate, pressManualHotkey, manualController, context, state, restores } = setup(t, { manualModeType: 'hold' });
  pressManualHotkey();
  context.mainWindow.blur();
  activate();
  deactivate();
  assert.equal(manualController.getSnapshot().isActive, false);
  manualController.handleRelease('input_server');
  t.mock.timers.tick(1000);
  assert.equal(state.focused, false);
  assert.equal(context.gamepadNavigationActive, false);
  assert.deepEqual(restores, ['restore-focus-request']);
});

test('controller exit cancels manual focus waiting for a frozen frame', t => {
  const { activate, deactivate, pressManualHotkey, context, send, state, restores } = setup(t, { manualModeInactiveBehavior: 'hide-overlay' });
  context.getManualModeBackgroundMode = () => 'on_demand';
  pressManualHotkey();
  assert.equal(state.focused, false, 'manual focus waits for the frame to paint');
  assert.equal(context.manualModeToggleState, true);
  activate(false);
  deactivate();
  send('manual-mode-background-painted');
  t.mock.timers.tick(1000);
  assert.equal(context.manualModeToggleState, false);
  assert.equal(state.focused, false);
  assert.deepEqual(restores, ['restore-focus-request']);
});

for (const manualModeInactiveBehavior of ['hide-overlay', 'disable-interaction']) {
  for (const exitMethod of ['hotkey', 'close']) {
    test(`TextFeed ${exitMethod} clears manual activation and returns focus (${manualModeInactiveBehavior})`, t => {
      const { toggleTextfeed, closeTextfeed, pressManualHotkey, manualController, context, state, restores, rendererMessages } = setup(t, { manualModeInactiveBehavior });
      pressManualHotkey();
      toggleTextfeed();
      if (exitMethod === 'hotkey') toggleTextfeed();
      else closeTextfeed();
      t.mock.timers.tick(1000);
      assert.equal(context.isTexthookerMode, false);
      assert.equal(manualController.getSnapshot().isActive, false);
      assert.equal(context.manualModeToggleState, false);
      assert.equal(context.isOverlayVisible, false);
      assert.equal(context.overlayPauseSourceActive['manual-hotkey'], false);
      assert.equal(context.overlayPauseSourceActive.textfeed, false);
      assert.equal(state.focused, false);
      assert.equal(state.visible, manualModeInactiveBehavior === 'disable-interaction');
      assert.equal(state.ignoreMouseEvents, true);
      assert.equal(rendererMessages.filter(([channel]) => channel === 'show-overlay-hotkey').at(-1)[1], false);
      assert.deepEqual(restores, ['restore-focus-request']);
      pressManualHotkey();
      assert.equal(state.focused, true);
    });
  }
}

test('TextFeed exit cancels delayed manual focus and cannot steal focus from a new manual activation', t => {
  const { toggleTextfeed, pressManualHotkey, context, send, state, restores } = setup(t);
  pressManualHotkey();
  context.waitForManualBackgroundThenFocus('pending-manual-focus');
  toggleTextfeed();
  toggleTextfeed();
  assert.equal(context.manualModeToggleState, false);
  pressManualHotkey();
  send('manual-mode-background-painted');
  t.mock.timers.tick(1000);
  assert.equal(state.focused, true);
  assert.equal(context.manualModeToggleState, true);
  assert.deepEqual(restores, ['restore-focus-request']);
});
