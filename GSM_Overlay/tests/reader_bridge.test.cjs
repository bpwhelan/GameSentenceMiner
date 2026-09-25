const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ExtensionBridge } = require('../extension_bridge.js');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function host() {
  const listeners = new Set();
  const sent = [];
  const window = {
    addEventListener: (_, listener) => listeners.add(listener),
    removeEventListener: (_, listener) => listeners.delete(listener),
    postMessage: message => sent.push(message),
  };
  const reply = (data, source = window) => listeners.forEach(listener => listener({ source, data }));
  return { window, sent, reply, listeners };
}

test('bridge correlates concurrent replies and ignores other windows and protocols', async () => {
  const h = host();
  const bridge = new ExtensionBridge({ window: h.window, reader: 'test' });
  const first = bridge.invoke('lookup', { text: '猫' });
  const second = bridge.invoke('status');
  const response = (index, data) => ({ type: 'gsm-test-api-response', requestId: h.sent[index].requestId, responseStatusCode: 200, data });
  h.reply(response(0, 'forged'), {});
  h.reply({ ...response(0, 'wrong reader'), type: 'gsm-other-api-response' });
  h.reply(response(1, 'ready'));
  h.reply(response(0, 'cat'));
  assert.equal(await first, 'cat');
  assert.equal(await second, 'ready');
  bridge.destroy();
  assert.equal(h.listeners.size, 0);
});

test('bridge reports errors, expires requests, and rejects calls after destruction', async () => {
  const h = host();
  const bridge = new ExtensionBridge({ window: h.window, reader: 'test', timeoutMs: 150 });
  const failed = bridge.invoke('unknown');
  h.reply({ type: 'gsm-test-api-response', requestId: h.sent[0].requestId, responseStatusCode: 404, error: 'Unsupported action' });
  await assert.rejects(failed, { message: 'Unsupported action', statusCode: 404, action: 'unknown' });
  await assert.rejects(bridge.invoke('timeout'), /timed out/);
  const pending = bridge.invoke('pending');
  bridge.destroy();
  await assert.rejects(pending, /destroyed/);
  await assert.rejects(bridge.invoke('late'), /destroyed/);
});

test('bridge instances have independent request IDs and clean up failed sends', async () => {
  const h = host();
  const a = new ExtensionBridge({ window: h.window, reader: 'test' });
  const b = new ExtensionBridge({ window: h.window, reader: 'test' });
  const first = a.invoke('one');
  const second = b.invoke('two');
  assert.notEqual(h.sent[0].requestId, h.sent[1].requestId);
  a.destroy(); b.destroy();
  await Promise.all([assert.rejects(first), assert.rejects(second)]);
  h.window.postMessage = () => { throw new Error('Cannot clone'); };
  const c = new ExtensionBridge({ window: h.window, reader: 'test' });
  await assert.rejects(c.invoke('bad'), /Cannot clone/);
  assert.equal(c._pending.size, 0);
  c.destroy();
});

test('Hachidori queues startup controls behind one handshake and sends mining exactly once', async () => {
  const h = host();
  const context = vm.createContext({ window: h.window, setTimeout, clearTimeout, console });
  for (const file of ['extension_bridge.js', 'hachidori_bridge.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  }
  const bridge = h.window.gsmHachidoriBridge;
  const mine = bridge.control('mine');
  const close = bridge.closePopups();
  assert.deepEqual(h.sent.map(request => request.action), ['capabilities']);
  h.reply({ type: 'gsm-hachidori-api-response', requestId: h.sent[0].requestId, responseStatusCode: 200, data: { version: 1 } });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(h.sent.slice(1).map(request => request.body.action), ['mine', 'hide-popup']);
  for (const request of h.sent.slice(1)) h.reply({ type: 'gsm-hachidori-api-response', requestId: request.requestId, responseStatusCode: 200, data: true });
  await Promise.all([mine, close]);
  bridge.destroy();
});
