const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDictionaryNavigation } = require('../dictionary_navigation.js');

function fixture(reader) {
  const sent = [], frameMessages = [];
  const listeners = new Map();
  const frames = [true, false, true].map((visible, index) => ({
    style: { visibility: visible ? 'visible' : 'hidden' },
    getClientRects: () => visible ? [1] : [],
    contentWindow: { postMessage: message => frameMessages.push({ index, message }) },
  }));
  const window = {
    postMessage: message => sent.push(message),
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: type => listeners.delete(type),
    gsmHachidoriBridge: { control: (action, body) => { sent.push({ action, ...body }); return Promise.resolve(true); } },
  };
  const document = { querySelectorAll: () => frames };
  return { sent, frameMessages, listeners, navigation: createDictionaryNavigation(reader, { window, document }) };
}

test('Yomitan lookup stays in the host; popup commands and mining reach only the deepest visible frame', () => {
  const h = fixture('yomitan');
  h.navigation.control('lookup-point', { x: 5, y: 10 });
  assert.equal(h.frameMessages.length, 0);
  h.navigation.control('next-entry');
  assert.deepEqual(h.frameMessages.map(item => item.index), [2]);
  h.navigation.mine();
  assert.equal(h.frameMessages.at(-1).index, 2);
});

test('Hachidori uses its bridge without dispatching Yomitan messages or requiring an iframe', () => {
  const h = fixture('hachidori');
  h.navigation.control('lookup-point', { targetId: 'word' });
  h.navigation.control('confirm-action');
  h.navigation.mine();
  h.navigation.setNavigationActive(true);
  assert.deepEqual(h.sent.map(item => item.action), ['lookup-point', 'confirm-action', 'mine', 'navigation-active']);
  assert.equal(h.frameMessages.length, 0);
  assert.equal(h.navigation.canConfirm(), true);
});

test('popup subscriptions are reader-specific and removable', () => {
  const h = fixture('hachidori');
  const stop = h.navigation.subscribe(() => {}, () => {});
  assert.deepEqual([...h.listeners.keys()], ['gsm-hachidori-popup-shown', 'gsm-hachidori-popup-hidden']);
  stop();
  assert.equal(h.listeners.size, 0);
});
