const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('Windows Yomitan lookups share a successful backend handshake and can retry a failed one', async () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../src-tauri/preloads/yomitan_lookup.js'), 'utf8');
  const calls = [];
  let acknowledge;
  const lookup = vm.runInNewContext(source, {setTimeout, clearTimeout, chrome: {runtime: {
    async sendMessage({action, params}) {
      calls.push(action);
      if (action === 'requestBackendReadySignal') {
        if (calls.length === 1) throw Error('worker is starting');
        await new Promise(resolve => { acknowledge = resolve; });
        return {result: true};
      }
      assert.equal(action, 'termsFind');
      assert.equal(params.optionsContext.current, true);
      return {result: params.text};
    },
  }}});
  await assert.rejects(lookup('最初'), /worker is starting/);
  const concurrent = [lookup('日本'), lookup('辞書')];
  assert.deepEqual(calls, ['requestBackendReadySignal', 'requestBackendReadySignal']);
  acknowledge();
  assert.deepEqual(await Promise.all(concurrent), ['日本', '辞書']);
  assert.equal(await lookup('読む'), '読む');
  assert.deepEqual(calls.slice(2), ['termsFind', 'termsFind', 'termsFind']);
});

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

function setup(invoke = async () => null) {
  const timers = new Map(); let next = 0;
  const config = {id: 'fixture', base: 'http://gsm-hachidori.localhost', manifest: {name: 'Hachidori'}};
  const context = vm.createContext({__GSM_INVOKE__: invoke, crypto: require('node:crypto'),
    __GSM_DICTIONARY_CONFIG__: {...config, extensions: [config]},
    location: new URL(`${config.base}/offscreen.html`), navigator: {language: 'en'},
    document: {readyState: 'complete'}, frames: [], fetch: async () => {}, console,
    setTimeout: callback => { const id = ++next; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
  });
  vm.runInContext('globalThis.window = globalThis; window.top = window;', context);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../src-tauri/preloads/dictionary_preload.js'), 'utf8'), context);
  return {timers, tabs: context.chrome.tabs, onMessage: context.chrome.runtime.onMessage,
    dispatch: (message = {type: 'lookup'}) => context.__GSM_DICTIONARY_DISPATCH__('fixture', 'message', [message, {}], null)};
}

test('a cross-frame port reply reaches the caller after both onConnect events', async () => {
  const deliveries = [];
  const f = setup((_command, {params}) => {
    assert.equal(params.operation, 'tabs.connect');
    return new Promise(resolve => deliveries.push(resolve));
  });
  f.onMessage.addListener((_message, _sender, respond) => {
    f.tabs.connect(1, {frameId: 0});
    f.tabs.connect(1, {frameId: 2});
    respond('connected');
  });
  let replied = false;
  const pending = f.dispatch({action: 'openCrossFramePort'}).then(result => {
    replied = true;
    return result.value;
  });
  assert.equal(deliveries.length, 2);
  deliveries[0]();
  await new Promise(setImmediate);
  assert.equal(replied, false);
  deliveries[1]();
  assert.equal(await pending, 'connected');
  assert.equal(f.timers.size, 0);
});

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
