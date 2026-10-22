const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createQuickActionsBridge } = require('../quick_actions_bridge');

test('quick actions require a live backend and accept only known commands', async () => {
  const bridge = createQuickActionsBridge({ getBackend: () => null });
  await assert.rejects(bridge.request('state'), /disconnected/);
  await assert.rejects(bridge.request('exec'), /Unknown/);
});

test('backend replies are correlated, errors propagate, and late replies are ignored', async () => {
  const sent = [];
  const bridge = createQuickActionsBridge({ getBackend: () => ({ connected: true, sendImmediate: data => { sent.push(data); return true; } }) });
  const first = bridge.request('state'); const second = bridge.request('toggle-intake');
  assert.equal(bridge.receive({ type: 'another-message' }), false);
  bridge.receive({ type: 'quick-action-result', request_id: sent[1].request_id, success: true, paused: true });
  assert.equal((await second).paused, true);
  bridge.receive({ type: 'quick-action-result', request_id: sent[0].request_id, success: false, error: 'Not ready' });
  await assert.rejects(first, /Not ready/);
  assert.equal(bridge.receive({ type: 'quick-action-result', request_id: 'stale' }), true);
  bridge.destroy();
});

test('unanswered actions time out without queuing a toggle to run after reconnection', async () => {
  const bridge = createQuickActionsBridge({ getBackend: () => ({ connected: true, sendImmediate() { return true; } }), timeoutMs: 5 });
  await assert.rejects(bridge.request('toggle-intake'), /did not respond/);
});

test('a socket closing immediately before send fails without enqueuing the action', async () => {
  const bridge = createQuickActionsBridge({ getBackend: () => ({ connected: true, sendImmediate() { return false; } }) });
  await assert.rejects(bridge.request('toggle-intake'), /disconnected/);
  bridge.destroy();
});
