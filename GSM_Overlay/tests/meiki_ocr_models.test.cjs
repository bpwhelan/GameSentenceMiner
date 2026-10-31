const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMeikiModelRequest } = require('../meiki_ocr_models');

test('overlay uses the shared backend selector and current transport port', async () => {
  const calls = [];
  const request = createMeikiModelRequest(() => 12345, async (...args) => {
    calls.push(args);
    return { ok: true, json: async () => ({ model: 'large', available: true }) };
  });
  await request();
  await request({ model: 'large' });
  assert.equal(calls[0][0], 'http://127.0.0.1:12345/api/ocr/meiki-model');
  assert.equal(calls[0][1].method, 'GET');
  assert.equal(calls[1][1].method, 'POST');
  assert.equal(calls[1][1].body, '{"model":"large"}');
  await assert.rejects(request({ model: '../../other' }), /model size/);
  assert.equal(calls.length, 2);
});

test('overlay reports backend connection and response errors', async () => {
  const request = createMeikiModelRequest(() => 12345, async () => ({ ok: false, status: 503 }));
  await assert.rejects(request(), /HTTP 503/);
});
