const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { JSDOM } = require('jsdom');
const { validateRoute } = require('../vn_guide');
const { createVnGuideController } = require('../vn_guide_controller');
const { between } = require('./helpers/overlay-startup.cjs');

test('settings Go button jumps to the entered step through the main IPC handler', async t => {
  const read = filename => fs.readFileSync(path.join(__dirname, '..', filename), 'utf8');
  const dom = new JSDOM(read('settings.html'), { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const handlers = new Map();
  const ipcRenderer = new EventEmitter();
  const settingsWindow = { webContents: {} };
  const saved = [];
  const route = { id: 'one', title: 'Route One', reviewed: true };
  const controller = createVnGuideController({
    library: {
      load: async () => ({
        guide: { title: 'Test Game', routes: [route] }, route, index: 0,
        steps: validateRoute(['大丈夫', 'セーブ1', '進む', 'セーブ1にロード'].map(simpleJp => ({ simpleJp }))),
      }),
      save: (_loaded, index) => saved.push(index),
    },
    hud: { update() {}, dispose() {} },
    onChange: state => ipcRenderer.emit('vn-guide-state', {}, state),
  });
  t.after(() => controller.dispose());
  await controller.configure({ vnGuideEnabled: true, vnGuideUrl: 'https://kanjieater.github.io/VN-Guide/test-game/' });
  vm.runInNewContext(between(read('main.js'), "  ipcMain.handle('vn-guide-state'", '  registerManualShowHotkey();'), {
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    settingsWindow, vnGuideController: controller, vnGuideHud: null,
  });
  ipcRenderer.invoke = async (channel, payload) => handlers.get(channel)({ sender: settingsWindow.webContents }, payload);
  dom.window.require = name => {
    assert.equal(name, 'electron');
    return { ipcRenderer };
  };
  dom.window.eval(read('vn_guide_settings.js'));
  const settle = () => new Promise(resolve => setImmediate(resolve));
  await settle();
  const el = id => dom.window.document.getElementById(id);
  const input = el('vn-guide-step');
  const button = el('vn-guide-jump');
  assert.equal(button.disabled, false);
  for (const [step, index, text, position] of [
    [4, 3, 'セーブ1にロード', 'Step 4 of 4'],
    [1, 0, '大丈夫', 'Step 1 of 4'],
    [2, 2, '進む', 'Steps 2–3 of 4'],
    [3, 2, '進む', 'Steps 2–3 of 4'],
  ]) {
    input.focus();
    input.value = String(step);
    button.focus();
    button.click();
    await settle();
    assert.equal(controller.snapshot().index, index, `Jump to step ${step}`);
    assert.equal(el('vn-guide-current').textContent, text);
    assert.ok(el('vn-guide-status').textContent.includes(position));
    assert.equal(saved.at(-1), index);
  }
});

test('Continue in settings and the Next hotkey persist the new route through the production wiring', async t => {
  const read = filename => fs.readFileSync(path.join(__dirname, '..', filename), 'utf8');
  const dom = new JSDOM(read('settings.html'), { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const ipcRenderer = new EventEmitter();
  const handlers = new Map();
  const hotkeys = new Map();
  const selections = [];
  const routes = ['one', 'two', 'three'].map(id => ({ id, title: `Route ${id}`, reviewed: true }));
  let canSave = true;
  const context = vm.createContext({
    vnGuideController: null, vnGuideHud: null, BrowserWindow: {}, dataPath: '',
    userSettings: { vnGuideEnabled: true, vnGuideUrl: 'https://kanjieater.github.io/VN-Guide/test-game/', vnGuideNextHotkey: 'Alt+Shift+Right' },
    createVnGuideController,
    createVnGuideHud: () => ({ update() {}, dispose() {}, owns: () => false }),
    GuideLibrary: class {
      async load(_url, id) {
        return { guide: { title: 'Test Game', routes }, route: routes.find(route => route.id === id) || routes[0],
          index: 0, steps: validateRoute([{ simpleJp: '大丈夫' }]) };
      }
      save() {}
    },
    settingsWindow: { isDestroyed: () => false, webContents: { send: (channel, state) => ipcRenderer.emit(channel, {}, state) } },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    clearAppHotkey: id => hotkeys.delete(id),
    setAppHotkey: (id, _key, callback) => hotkeys.set(id, callback),
    canUseOverlayCapture: () => true, TOGGLE_HOTKEY_COOLDOWN_MS: 100,
    setOverlaySettingValue: (key, value) => { context.userSettings[key] = value; },
    saveSettings: () => { if (canSave) selections.push(context.userSettings.vnGuideRoute); return canSave; },
    publishOverlaySettingsSnapshot() {},
  });
  vm.runInContext(between(read('main.js'), 'function registerVnGuideHotkeys()', 'function registerCustomPageHotkey()'), context);
  await context.registerVnGuideHotkeys();
  const controller = context.vnGuideController;
  t.after(() => controller.dispose());
  vm.runInContext(between(read('main.js'), "  ipcMain.handle('vn-guide-state'", '  registerManualShowHotkey();'), context);
  ipcRenderer.invoke = async (channel, payload) => handlers.get(channel)({ sender: context.settingsWindow.webContents }, payload);
  dom.window.require = () => ({ ipcRenderer });
  dom.window.eval(read('vn_guide_settings.js'));
  const settle = () => new Promise(resolve => setImmediate(resolve));
  await settle();
  const el = id => dom.window.document.getElementById(id);
  const button = el('vn-guide-next');
  button.click();
  await settle();
  assert.equal(el('vn-guide-current').textContent, 'おつかれさま！');
  assert.equal(button.textContent, 'Continue to Route two');
  assert.equal(button.disabled, false);
  canSave = false;
  button.click();
  await settle();
  assert.equal(controller.snapshot().routeId, 'one');
  assert.equal(context.userSettings.vnGuideRoute, undefined);
  assert.match(el('vn-guide-status').textContent, /Could not save/);
  canSave = true;
  button.click();
  await settle();
  assert.equal(controller.snapshot().routeId, 'two');
  assert.equal(el('vnGuideRoute').value, 'two');
  assert.equal(button.textContent, 'Next / Done');
  assert.deepEqual(selections, ['two']);
  await context.registerVnGuideHotkeys();
  assert.equal(controller.snapshot().routeId, 'two', 'reconfiguring must retain the continued route');
  hotkeys.get('vn-guide-next')();
  assert.equal(controller.snapshot().complete, true);
  hotkeys.get('vn-guide-next')();
  await settle();
  assert.equal(controller.snapshot().routeId, 'three');
  assert.equal(el('vnGuideRoute').value, 'three');
  assert.deepEqual(selections, ['two', 'three']);
  button.click();
  await settle();
  assert.equal(controller.snapshot().complete, true);
  assert.equal(button.disabled, true);
});
