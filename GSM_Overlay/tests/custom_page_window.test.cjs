const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { createCustomPageController, normalizeCustomPageUrl } = require('../custom_page_window');

const guideUrl = 'https://kanjieater.github.io/VN-Guide/';

function setup(savedUrls = {}) {
  const windows = [];
  const events = [];
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.visible = false;
      this.destroyed = false;
      this.urls = [];
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = handler => { this.openHandler = handler; };
      this.webContents.reload = () => { this.reloads = (this.reloads || 0) + 1; };
      this.webContents.navigationHistory = {
        canGoBack: () => true, canGoForward: () => false,
        goBack: () => { this.wentBack = true; }, goForward: () => { this.wentForward = true; },
      };
      windows.push(this);
    }
    isVisible() { return this.visible; }
    isDestroyed() { return this.destroyed; }
    show() { this.visible = true; }
    hide() { this.visible = false; }
    focus() { this.focused = true; }
    setBounds(bounds) { this.bounds = bounds; }
    setAlwaysOnTop() {}
    setOpacity() {}
    setTitle(title) { this.title = title; }
    loadURL(url) { this.urls.push(url); return Promise.resolve(); }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const controller = createCustomPageController({
    BrowserWindow,
    getWindowOptions: () => ({ icon: 'icon.png' }),
    getBounds: () => ({ x: 10, y: 20, width: 1280, height: 720 }),
    onShow: () => events.push('show'),
    onHide: reason => events.push(reason),
    focusWindow: win => { win.forcedFocus = true; },
    getSavedUrl: sourceUrl => savedUrls[sourceUrl],
    onNavigate: (sourceUrl, url) => { savedUrls[sourceUrl] = url; },
  });
  return { controller, windows, events, savedUrls };
}

test('custom pages accept only explicit web URLs and preserve route fragments', () => {
  assert.equal(normalizeCustomPageUrl(`  ${guideUrl}#route-2  `), `${guideUrl}#route-2`);
  assert.equal(normalizeCustomPageUrl('http://localhost:8000/guide?q=test'), 'http://localhost:8000/guide?q=test');
  for (const url of ['', null, {}, 'example.com', 'javascript:alert(1)', 'file:///secret', 'data:text/html,test']) {
    assert.equal(normalizeCustomPageUrl(url), '');
  }
});

test('older overlay profiles start with custom pages disabled instead of inheriting the previous guide', () => {
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const customDefaults = { customPageEnabled: false, customPageUrl: '', customPageHotkey: 'Alt+Shift+U' };
  const customSettings = { customPageEnabled: true, customPageUrl: guideUrl, customPageHotkey: 'Alt+Shift+G' };
  const profiles = { VN: { ...customSettings }, Older: {} };
  const context = vm.createContext({
    console: { log() {} },
    userSettings: { ...customSettings, overlayProfileSettings: profiles, overlayActiveProfileName: 'VN' },
    DEFAULT_USER_SETTINGS: { ...customDefaults, localVocabularyEnabled: false, hideCompletedGoals: false, hideLiveStatsOnTextOverlap: false },
    DEFAULT_GSM_PROFILE_NAME: 'Default', OVERLAY_NON_PROFILE_SETTING_KEYS: new Set(),
    OVERLAY_SETTINGS_PROFILES_ENABLED_KEY: 'overlaySettingsProfilesEnabled',
    OVERLAY_ACTIVE_PROFILE_KEY: 'overlayActiveProfileName', OVERLAY_PROFILE_SETTINGS_KEY: 'overlayProfileSettings',
  });
  for (const name of ['cloneOverlaySettingValue', 'isOverlayProfileScopedSetting', 'normalizeOverlayProfileName',
    'getOverlayProfileSettingsContainer', 'normalizeOverlaySettingsProfiles']) {
    vm.runInContext(source.match(new RegExp(`^function ${name}\\([\\s\\S]*?^}`, 'm'))[0], context);
  }
  context.normalizeOverlaySettingsProfiles();
  for (const [key, value] of Object.entries(customDefaults)) assert.equal(profiles.Older[key], value);
  for (const [key, value] of Object.entries(customSettings)) assert.equal(profiles.VN[key], value);
});

test('custom pages create no window or network request until enabled and toggled', () => {
  const { controller, windows } = setup();
  controller.toggle();
  controller.configure({ customPageEnabled: false, customPageUrl: guideUrl });
  controller.toggle();
  controller.configure({ customPageEnabled: true, customPageUrl: 'javascript:alert(1)' });
  controller.toggle();
  assert.equal(windows.length, 0);
  controller.configure({ customPageEnabled: true, customPageUrl: guideUrl });
  assert.equal(windows.length, 0);
  controller.toggle();
  assert.equal(windows.length, 1);
});

