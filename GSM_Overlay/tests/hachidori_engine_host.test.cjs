const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { between } = require('./helpers/overlay-startup.cjs');

const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const source = between(main, 'async function createHachidoriEngineWindow()', 'function readExtensionVersions()');

function setup({ nativeOffscreen = true, fail = false } = {}) {
  const calls = [];
  let window;
  class HostWindow {
    constructor() {
      window = this;
      this.webContents = {
        executeJavaScript: async () => {
          calls.push('ownership');
          if (fail) throw new Error('offscreen startup failed');
          return nativeOffscreen;
        },
      };
      this.destroyed = false;
    }
    on(_event, listener) { this.closed = listener; }
    isDestroyed() { return this.destroyed; }
    async loadURL(url) { calls.push(url); }
    once(_event, listener) { this.closed = listener; }
    destroy() { this.destroyed = true; this.closed?.(); }
  }
  const context = vm.createContext({
    BrowserWindow: HostWindow,
    hachidoriExt: { id: 'stable-id' },
    hachidoriEngineWindow: null,
    app: {}, registerOverlayEmitterListener() {},
    getOverlaySession: () => ({ getStoragePath: () => storagePath }),
    require: () => require('../shared_dictionary_engine.cjs'),
    console: { log() {}, error() {} },
  });
  const storagePath = randomUUID();
  vm.runInContext(source, context);
  return { calls, context, window: () => window, start: () => context.createHachidoriEngineWindow() };
}

test('native offscreen support starts only the extension-owned dictionary engine', async () => {
  const h = setup();
  assert.equal(await h.start(), true);
  assert.deepEqual(h.calls, ['chrome-extension://stable-id/gsm/engine-host.html', 'ownership']);
  assert.equal(h.window().destroyed, true);
  assert.equal(h.context.hachidoriEngineWindow, null);
});

test('hosts without offscreen support keep exactly one hosted engine', async () => {
  const h = setup({ nativeOffscreen: false });
  assert.equal(await h.start(), true);
  assert.equal(await h.start(), true);
  assert.deepEqual(h.calls, [
    'chrome-extension://stable-id/gsm/engine-host.html', 'ownership',
    'chrome-extension://stable-id/offscreen.html',
  ]);
  assert.equal(h.window().destroyed, false);
});

test('failed native startup closes the probe without creating a competing engine', async () => {
  const h = setup({ fail: true });
  assert.equal(await h.start(), false);
  assert.equal(h.window().destroyed, true);
  assert.equal(h.context.hachidoriEngineWindow, null);
  assert.equal(h.calls.some(call => call.endsWith?.('/offscreen.html')), false);
});

test('native engine ownership waits for persisted dictionaries to finish loading', async () => {
  const engineHost = fs.readFileSync(path.join(__dirname, '../integrations/hachidori/engine-host.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '');
  let requests = 0;
  const context = vm.createContext({
    chromeOffscreenSupported: () => true,
    ensureChromeOffscreen: async () => {},
    chrome: { runtime: { sendMessage: async message => {
      assert.equal(message.type, 'hd_status');
      ++requests;
      if (requests === 1) throw new Error('Could not establish connection. Receiving end does not exist.');
      return { ok: true, ready: requests > 2, loading: requests === 2 };
    } } },
    setTimeout, clearTimeout,
    Date,
  });
  vm.runInContext(engineHost, context);
  assert.equal(await context.GsmHachidoriEngineHost, true);
  assert.equal(requests, 3);
});
