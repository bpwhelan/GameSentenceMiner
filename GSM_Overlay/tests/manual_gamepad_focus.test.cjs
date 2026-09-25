const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { between } = require('./helpers/overlay-startup.cjs');

const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');

function setup(t, settings = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  const state = { focused: false, visible: true, ignoreMouseEvents: true };
  const restores = [];
  const rendererMessages = [];
  const ipcMain = new EventEmitter();
  const mainWindow = {
    isDestroyed: () => false,
    isMinimized: () => false,
    isVisible: () => state.visible,
    isFocused: () => state.focused,
    show: () => { state.visible = true; state.focused = true; },
    showInactive: () => { state.visible = true; },
    hide: () => { state.visible = false; state.focused = false; },
    focus: () => { state.focused = true; },
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
    FOCUS_RESTORE_THROTTLE_MS: 150,
    OVERLAY_TOPMOST_REASSERT_THROTTLE_MS: 1500,
    lastFocusRestoreRequestAt: 0, suppressBackendFocusRestoreUntil: 0,
    lastOverlayTopmostReassertAt: 0, pendingOverlayTopmostReassertTimer: null,
    manualHotkeyPressed: false, manualModeToggleState: false,
    gamepadNavigationActive: false, gamepadReleaseRecoveryVersion: 0,
    isOverlayVisible: false, resizeMode: false, yomitanShown: false,
    yomitanForegroundActive: false, yomitanRecoveryVersion: 0, lastYomitanEventAt: 0,
    currentMagpieState: { active: false },
    backend: { connected: true, send: message => restores.push(message.type) },
    isWindows: () => true, isLinux: () => false, isMac: () => false,
    normalizeManualModeType: value => value,
    ensureMainWindowIsOnConnectedDisplay() {}, forceForegroundWindow() {},
    requestOverlayPauseForSource() {}, requestOverlayResumeForSource() {},
    requestOverlayScanForActivation() {}, clearGamepadManualPause() {},
    cancelManualBackgroundRelease() {}, cancelManualBackgroundShowWait() {},
    requestManualModeBackground() {}, getManualModeBackgroundMode: () => 'off',
    resetActivityTimer() {}, clearMagpieYomitanCloseVisibilityGuard() {},
    beginMagpieYomitanCloseVisibilityGuard() {},
  });
  const functions = [
    'isManualMode', 'normalizeManualModeInactiveBehavior',
    'shouldKeepOverlayVisibleWhenManualInactive', 'shouldHideOverlayWindowForManualInactive',
    'requestBackendFocusRestore', 'blurAndRestoreFocus', 'hideAndRestoreFocus',
    'releaseOverlayFocusAfterTopmostRecovery', 'reassertOverlayTopmostWithoutFocus',
    'requestOverlayTopmostReassert', 'showOverlayWithoutFocusForManualVisibleMode',
    'aggressivelyShowOverlayAndReturnFocus', 'setGamepadNavigationModeActive',
    'showOverlayUsingManualFlow', 'hideOverlayUsingManualFlow',
    'shouldReassertOverlayAroundYomitan', 'shouldPreserveOverlayFocusForYomitan',
    'requestYomitanOverlayTopmostReassert',
  ].map(name => {
    const match = source.match(new RegExp(`^function ${name}\\([\\s\\S]*?^}`, 'm'));
    assert.ok(match, `Missing production function ${name}`);
    return match[0];
  });
  vm.runInContext([
    ...functions,
    between(source, 'const GAMEPAD_FOCUS_RETRY_DELAYS_MS', 'let gamepadToggleRequestSeq'),
    between(source, '  ipcMain.on("gamepad-navigation-state"', '  // Curated keys'),
    between(source, '  ipcMain.on("yomitan-event"', "  ipcMain.on('release-mouse'"),
  ].join('\n'), context);
  const send = (channel, ...args) => ipcMain.emit(channel, {}, ...args);
  return {
    state, restores, rendererMessages, context, send,
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

test('entering and leaving controller navigation preserves an active manual toggle', t => {
  const { activate, deactivate, context, state, restores } = setup(t);
  context.manualModeToggleState = true;
  context.showOverlayUsingManualFlow('manual-toggle');
  activate();
  t.mock.timers.tick(1000);
  deactivate();
  t.mock.timers.tick(1000);
  assert.equal(state.focused, true);
  assert.equal(state.ignoreMouseEvents, false);
  assert.deepEqual(restores, []);
});
