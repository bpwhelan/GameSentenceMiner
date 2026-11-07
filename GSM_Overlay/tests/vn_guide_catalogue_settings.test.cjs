const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { JSDOM } = require('jsdom');
const { parseGuideUrl, validateRoute } = require('../vn_guide');
const { GuideCatalogue, parseCatalogueSource, DEFAULT_CATALOGUE_SOURCE } = require('../vn_guide_catalogue');
const { createVnGuideController } = require('../vn_guide_controller');
const { between } = require('./helpers/overlay-startup.cjs');

test('settings load and search the default catalogue, save the chosen guide, and support source overrides and folder selection', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-vn-catalogue-ui-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const read = filename => fs.readFileSync(path.join(__dirname, '..', filename), 'utf8');
  const dom = new JSDOM(read('settings.html'), { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const ipcRenderer = new EventEmitter();
  const handlers = new Map(), pending = [], saved = [], requests = [];
  let folder = { canceled: true, filePaths: [] };
  const catalogue = new GuideCatalogue(directory, { fetchJson: async url => {
    requests.push(url);
    return { v1: { slug: 'one', title: 'One', alttitle: '一', has_guide: true },
      v2: { slug: 'two', title: 'Two', alttitle: '二', has_guide: true },
      v3: { slug: 'wip', title: 'Unfinished', has_guide: false } };
  } });
  const route = { id: 'first', title: 'First route', reviewed: true };
  const controller = createVnGuideController({
    library: { load: async url => ({ source: parseGuideUrl(url), route,
      guide: { title: 'Chosen Game', routes: [route] }, index: 0, steps: validateRoute([{ simpleJp: '大丈夫' }]) }), save() {} },
    hud: { update() {}, dispose() {} },
    onChange: state => ipcRenderer.emit('vn-guide-state', {}, state),
  });
  t.after(() => controller.dispose());
  const context = vm.createContext({
    settingsWindow: { webContents: {} }, vnGuideController: controller, vnGuideHud: { owns: sender => sender === 'hud' },
    canUseOverlayCapture: () => true, parseGuideUrl, parseCatalogueSource, DEFAULT_CATALOGUE_SOURCE,
    vnGuideCatalogue: catalogue,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    dialog: { showOpenDialog: async () => folder },
    userSettings: { vnGuideEnabled: false, vnGuideUrl: '', vnGuideRoute: 'old-route', vnGuideCatalogueSource: DEFAULT_CATALOGUE_SOURCE },
    setOverlaySettingValue: (key, value) => { context.userSettings[key] = value; },
    saveSettings: () => { saved.push({ ...context.userSettings }); return true; },
    registerVnGuideHotkeys: () => controller.configure(context.userSettings), publishOverlaySettingsSnapshot() {},
  });
  vm.runInContext(between(read('main.js'), "  ipcMain.handle('vn-guide-state'", '  registerManualShowHotkey();'), context);
  ipcRenderer.invoke = (channel, payload) => {
    const promise = Promise.resolve(handlers.get(channel)({ sender: context.settingsWindow.webContents }, payload));
    pending.push(promise);
    return promise;
  };
  dom.window.require = () => ({ ipcRenderer });
  dom.window.eval(read('vn_guide_settings.js'));
  const settle = async () => { await Promise.all(pending); await new Promise(resolve => setImmediate(resolve)); };
  await settle();
  const el = id => dom.window.document.getElementById(id);
  const source = el('vnGuideCatalogueSource'), select = el('vn-guide-catalogue'), search = el('vn-guide-search');
  assert.equal(source.value, DEFAULT_CATALOGUE_SOURCE);
  assert.equal(select.options.length, 3);
  assert.equal(select.disabled, false);
  assert.equal(saved.length, 0, 'browsing the catalogue must not change the guide settings');
  for (const sender of [{}, 'hud']) {
    assert.equal(await handlers.get('vn-guide-catalogue')({ sender }, {}), null);
    assert.equal(await handlers.get('vn-guide-command')({ sender }, { action: 'select-guide', value: select.options[1].value }), null);
  }
  search.value = '二';
  search.dispatchEvent(new dom.window.Event('input'));
  assert.equal(select.options.length, 2);
  assert.match(select.options[1].text, /Two/);
  select.value = select.options[1].value;
  select.dispatchEvent(new dom.window.Event('change'));
  await settle();
  const chosen = 'https://raw.githubusercontent.com/kanjieater/VN-Guide/main/two/';
  assert.equal(context.userSettings.vnGuideUrl, chosen);
  assert.equal(context.userSettings.vnGuideRoute, '');
  assert.equal(context.userSettings.vnGuideEnabled, true);
  assert.equal(select.value, chosen);
  assert.equal(el('vn-guide-current').textContent, '大丈夫');
  search.value = '';
  search.dispatchEvent(new dom.window.Event('input'));
  source.value = 'https://github.com/fork/My-Guide/tree/other';
  source.dispatchEvent(new dom.window.Event('change'));
  await settle();
  assert.equal(context.userSettings.vnGuideCatalogueSource, source.value);
  assert.equal(select.options[1].value, 'https://raw.githubusercontent.com/fork/My-Guide/other/one/');
  assert.equal(context.userSettings.vnGuideUrl, chosen, 'changing catalogues must not switch the current guide');
  el('vn-guide-catalogue-default').click();
  await settle();
  assert.equal(source.value, DEFAULT_CATALOGUE_SOURCE);
  assert.equal(select.value, chosen);
  el('vn-guide-catalogue-folder').click();
  await settle();
  assert.equal(source.value, DEFAULT_CATALOGUE_SOURCE, 'cancelling the folder dialog preserves the source');
  const local = path.join(directory, 'Local guides');
  fs.mkdirSync(local);
  folder = { canceled: false, filePaths: [local] };
  el('vn-guide-catalogue-folder').click();
  await settle();
  assert.equal(source.value, local);
  assert.match(select.options[1].value, /^file:/);
  source.value = 'https://evil.test/catalogue';
  source.dispatchEvent(new dom.window.Event('change'));
  await settle();
  assert.equal(context.userSettings.vnGuideCatalogueSource, local);
  assert.equal(context.userSettings.vnGuideUrl, chosen);
  assert.equal(select.disabled, true);
  assert.match(el('vn-guide-catalogue-status').textContent, /GitHub/);
  assert.ok(requests.includes('https://raw.githubusercontent.com/kanjieater/VN-Guide/main/games.json'));
});

test('a late catalogue failure cannot replace a newer source or its guide options', async t => {
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, '../settings.html'), 'utf8'), { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const ipcRenderer = new EventEmitter();
  let rejectOld, latest;
  ipcRenderer.invoke = (channel, request) => {
    if (channel === 'vn-guide-state') return Promise.resolve(null);
    if (!request.source) return Promise.resolve({ source: DEFAULT_CATALOGUE_SOURCE, guides: [] });
    if (request.source === 'old') return new Promise((_resolve, reject) => { rejectOld = reject; });
    latest = Promise.resolve({ source: 'new', guides: [{ title: 'New guide', slug: 'new', url: 'https://example.test/new/' }] });
    return latest;
  };
  dom.window.require = () => ({ ipcRenderer });
  dom.window.eval(fs.readFileSync(path.join(__dirname, '../vn_guide_settings.js'), 'utf8'));
  await new Promise(resolve => setImmediate(resolve));
  const source = dom.window.document.getElementById('vnGuideCatalogueSource');
  source.value = 'old';
  source.dispatchEvent(new dom.window.Event('change'));
  source.value = 'new';
  source.dispatchEvent(new dom.window.Event('change'));
  await latest;
  await new Promise(resolve => setImmediate(resolve));
  rejectOld(new Error('Old request failed'));
  await new Promise(resolve => setImmediate(resolve));
  const select = dom.window.document.getElementById('vn-guide-catalogue');
  assert.equal(source.value, 'new');
  assert.equal(select.options[1].text, 'New guide');
  assert.equal(select.disabled, false);
});