test('toggling preserves the page, isolates it from GSM, and focuses it over the game', () => {
  const { controller, windows, events } = setup();
  controller.configure({ customPageEnabled: true, customPageUrl: guideUrl });
  controller.toggle();
  const win = windows[0];
  assert.equal(controller.isVisible(), true);
  assert.equal(win.focused, true);
  assert.equal(win.forcedFocus, true);
  assert.deepEqual(win.bounds, { x: 10, y: 20, width: 1280, height: 720 });
  assert.equal(win.options.webPreferences.nodeIntegration, false);
  assert.equal(win.options.webPreferences.contextIsolation, true);
  assert.equal(win.options.webPreferences.sandbox, true);
  assert.equal(win.options.webPreferences.preload, undefined);
  assert.match(win.options.webPreferences.partition, /^persist:/);
  controller.toggle();
  assert.equal(controller.isVisible(), false);
  assert.equal(win.destroyed, false);
  controller.toggle();
  assert.deepEqual(win.urls, [guideUrl]);
  assert.deepEqual(events, ['show', 'custom-page-hotkey-hide', 'show']);
});

test('Escape and window close hide the page and preserve its state', () => {
  const { controller, windows, events } = setup();
  controller.configure({ customPageEnabled: true, customPageUrl: guideUrl });
  controller.toggle();
  const win = windows[0];
  let prevented = 0;
  win.webContents.emit('before-input-event', { preventDefault() { prevented++; } }, { type: 'keyDown', key: 'Escape' });
  assert.equal(controller.isVisible(), false);
  assert.equal(prevented, 1);
  controller.toggle();
  win.emit('close', { preventDefault() { prevented++; } });
  assert.equal(controller.isVisible(), false);
  assert.equal(win.destroyed, false);
  assert.equal(prevented, 2);
  assert.deepEqual(events, ['show', 'custom-page-escape', 'show', 'custom-page-close']);
});

test('page titles keep the overlay marker and links stay in the sandboxed page window', () => {
  const { controller, windows } = setup();
  controller.configure({ customPageEnabled: true, customPageUrl: guideUrl });
  controller.toggle();
  const win = windows[0];
  win.emit('page-title-updated', { preventDefault() {} }, 'VN Guide');
  assert.equal(win.title, 'GSM Overlay - VN Guide');
  assert.deepEqual(win.openHandler({ url: `${guideUrl}steinsgate/` }), { action: 'deny' });
  assert.deepEqual(win.urls, [guideUrl, `${guideUrl}steinsgate/`]);
  win.openHandler({ url: 'file:///secret' });
  assert.equal(win.urls.length, 2);
  for (const eventName of ['will-navigate', 'will-redirect']) {
    let prevented = false;
    win.webContents.emit(eventName, { preventDefault() { prevented = true; } }, 'javascript:alert(1)');
    assert.equal(prevented, true);
  }
});

test('changing profiles or disabling retires the old window without loading a hidden page', () => {
  const { controller, windows } = setup();
  controller.configure({ customPageEnabled: true, customPageUrl: guideUrl });
  controller.toggle();
  controller.configure({ customPageEnabled: true, customPageUrl: guideUrl });
  assert.equal(controller.isVisible(), true);
  controller.configure({ customPageEnabled: true, customPageUrl: `${guideUrl}steinsgate/` });
  assert.equal(windows[0].destroyed, true);
  assert.equal(windows.length, 1);
  controller.toggle();
  assert.deepEqual(windows[1].urls, [`${guideUrl}steinsgate/`]);
  controller.configure({ customPageEnabled: false, customPageUrl: guideUrl });
  assert.equal(windows[1].destroyed, true);
  controller.toggle();
  assert.equal(windows.length, 2);
});

test('capture loss hides without losing page state and shutdown destroys it', () => {
  const { controller, windows, events } = setup();
  controller.configure({ customPageEnabled: true, customPageUrl: guideUrl });
  controller.toggle();
  controller.hide('capture-unavailable');
  assert.equal(controller.isVisible(), false);
  controller.toggle();
  assert.deepEqual(windows[0].urls, [guideUrl]);
  controller.dispose();
  assert.equal(windows[0].destroyed, true);
  assert.equal(controller.isVisible(), false);
  assert.equal(events.at(-1), 'custom-page-dispose');
});

