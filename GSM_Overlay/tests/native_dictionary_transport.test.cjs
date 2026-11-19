const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('the desktop preload scopes the feed and suppresses the external Shift-click bridge in embedded pages', () => {
  const preload = fs.readFileSync(path.resolve(__dirname, '../../src-tauri/preloads/desktop_preload.js'), 'utf8');
  function load(url, { desktop = true, frame = false } = {}) {
    const listeners = new Map();
    const root = { dataset: {} };
    const document = { documentElement: null, addEventListener: (type, listener) => listeners.set(type, listener) };
    const window = { ipcRenderer: {}, __TAURI_INTERNALS__: { invoke() {} }, addEventListener: document.addEventListener };
    window.top = frame ? {} : window;
    vm.runInNewContext(preload, {
      window, document, location: new URL(url), __GSM_WINDOW_TOKEN__: 'fixture', __GSM_DEV_ORIGIN__: null,
      __GSM_RESTRICT_TO_FEED__: desktop,
    });
    document.documentElement = root;
    listeners.get('DOMContentLoaded')?.();
    return { scope: root.dataset.gsmReaderScope, shiftClick: listeners.has('click') };
  }
  assert.deepEqual(load('http://gsm.localhost/renderer/index.html'), { scope: 'feed', shiftClick: false });
  assert.deepEqual(load('http://localhost:7275/overview', { frame: true }), { scope: 'disabled', shiftClick: false });
  assert.deepEqual(load('http://gsm-yomitan.localhost/popup.html', { frame: true }), { scope: undefined, shiftClick: false });
  assert.deepEqual(load('https://example.org/', { desktop: false }), { scope: undefined, shiftClick: true });
});

function setup() {
  const timers = new Map(); let next = 0;
  const config = {id: 'fixture', base: 'http://gsm-hachidori.localhost', manifest: {name: 'Hachidori'}};
  const context = vm.createContext({__GSM_INVOKE__: async () => null,
    __GSM_DICTIONARY_CONFIG__: {...config, extensions: [config]},
    location: new URL(`${config.base}/offscreen.html`), navigator: {language: 'en'},
    document: {readyState: 'complete'}, frames: [], fetch: async () => {}, console,
    setTimeout: callback => { const id = ++next; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
  });
  vm.runInContext('globalThis.window = globalThis; window.top = window;', context);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../src-tauri/preloads/dictionary_preload.js'), 'utf8'), context);
  return {timers, onMessage: context.chrome.runtime.onMessage,
    dispatch: () => context.__GSM_DICTIONARY_DISPATCH__('fixture', 'message', [{type: 'lookup'}, {}], null)};
}

test('successful dictionary replies release their timeout immediately, including busy sessions', async () => {
  const f = setup();
  f.onMessage.addListener((_message, _sender, respond) => {respond({results: ['食べる']}); return true;});
  for (let i = 0; i < 1000; ++i) {
    const reply = await f.dispatch();
    assert.equal(reply.handled, true); assert.equal(reply.value.results[0], '食べる');
  }
  assert.equal(f.timers.size, 0, 'completed lookups must not retain 55-second timers/closures');
});

test('promise listeners clean up after success, rejection and unanswered messages', async () => {
  for (const listener of [async () => 'ok', async () => {throw Error('unavailable');}, async () => undefined]) {
    const f = setup(); f.onMessage.addListener(listener); await f.dispatch();
    assert.equal(f.timers.size, 0);
  }
  const f = setup(); assert.equal((await f.dispatch()).handled, false); assert.equal(f.timers.size, 0);
});

test('an unresponsive dictionary still times out and releases its timer', async () => {
  const f = setup(); f.onMessage.addListener(() => true);
  const pending = f.dispatch();
  assert.equal(f.timers.size, 1);
  f.timers.values().next().value();
  await assert.rejects(pending, /timed out/); assert.equal(f.timers.size, 0);
});
