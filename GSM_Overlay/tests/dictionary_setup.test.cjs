const { test } = require('node:test');
const assert = require('node:assert/strict');
const { recommendedDictionary, matchesRecommendation, createDictionarySetup } = require('../dictionary_setup');
const catalogue = require('../yomitan/data/recommended-dictionaries.json');

test('resolves packaged reader resources after runtime initialization', async () => {
  let resourceRoot;
  let response;
  class Window {
    async loadURL() {}
    on() {}
    webContents = { executeJavaScript: async () => ({ installed: [], busy: false }) };
  }
  const handle = createDictionarySetup({ BrowserWindow: Window, getReader: () => 'yomitan', getExtension: () => ({ id: 'test' }),
    getResourceRoot: () => resourceRoot, openSettings: () => {}, selectReader: () => {}, send: result => { response = result; } });
  resourceRoot = require('node:path').resolve(__dirname, '..');
  await handle({ type: 'dictionary-setup', request_id: 'packaged', deadline: Date.now() + 10000, data: { action: 'status', language: 'ja' } });
  assert.equal(response.success, true, response.error);
  assert.equal(response.status.recommended.name, 'Jitendex');
});

test('starter recommendations prefer Jitendex and stay in the requested language', () => {
  assert.equal(recommendedDictionary(catalogue, 'ja').name, 'Jitendex');
  assert.equal(recommendedDictionary(catalogue, 'ko'), catalogue.ko.terms[0]);
  assert.equal(recommendedDictionary(catalogue, 'not-a-language'), null);
  assert.ok(matchesRecommendation({ title: 'Jitendex.org [2026-01-01]' }, catalogue.ja.terms[0], 'ja'));
  assert.ok(!matchesRecommendation({ title: 'Other' }, catalogue.ja.terms[0], 'ja'));
});

test('duplicate control messages share one operation and expired messages do no work', async () => {
  let opens = 0;
  const sent = [];
  class Window {
    async loadURL() {}
    on() {}
    webContents = { executeJavaScript: async () => ({ installed: [], busy: false }) };
  }
  const handle = createDictionarySetup({ BrowserWindow: Window, getReader: () => 'yomitan', getExtension: () => ({ id: 'test' }),
    openSettings: () => opens++, selectReader: () => {}, send: result => sent.push(result) });
  const message = { type: 'dictionary-setup', request_id: 'same', deadline: Date.now() + 10000, data: { action: 'open', language: 'ja' } };
  await Promise.all([handle(message), handle(message)]);
  assert.equal(opens, 1);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], sent[1]);
  await handle({ ...message, request_id: 'expired', deadline: 0 });
  assert.equal(opens, 1);
  assert.equal(sent.at(-1).success, false);
});

test('reader changes must persist before reporting success', async () => {
  const sent = [];
  class Window {
    async loadURL() {}
    on() {}
    webContents = { executeJavaScript: async () => ({ installed: [], busy: false }) };
  }
  const handle = createDictionarySetup({ BrowserWindow: Window, getReader: () => 'yomitan', getExtension: () => ({ id: 'test' }),
    openSettings: () => {}, selectReader: () => { throw new Error('disk full'); }, send: result => sent.push(result) });
  await handle({ type: 'dictionary-setup', request_id: 'select', deadline: Date.now() + 10000, data: { action: 'select', reader: 'hachidori', language: 'ja' } });
  assert.equal(sent[0].success, false);
  assert.match(sent[0].error, /disk full/);
});
