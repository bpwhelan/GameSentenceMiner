const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { between } = require('./helpers/overlay-startup.cjs');
const { createManualHotkeyController } = require('../manual_hotkey_controller');
const { createVnGuideController } = require('../vn_guide_controller');
const { validateRoute } = require('../vn_guide');

const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');

function setup(t, settings = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  const state = { focused: false, visible: true, ignoreMouseEvents: true, focusCalls: 0, blurCalls: 0 };
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
    getNativeWindowHandle: () => {
      const handle = Buffer.alloc(8);
      handle.writeBigUInt64LE(0x123456789n);
      return handle;
    },
    isDestroyed: () => false,
    isMinimized: () => false,
    isVisible: () => state.visible,
    isFocused: () => state.focused,
    show: () => { state.visible = true; state.focused = true; },
    showInactive: () => { state.visible = true; },
    hide: () => { state.visible = false; state.focused = false; },
    focus: () => { state.focused = true; state.focusCalls += 1; },
    blur: () => { state.focused = false; state.blurCalls += 1; },
    setIgnoreMouseEvents: ignore => { state.ignoreMouseEvents = ignore; },
    setAlwaysOnTop() {},
    setVisibleOnAllWorkspaces() {},
    moveTop() {},
    webContents: { focus() {}, send: (...args) => rendererMessages.push(args) },
  };
  const context = vm.createContext({
    console: { log() {}, warn() {} }, Date, setTimeout, clearTimeout, ipcMain, mainWindow,
    userSettings: {
      manualMode: true, manualModeType: 'toggle',
      manualModeInactiveBehavior: 'disable-interaction',
      manualModeDisableInteractionFocusOverlay: true,
      textHoverClickThrough: JSON.parse(source.match(/"textHoverClickThrough": (true|false)/)[1]),
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
    pendingMagpieFocusRestore: null, magpieFocusRequestSequence: 0, magpieSession: null, magpieSourceFocused: false,
    lastOverlayTopmostReassertAt: 0, pendingOverlayTopmostReassertTimer: null,
    manualHotkeyPressed: false, manualModeToggleState: false,
    gamepadNavigationActive: false,
    overlayCaptureAvailable: true, trackedGameWindowState: 'active', isTexthookerMode: false,
    customPageController: null, vnGuideController: null, vnGuideHud: null,
    trackedGameWindowStateUpdatedAt: 0,
    isOverlayVisible: false, resizeMode: false, yomitanShown: false,
    yomitanForegroundActive: false, yomitanRecoveryVersion: 0,
    currentMagpieState: { active: false },
    backend: { connected: true, send: message => { if (message.type === 'restore-focus-request') restores.push(message.type); } },
    isWindows: () => true, isLinux: () => false, isMac: () => false,
    normalizeManualModeType: value => value,
    createManualHotkeyController, MANUAL_HOTKEY_ELECTRON_RELEASE_TIMEOUT_MS: 650,
    canStartManualHotkeyActivation: () => context.canUseOverlayCapture(),
    ensureMainWindowIsOnConnectedDisplay() {}, forceForegroundWindow() {},
    overlayPauseSourceActive: {}, shouldOverlayHotkeyRequestPause: () => true,
    sendOverlayPauseRequest: (action, source) => { pauseRequests.push([action, source]); return true; },
    requestOverlayScanForActivation() {}, clearGamepadManualPause() {},
    requestManualModeBackground() {}, getManualModeBackgroundMode: () => 'off',
    resetActivityTimer() {},
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
    'canTrackMagpiePointer', 'canRouteTextHover',
    'attachMagpieSession',
    'setTrackedGameWindowState',
    'requestOverlayPauseForSource', 'requestOverlayResumeForSource',
    'isManualMode', 'normalizeManualModeInactiveBehavior',
    'shouldKeepOverlayVisibleWhenManualInactive', 'shouldHideOverlayWindowForManualInactive',
    'requestBackendFocusRestore', 'blurAndRestoreFocus', 'hideAndRestoreFocus',
    'restoreFocusAfterAnkiConfirmation', 'handleOverlayWebSocketControlMessage',
    'releaseOverlayFocusAfterTopmostRecovery', 'reassertOverlayTopmostWithoutFocus',
    'requestOverlayTopmostReassert', 'showOverlayWithoutFocusForManualVisibleMode',
    'aggressivelyShowOverlayAndReturnFocus', 'setGamepadNavigationModeActive',
    'restoreAutomaticOverlayPassThrough', 'requestMagpieStateRefresh', 'shouldDeferObscuredStateForMagpieFocus', 'handleMagpieFocusResult', 'cancelPendingMagpieFocusRestore', 'requestMagpieFocusRestore',
    'showOverlayUsingManualFlow', 'hideOverlayUsingManualFlow', 'clearManualActivationState',
    'shouldReassertOverlayAroundYomitan', 'shouldPreserveOverlayFocusForYomitan',
    'requestYomitanOverlayTopmostReassert', 'scheduleYomitanCloseRecovery',
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
    between(source, "  ipcMain.on('magpie-pointer-hit'", '  ipcMain.on("hide",'),
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

for (const manualMode of [false, true]) {
  for (const navigationActive of [false, true]) {
    for (const previouslyFocused of [false, true]) {
      test(`Anki confirmation restores focus with manual=${manualMode}, navigation=${navigationActive}, previous overlay=${previouslyFocused}`, t => {
        const { context, state, restores } = setup(t, { manualMode });
        context.gamepadNavigationActive = navigationActive;
        const message = {
          type: 'anki-confirmation-closed',
          previousForegroundHwnd: previouslyFocused ? '4886718345' : '42',
        };
        // The data socket and BackendConnector receive the same broadcast.
        assert.equal(context.handleOverlayWebSocketControlMessage('ws2', message), true);
        assert.equal(context.handleOverlayWebSocketControlMessage('backend-connector', message), true);
        t.mock.timers.tick(1000);

        const returnToOverlay = previouslyFocused && navigationActive;
        assert.equal(state.focused, returnToOverlay);
        assert.deepEqual(restores, returnToOverlay ? [] : ['restore-focus-request']);
        assert.equal(state.focusCalls, returnToOverlay ? 5 : 0);
        assert.equal(context.gamepadNavigationActive, navigationActive);
      });
    }
  }
}

test('Anki confirmation cannot focus the overlay after navigation ends during recovery', t => {
  const { context, state } = setup(t);
  context.gamepadNavigationActive = true;
  context.restoreFocusAfterAnkiConfirmation({ previousForegroundHwnd: '4886718345' });
  context.gamepadNavigationActive = false;
  t.mock.timers.tick(1000);
  assert.equal(state.focusCalls, 0);
});

test('Anki confirmation returns to the game when overlay capture is unavailable', t => {
  const { context, state, restores } = setup(t);
  context.gamepadNavigationActive = true;
  context.overlayCaptureAvailable = false;
  context.restoreFocusAfterAnkiConfirmation({ previousForegroundHwnd: '4886718345' });
  t.mock.timers.tick(1000);
  assert.equal(state.focusCalls, 0);
  assert.deepEqual(restores, ['restore-focus-request']);
});

test('Anki confirmation returns to the game when the overlay window has closed', t => {
  const { context, restores } = setup(t);
  context.gamepadNavigationActive = true;
  context.mainWindow = null;
  context.restoreFocusAfterAnkiConfirmation({ previousForegroundHwnd: '4886718345' });
  assert.deepEqual(restores, ['restore-focus-request']);
});

test('pending game focus restoration cannot interrupt a visible custom page', t => {
  const { context, restores } = setup(t);
  context.customPageController = { isVisible: () => true };
  assert.equal(context.requestBackendFocusRestore('delayed-manual-release', { force: true }), false);
  assert.deepEqual(restores, []);
  context.customPageController = null;
  assert.equal(context.requestBackendFocusRestore('custom-page-hide', { force: true }), true);
  assert.deepEqual(restores, ['restore-focus-request']);
});

for (const manualModeType of ['hold', 'toggle']) {
  for (const background of ['off', 'on_demand']) {
    test(`VN guide remains usable through manual ${manualModeType} hide-overlay cycles (background ${background})`, async t => {
      const { context, state, pressManualHotkey, manualController, send } = setup(t, { manualModeType, manualModeInactiveBehavior: 'hide-overlay' });
      context.getManualModeBackgroundMode = () => background;
      const overlay = Object.assign(new EventEmitter(), context.mainWindow);
      context.mainWindow = overlay;
      for (const event of ['show', 'hide', 'focus']) {
        const original = overlay[event];
        overlay[event] = (...args) => { original(...args); overlay.emit(event); };
      }
      const originalShowInactive = overlay.showInactive;
      overlay.showInactive = () => { originalShowInactive(); overlay.emit('show'); };
      const updates = [];
      let raises = 0;
      const steps = validateRoute(['セーブ1', '大丈夫', '進む'].map(simpleJp => ({ simpleJp })));
      const library = { save() {}, load: async () => ({ guide: { title: 'Test', routes: [] }, route: { id: 'one' }, steps, index: 0 }) };
      const hud = { update: value => updates.push(value), reassertTopmost: () => { raises += 1; } };
      const guide = createVnGuideController({ library, hud });
      context.vnGuideController = guide;
      context.vnGuideHud = hud;
      const refresh = source.match(/^function refreshVnGuideWindow\([\s\S]*?^}/m);
      assert.ok(refresh, 'Missing guide window refresh');
      vm.runInContext(refresh[0], context);
      vm.runInContext(between(source, '  // Keep the VN guide above', '  // Update tray menu when window visibility changes'), context);
      await guide.configure({ vnGuideEnabled: true, vnGuideUrl: 'test', vnGuideMode: 'hotkey' });
      context.refreshVnGuideWindow();
      guide.command('toggle');
      for (let cycle = 0; cycle < 3; cycle += 1) {
        pressManualHotkey();
        if (background === 'on_demand') send('manual-mode-background-painted');
        t.mock.timers.tick(1);
        assert.equal(state.visible, true);
        assert.equal(guide.snapshot().visible, true);
        assert.ok(raises > cycle, 'show/focus should restore the guide above the lookup overlay');
        if (manualModeType === 'hold') manualController.handleRelease('input_server');
        else pressManualHotkey();
        t.mock.timers.tick(300);
        context.refreshVnGuideWindow();
        assert.equal(state.visible, false, 'hide-overlay still hides the lookup window');
        assert.equal(guide.snapshot().visible, true, 'the guide remains available over the game');
        assert.equal(guide.snapshot().index, 1);
        assert.deepEqual(guide.snapshot().saveInstructions, ['セーブ1']);
      }
      guide.command('next');
      assert.equal(guide.snapshot().text, '進む', 'guide controls work while the lookup overlay is hidden');
      guide.command('hide');
      context.refreshVnGuideWindow();
      assert.equal(guide.snapshot().visible, false, 'restacking never overrides an explicit guide hide');
    });
  }
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

test('automatic dictionary lookup defaults to text click-through and permits only current renderer hover controls', t => {
  const { context, state, send, rendererMessages } = setup(t, { manualMode: false });
  state.ignoreMouseEvents = true;
  state.focused = false;
  send('yomitan-event', true);
  assert.equal(state.ignoreMouseEvents, true, 'opening a popup must not capture the whole overlay');
  assert.equal(state.focused, false);
  assert.ok(rendererMessages.some(([channel]) => channel === 'text-hover-refresh'));
  send('set-ignore-mouse-events', false);
  assert.equal(state.ignoreMouseEvents, true, 'legacy text enter cannot acquire mouse input');
  send('text-hover-ignore', false);
  assert.equal(state.ignoreMouseEvents, true, 'messages from another sender cannot acquire input');
  const hover = ignore => context.ipcMain.emit('text-hover-ignore', {sender: context.mainWindow.webContents}, ignore);
  hover(false);
  assert.equal(state.ignoreMouseEvents, false, 'popup and control regions remain interactive');
  hover(true);
  assert.equal(state.ignoreMouseEvents, true, 'returning to text releases input while the popup stays open');
  state.visible = false;
  hover(false);
  assert.equal(state.ignoreMouseEvents, true, 'a queued result cannot acquire input after hiding');
  state.visible = true;
  context.magpieSession = { ownsPointer: () => true };
  hover(false);
  assert.equal(state.ignoreMouseEvents, true, 'native Magpie sequence owns projected hit results');
});

test('automatic hover replies never override explicit manual, controller, resize or dictionary focus', t => {
  const { context, state } = setup(t, { manualMode: false, textHoverClickThrough: true });
  for (const owner of ['manualHotkeyPressed', 'manualModeToggleState', 'gamepadNavigationActive', 'resizeMode', 'yomitanForegroundActive']) {
    context[owner] = true;
    state.ignoreMouseEvents = false;
    context.ipcMain.emit('text-hover-ignore', {sender: context.mainWindow.webContents}, true);
    assert.equal(state.ignoreMouseEvents, false, owner);
    context[owner] = false;
  }
});

test('text click-through can be disabled while Magpie tracking stays available', t => {
  const { context, state, send } = setup(t, { manualMode: false, textHoverClickThrough: false });
  assert.equal(context.canRouteTextHover(), true);
  assert.equal(context.canTrackMagpiePointer(), true);
  context.ipcMain.emit('text-hover-ignore', { sender: context.mainWindow.webContents }, false, false);
  assert.equal(state.ignoreMouseEvents, false, 'text can acquire input with the setting off');
  context.ipcMain.emit('text-hover-ignore', { sender: context.mainWindow.webContents }, true);
  assert.equal(state.ignoreMouseEvents, false, 'late click-through replies cannot override the setting');
  send('set-ignore-mouse-events', true);
  assert.equal(state.ignoreMouseEvents, false, 'legacy mouse-down release cannot break text selection');
  send('yomitan-event', true);
  assert.equal(state.ignoreMouseEvents, false, 'the legacy popup interaction still captures input');
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

for (const exitMode of ['automatic-gamepad', 'manual-gamepad', 'manual-hotkey']) {
  test(`Magpie ${exitMode} hands focus directly to the game without first blurring`, t => {
    const { activate, deactivate, pressManualHotkey, context, state, restores } = setup(t, {
      manualMode: exitMode !== 'automatic-gamepad',
    });
    context.currentMagpieState = { active: true };
    if (exitMode === 'manual-hotkey') pressManualHotkey();
    else activate();
    t.mock.timers.tick(1000);
    if (exitMode === 'manual-hotkey') pressManualHotkey();
    else deactivate();
    t.mock.timers.tick(40);

    assert.deepEqual(restores, ['restore-focus-request']);
    assert.equal(state.focused, true, 'wait for the targeted handoff instead of activating an arbitrary window');
    assert.equal(state.blurCalls, 0);
    state.focused = false; // The backend successfully activates the game.
    t.mock.timers.tick(1000);
    assert.equal(state.blurCalls, 0);
    assert.deepEqual(restores, ['restore-focus-request']);
  });
}

test('Magpie waits for the backend result before falling back', t => {
  const { activate, deactivate, context, state, restores } = setup(t, { manualMode: false });
  context.currentMagpieState = { active: true };
  activate();
  t.mock.timers.tick(1000);
  deactivate();
  t.mock.timers.tick(1000);
  assert.equal(state.focused, true);
  assert.equal(state.blurCalls, 0);
  assert.deepEqual(restores, ['restore-focus-request']);
  context.handleMagpieFocusResult({ request_id: context.pendingMagpieFocusRestore.requestId, success: false });
  assert.equal(state.blurCalls, 1);
  assert.deepEqual(restores, ['restore-focus-request', 'restore-focus-request']);
});

test('a stale obscured snapshot cannot hide the verified foreground Magpie source', t => {
  const { context, state, send } = setup(t, { manualMode: false });
  context.magpieSession = { updateTarget() {
    context.currentMagpieState = { active: true };
    context.magpieSourceFocused = true;
  } };
  send('window-state-changed', { state: 'obscured', targetHwnd: 42 });
  assert.equal(context.trackedGameWindowState, 'active');
  assert.equal(state.visible, true);
});

function attachNativeMagpieFixture(f) {
  let notify, reorder;
  const info = {
    source_hwnd: 42, scaling_hwnd: 99, windowed: false, source_focused: true,
    sourceWindowLeftEdgePosition: 320, sourceWindowTopEdgePosition: 196,
    sourceWindowRightEdgePosition: 2240, sourceWindowBottomEdgePosition: 1276,
    magpieWindowLeftEdgePosition: 0, magpieWindowTopEdgePosition: 0,
    magpieWindowRightEdgePosition: 2560, magpieWindowBottomEdgePosition: 1440,
  };
  const order = { covered: false, raises: 0 };
  f.context.createMagpieState = require('../magpie').createMagpieState;
  f.context.createMagpieNative = () => ({
    watch(_win, onMessage, onOrder) { notify = onMessage; reorder = onOrder; return () => {}; },
    read: target => target === info.source_hwnd ? info : null,
    isAbove: () => order.covered,
  });
  f.context.createMagpieSession = options => require('../magpie_session').createMagpieSession({
    ...options, setIntervalFn: () => 1, clearIntervalFn() {},
  });
  f.context.mainWindow.moveTop = () => { order.covered = false; order.raises++; };
  f.context.attachMagpieSession();
  f.context.magpieSession.updateTarget(42);
  return { info, order, notify: (...args) => notify(...args), reorder: () => reorder?.() };
}

for (const interaction of ['dictionary', 'controller']) {
  for (const ackFirst of [false, true]) {
    test(`overlay survives a late Magpie reorder after ${interaction} exit (ACK first: ${ackFirst})`, t => {
      const f = setup(t, { manualMode: false });
      const native = attachNativeMagpieFixture(f);
      if (interaction === 'dictionary') f.send('yomitan-event', true);
      else f.activate();
      f.state.focused = true;
      native.info.source_focused = false;
      native.notify(0, 1);
      if (interaction === 'dictionary') f.send('yomitan-event', false);
      else f.deactivate();
      const requestId = f.context.pendingMagpieFocusRestore.requestId;
      const acknowledge = () => f.context.handleMagpieFocusResult({ request_id: requestId, success: true });
      f.state.focused = false;
      native.info.source_focused = true;
      if (ackFirst) acknowledge();
      native.notify(1, 99);
      if (!ackFirst) acknowledge();
      const raises = native.order.raises;
      native.order.covered = true;
      native.reorder();
      assert.equal(native.order.covered, false, 'the scaler cannot strand the visible overlay underneath it');
      assert.equal(native.order.raises, raises + 1);
      native.reorder();
      assert.equal(native.order.raises, raises + 1, 'an already-correct order requires no further work');
      assert.equal(f.state.visible, true);
      assert.equal(f.state.focused, false);
      assert.equal(f.state.blurCalls, 0);
      assert.deepEqual(f.restores, ['restore-focus-request']);
      f.context.magpieSession.dispose();
    });
  }
}

test('Magpie ordering recovery respects a hidden manual overlay and unavailable capture', t => {
  const f = setup(t, { manualMode: true, manualModeInactiveBehavior: 'hide-overlay' });
  const native = attachNativeMagpieFixture(f);
  native.order.covered = true;
  native.reorder();
  assert.equal(native.order.raises, 0);
  f.context.userSettings.manualMode = false;
  f.context.overlayCaptureAvailable = false;
  native.reorder();
  assert.equal(native.order.raises, 0);
  f.context.magpieSession.dispose();
});

test('Magpie handoff fallback cannot blur a new manual activation', t => {
  const { activate, deactivate, pressManualHotkey, context, state, restores } = setup(t);
  context.currentMagpieState = { active: true };
  activate();
  deactivate();
  t.mock.timers.tick(40);
  const requestId = context.pendingMagpieFocusRestore.requestId;
  pressManualHotkey();
  context.handleMagpieFocusResult({ request_id: requestId, success: false });
  t.mock.timers.tick(1000);
  assert.equal(state.focused, true);
  assert.equal(state.blurCalls, 0);
  assert.deepEqual(restores, ['restore-focus-request']);
});

test('Magpie focus release still blurs when the backend is unavailable', t => {
  const { activate, deactivate, context, state, restores } = setup(t);
  context.currentMagpieState = { active: true };
  context.backend.connected = false;
  activate();
  deactivate();
  t.mock.timers.tick(1000);
  assert.equal(state.focused, false);
  assert.equal(state.blurCalls, 1);
  assert.deepEqual(restores, []);
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
