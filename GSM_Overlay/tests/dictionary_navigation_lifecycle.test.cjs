const assert = require('node:assert/strict');
const test = require('node:test');
const { createDictionaryNavigation } = require('../dictionary_navigation.js');

function fixture(reader) {
  const listeners = new Map(), shown = [], hidden = [], frames = [];
  let resolveState;
  const window = {
    postMessage() {},
    addEventListener: (type, callback) => listeners.set(type, callback),
    removeEventListener: type => listeners.delete(type),
    gsmHachidoriBridge: { state: () => new Promise(resolve => { resolveState = resolve; }) },
  };
  const navigation = createDictionaryNavigation(reader, { window, document: { querySelectorAll: () => frames } });
  return {
    navigation, shown, hidden, frames, listeners,
    subscribe: () => navigation.subscribe(event => shown.push(event.detail), event => hidden.push(event.detail)),
    emit: (suffix, popupId) => listeners.get(`gsm-hachidori-popup-${suffix}`)({ detail: { popupId } }),
    state: async popups => { resolveState({ popups }); await Promise.resolve(); },
  };
}

test('Yomitan subscriptions discover popups already visible when navigation is enabled', () => {
  const f = fixture('yomitan');
  f.frames.push(
    { style: { visibility: 'visible' }, getClientRects: () => [1] },
    { style: { visibility: 'hidden' }, getClientRects: () => [1] },
    { style: { visibility: 'visible' }, getClientRects: () => [1] },
  );
  const stop = f.subscribe();
  assert.equal(f.shown.length, 2);
  stop();
  assert.equal(f.listeners.size, 0);
});

test('Hachidori state hydration keeps existing parents when a child opens during the request', async () => {
  const f = fixture('hachidori');
  f.subscribe();
  f.emit('shown', 'child');
  await f.state([{ popupId: 'parent' }, { popupId: 'child' }]);
  assert.deepEqual(f.shown.map(item => item.popupId).sort(), ['child', 'parent']);
});

test('Hachidori state hydration does not resurrect a closed popup or drop unaffected popups', async () => {
  const f = fixture('hachidori');
  f.subscribe();
  f.emit('hidden', 'child');
  await f.state([{ popupId: 'parent' }, { popupId: 'child' }]);
  assert.deepEqual(f.shown, [{ popupId: 'parent' }]);
  assert.deepEqual(f.hidden, [{ popupId: 'child' }]);
});

test('disposed Hachidori subscriptions ignore late state responses', async () => {
  const f = fixture('hachidori');
  const stop = f.subscribe();
  stop();
  await f.state([{ popupId: 'parent' }]);
  assert.deepEqual(f.shown, []);
  assert.equal(f.listeners.size, 0);
});
