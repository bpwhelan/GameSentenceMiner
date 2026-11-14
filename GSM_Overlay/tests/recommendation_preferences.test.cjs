const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { between } = require('./helpers/overlay-startup.cjs');

const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const kinds = [
  ['showManualModeRecommendations', 'maybeShowManualModeRecommendation', 'dismissedFullscreenRecommendations'],
  ['showExclusiveFullscreenRecommendations', 'maybeShowFullscreenModeRecommendation', 'dismissedExclusiveFullscreenRecommendations'],
];

function harness(settings = {}) {
  const windows = [];
  const handlers = {};
  const updates = [];
  let persisted;
  const context = vm.createContext({
    userSettings: { ...settings },
    isWindows: () => true,
    isManualMode: () => false,
    getManualHotkeyRuntimeStatus: () => ({}),
    getOverlayAppIconPath: () => '',
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
    mainWindow: null,
    settingsWindow: { isDestroyed: () => false, webContents: { send: (...args) => updates.push(args) } },
    BrowserWindow: class {
      constructor() { windows.push(this); this.destroyed = false; this.webContents = { once() {} }; }
      removeMenu() {}
      setAlwaysOnTop() {}
      once() {}
      on(name, callback) { if (name === 'closed') this.onClosed = callback; }
      isDestroyed() { return this.destroyed; }
      focus() {}
      close() { this.destroyed = true; this.onClosed(); }
    },
    loadOverlayPage() {},
    ipcMain: { on: (name, handler) => { handlers[name] = handler; } },
    console: { log() {} },
    getEnforcedOverlayTransportUrls: () => ({}),
    OVERLAY_SETTINGS_PROFILES_ENABLED_KEY: 'overlaySettingsProfilesEnabled',
    CONFIGURED_HOTKEY_SETTING_KEY_SET: new Set(),
    GSM_OWNED_OVERLAY_FIELD_MAP: {},
    vnGuideSceneSettings: null,
    persistOverlaySettingForActiveProfile() {},
    saveSettings() { persisted = JSON.parse(JSON.stringify(context.userSettings)); },
    updateTrayMenu() {},
  });
  vm.runInContext(between(source, 'function setOverlaySettingValue(', 'function normalizeFloatingWindowFontSize('), context);
  vm.runInContext(between(source, '// --- Manual-mode recommendation', 'function shouldKeepOverlayVisibleWhenManualInactive('), context);
  vm.runInContext(between(source, '  ipcMain.on("setting-changed",', '  ipcMain.on("overlay-select-ocr-area",'), context);
  return {
    show: (name, game) => context[name](game), windows, updates,
    change: (key, value) => handlers['setting-changed']({ sender: {} }, { key, value }),
    persisted: () => persisted,
  };
}

for (const [key, show, dismissed] of kinds) {
  test(`${key}: old settings still show recommendations, once per game`, () => {
    const app = harness();
    app.show(show, 'A');
    app.windows[0].close();
    app.show(show, 'A');
    assert.equal(app.windows.length, 1);
    app.show(show, 'B');
    assert.equal(app.windows.length, 2);
  });

  test(`${key}: disabling persists across restarts and covers all games`, () => {
    const app = harness();
    app.change(key, false);
    const restarted = harness(app.persisted());
    for (const game of ['A', 'B', '']) restarted.show(show, game);
    assert.equal(restarted.windows.length, 0);
  });

  test(`${key}: closes an open popup, syncs settings, and can be re-enabled`, () => {
    const app = harness();
    app.show(show, 'A');
    app.change(key, false);
    assert.equal(app.windows[0].destroyed, true);
    assert.deepEqual(JSON.parse(JSON.stringify(app.updates.at(-1))), ['settings-updated', { [key]: false }]);
    app.show(show, 'B');
    assert.equal(app.windows.length, 1);
    app.change(key, true);
    app.show(show, 'B');
    assert.equal(app.windows.length, 2);
  });

  test(`${key}: per-game dismissal still works`, () => {
    const app = harness({ [key]: true, [dismissed]: ['A'] });
    app.show(show, 'A');
    assert.equal(app.windows.length, 0);
    app.show(show, 'B');
    assert.equal(app.windows.length, 1);
  });
}

test('the two recommendation preferences are independent', () => {
  for (const [index, [key, show]] of kinds.entries()) {
    const app = harness({ [key]: false });
    app.show(show, 'A');
    assert.equal(app.windows.length, 0);
    app.show(kinds[1 - index][1], 'A');
    assert.equal(app.windows.length, 1);
  }
});

test('popup preferences are global, outside game profiles', () => {
  const context = vm.createContext({ OVERLAY_PROFILE_CONTROL_KEYS: [], GSM_OWNED_OVERLAY_SETTING_KEYS: [] });
  vm.runInContext(between(source, 'const OVERLAY_NON_PROFILE_SETTING_KEYS', 'function getPackagedResourcesPath()'), context);
  for (const [key] of kinds) {
    assert.equal(vm.runInContext(`OVERLAY_NON_PROFILE_SETTING_KEYS.has('${key}')`, context), true);
  }
});