test('reopening the overlay resumes the last page, including in-page route changes', () => {
  const first = setup();
  first.controller.configure({ customPageEnabled: true, customPageUrl: guideUrl });
  first.controller.toggle();
  const win = first.windows[0];
  const routeUrl = `${guideUrl}steinsgate/?route=kurisu#step-12`;
  win.webContents.emit('did-navigate', {}, `${guideUrl}steinsgate/`);
  win.webContents.emit('did-navigate-in-page', {}, routeUrl, true);
  first.controller.dispose();

  const reopened = setup(JSON.parse(JSON.stringify(first.savedUrls)));
  reopened.controller.configure({ customPageEnabled: true, customPageUrl: guideUrl });
  assert.equal(reopened.windows.length, 0, 'remembering a page must not load it before the hotkey');
  reopened.controller.toggle();
  assert.deepEqual(reopened.windows[0].urls, [routeUrl]);
});

test('only the current main page is saved, excluding subframes and error pages', () => {
  const { controller, windows, savedUrls } = setup();
  controller.configure({ customPageEnabled: true, customPageUrl: guideUrl });
  controller.toggle();
  const contents = windows[0].webContents;
  const routeUrl = `${guideUrl}steinsgate/`;
  contents.emit('did-navigate', {}, routeUrl);
  contents.emit('did-navigate-in-page', {}, 'https://example.com/embedded#frame', false);
  contents.emit('did-navigate', {}, 'data:text/html,error-page');
  contents.emit('did-navigate', {}, 'file:///secret');
  controller.dispose();
  contents.emit('did-navigate', {}, 'https://example.com/late-navigation');
  assert.equal(savedUrls[guideUrl], routeUrl);
});

test('each configured URL keeps its own last page, with invalid saved URLs ignored', () => {
  const secondGuide = 'https://example.com/guide';
  const savedUrls = { [guideUrl]: `${guideUrl}steinsgate/#step-12`, [secondGuide]: 'javascript:alert(1)' };
  const { controller, windows } = setup(savedUrls);
  controller.configure({ customPageEnabled: true, customPageUrl: guideUrl });
  controller.toggle();
  assert.deepEqual(windows[0].urls, [savedUrls[guideUrl]]);
  controller.configure({ customPageEnabled: true, customPageUrl: secondGuide });
  controller.toggle();
  assert.deepEqual(windows[1].urls, [secondGuide]);
  controller.configure({ customPageEnabled: true, customPageUrl: guideUrl });
  controller.toggle();
  assert.deepEqual(windows[2].urls, [savedUrls[guideUrl]]);
});

test('navigation shortcuts reload and navigate available history', () => {
  const { controller, windows } = setup();
  controller.configure({ customPageEnabled: true, customPageUrl: guideUrl });
  controller.toggle();
  const win = windows[0];
  const press = input => win.webContents.emit('before-input-event', { preventDefault() {} }, { type: 'keyDown', ...input });
  press({ key: 'F5' });
  press({ key: 'r', control: true });
  press({ key: 'ArrowLeft', alt: true });
  press({ key: 'ArrowRight', alt: true });
  assert.equal(win.reloads, 2);
  assert.equal(win.wentBack, true);
  assert.equal(win.wentForward, undefined);
});

test('a failed load has a retry page and failures from a retired window are ignored', async () => {
  const { controller, windows } = setup();
  controller.configure({ customPageEnabled: true, customPageUrl: guideUrl });
  controller.toggle();
  const win = windows[0];
  const load = win.loadURL.bind(win);
  win.loadURL = url => {
    if (url.startsWith('https:')) { win.urls.push(url); return Promise.reject(new Error('offline')); }
    return load(url);
  };
  win.openHandler({ url: `${guideUrl}steinsgate/` });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(win.urls.at(-1), /^data:text\/html/);
  assert.match(decodeURIComponent(win.urls.at(-1)), /Could not load this page/);
  win.loadURL = load;
  win.webContents.emit('before-input-event', { preventDefault() {} }, { type: 'keyDown', key: 'F5' });
  assert.equal(win.urls.at(-1), `${guideUrl}steinsgate/`);
  assert.equal(controller.isVisible(), true);

  let rejectPending;
  win.loadURL = () => new Promise((_resolve, reject) => { rejectPending = reject; });
  win.openHandler({ url: `${guideUrl}another/` });
  controller.dispose();
  const loadCount = win.urls.length;
  rejectPending(new Error('offline'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(win.urls.length, loadCount);
});
