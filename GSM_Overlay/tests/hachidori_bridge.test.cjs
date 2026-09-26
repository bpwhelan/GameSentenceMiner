const { test } = require('node:test');
const assert = require('node:assert/strict');
const { install, isGsmHost } = require('../integrations/hachidori/bridge.js');

function setup() {
  const events = new Map(), replies = [], calls = [];
  const window = {
    location: { href: 'file:///C:/GSM/GameSentenceMiner/GSM_Overlay/index.html' },
    addEventListener: (name, fn) => events.set(name, fn),
    removeEventListener: name => events.delete(name),
    postMessage: data => replies.push(data),
    dispatchEvent() {},
    GsmHachidoriPopup: { create: () => ({ control(action) { calls.push(action); return true; }, refresh() {}, destroy() {} }) },
  };
  const document = { documentElement: { dataset: {} }, querySelector: () => null };
  const api = {
    state: () => ({ disposed: false, levels: [], options: { scanLength: 20, maxResults: 5 }, dictionaries: [] }),
    ready: () => Promise.resolve(),
    sendRequest: async (...args) => { calls.push(args); return { ok: true }; },
    resolveCandidate: () => ({ query: '猫' }), resolveCandidateAt() {},
    candidateSignature: candidate => candidate.query,
    sameAnchorNode: (candidate, other) => !!other && candidate.anchor === other.anchor,
    lookupCandidate: candidate => calls.push(candidate), hide: () => calls.push('hide'),
    cancelHover: () => calls.push('cancelHover'), command: action => calls.push(action),
  };
  const bridge = install(api, { window, document });
  const send = async (action, body = {}, source = window) => {
    await events.get('message')({ source, data: { type: 'gsm-hachidori-api-request', requestId: String(replies.length), action, body } });
    return replies.at(-1);
  };
  return { bridge, api, window, document, events, replies, calls, send };
}

test('only GSM overlay URLs get a privileged bridge', () => {
  assert.equal(isGsmHost('https://example.com/GSM_Overlay/index.html'), false);
  assert.equal(isGsmHost('file:///C:/Downloads/index.html'), false);
  assert.equal(isGsmHost('file:///C:/GSM/GSM_Overlay/index.html'), true);
  assert.equal(isGsmHost('file:///C:/app/resources/app.asar/index.html'), true);
  assert.equal(isGsmHost('http://127.0.0.1:5174/'), true);
  assert.equal(isGsmHost('http://127.0.0.1:5174/unrelated'), false);
});

test('capability discovery and native requests use fixed routes and preserve lookup defaults', async () => {
  const h = setup();
  const capabilities = await h.send('capabilities');
  assert.equal(capabilities.data.version, 1);
  assert.ok(capabilities.data.actions.includes('terms'));
  await h.send('terms', { text: '猫', target: 'attacker', type: 'hd_remove' });
  assert.deepEqual(h.calls.at(-1), ['hd_lookup', { text: '猫', scanLength: 20, maxResults: 5, options: {} }, 'hoshidicts-offscreen']);
  const response = await h.send('unknown');
  assert.equal(response.responseStatusCode, 404);
  h.bridge.destroy();
  assert.equal(h.events.size, 0);
});

test('foreign messages are ignored and invalid commands return errors without side effects', async () => {
  const h = setup();
  await h.send('terms', { text: 'cat' }, {});
  assert.equal(h.replies.length, 0);
  const bad = await h.send('control', { action: 'eval', code: 'malicious' });
  assert.equal(bad.responseStatusCode, 404);
  assert.equal(h.calls.length, 0);
  h.bridge.destroy();
});

test('hide cancels a lookup that is still waiting for reader startup', async () => {
  const h = setup();
  let ready;
  h.api.ready = () => new Promise(resolve => { ready = resolve; });
  const lookup = h.send('control', { action: 'lookup-point', x: 10, y: 20 });
  await h.send('control', { action: 'hide-popup' });
  ready();
  await lookup;
  assert.ok(h.calls.includes('hide'));
  assert.equal(h.calls.some(call => call?.query === '猫'), false);
  h.bridge.destroy();
});

test('navigation state suppresses hover and is cleaned up on destroy', async () => {
  const h = setup();
  await h.send('control', { action: 'navigation-active', active: true });
  assert.equal(h.bridge.navigationActive, true);
  assert.ok(h.calls.includes('cancelHover'));
  h.bridge.destroy();
  assert.equal(h.bridge.navigationActive, false);
});

test('controller lookup reuses a matching pending or visible native lookup', async () => {
  for (const pending of [true, false]) {
    const h = setup();
    const candidate = { query: '猫', anchor: { isConnected: true } };
    const root = { lookupToken: 7, popup: { hidden: false, inert: pending },
      activeCandidate: candidate, activeSignature: '猫' };
    h.api.resolveCandidate = () => ({ ...candidate });
    h.api.state = () => ({ levels: [root], pendingCandidateLookup: pending
      ? { token: 7, candidate, signature: '猫' } : null });
    assert.equal((await h.send('control', { action: 'lookup-point', x: 10, y: 20 })).data, true);
    assert.equal(h.calls.some(call => call?.query === '猫'), false);
    h.bridge.destroy();
  }
});

test('controller retargeting stops hover timers without clearing the pending popup', async () => {
  const h = setup();
  let hoverOptions;
  h.api.cancelHover = options => { hoverOptions = options; };
  await h.send('control', { action: 'lookup-point', x: 10, y: 20 });
  assert.deepEqual(hoverOptions, { preserveLookup: true });
  assert.ok(h.calls.some(call => call?.query === '猫'));
  h.bridge.destroy();
});

test('hidden, invalidated, or differently anchored lookups do not suppress a new request', async () => {
  for (const scenario of ['hidden', 'invalidated', 'different-anchor']) {
    const h = setup();
    const candidate = { query: '猫', anchor: { isConnected: true } };
    const root = { lookupToken: 8, popup: { hidden: scenario === 'hidden', inert: scenario === 'invalidated' },
      activeCandidate: candidate, activeSignature: '猫' };
    h.api.resolveCandidate = () => scenario === 'different-anchor'
      ? { ...candidate, anchor: { isConnected: true } } : candidate;
    h.api.state = () => ({ levels: [root], pendingCandidateLookup: scenario === 'invalidated'
      ? { token: 7, candidate, signature: '猫' } : null });
    await h.send('control', { action: 'lookup-point', x: 10, y: 20 });
    assert.ok(h.calls.some(call => call?.query === '猫'), scenario);
    h.bridge.destroy();
  }
});
