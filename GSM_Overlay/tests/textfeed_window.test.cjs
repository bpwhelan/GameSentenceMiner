const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { between } = require('./helpers/overlay-startup.cjs');

const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');

test('TextFeed retains the window-monitor overlay identifier when the page title changes', () => {
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.title = options.title;
    }
    isDestroyed() { return false; }
    setTitle(title) { this.title = title; }
    setOpacity() {}
    loadPageTitle(title) {
      let prevented = false;
      this.emit('page-title-updated', { preventDefault() { prevented = true; } }, title);
      if (!prevented) this.title = title;
    }
  }
  const context = vm.createContext({
    BrowserWindow, texthookerWindow: null, userSettings: {}, DEFAULT_TEXTHOOKER_URL: 'http://127.0.0.1/texthooker',
    refreshOverlayTransportSettingsFromGSM() {}, getCurrentOverlayMonitor: () => ({}),
    getOverlayBoundsForDisplay: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    getOverlayAppIconPath: () => '', getWindowsFramelessWindowOptions: () => ({}),
    waitForTexthookerUrl() {},
  });
  vm.runInContext(between(source, 'function createTexthookerWindow()', 'function waitForTexthookerUrl('), context);
  context.createTexthookerWindow();
  const win = context.texthookerWindow;
  assert.match(win.title, /GSM Overlay/, 'the native title must be recognized before the page loads');
  for (const title of ['GSM TextFeed', 'GSM Text Feed', 'My custom reading window', '']) {
    win.loadPageTitle(title);
    assert.match(win.title, /GSM Overlay/, 'web page titles must not remove the overlay identifier');
    if (title) assert.ok(win.title.includes(title), 'preserve the configured TextFeed title');
  }
});
