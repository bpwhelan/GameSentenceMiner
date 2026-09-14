const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { textContainsJapanese } = require('../furigana_utils');

test('shipped Reader bundles reuse one request ID across retries', async () => {
  for (const name of ['background-worker.js', 'settings.js']) {
    const source = fs.readFileSync(path.join(__dirname, '../jiten.reader/js', name), 'utf8');
    const start = source.indexOf('const requestByUrl =');
    const end = source.indexOf('\n};', start) + 4;
    const calls = [];
    let sequence = 0;
    const context = vm.createContext({
      URL, AbortSignal, MAX_RETRIES: 3, REQUEST_TIMEOUT_MS: 30000, INITIAL_BACKOFF_MS: 500,
      rejectedApiToken: undefined, crypto: { randomUUID: () => `operation-${++sequence}` },
      wait: async () => {}, isRetryable: () => true,
      fetch: async (_url, init) => {
        calls.push(init.headers['X-GSM-Request-Id']);
        return { status: calls.length % 2 ? 503 : 200, ok: calls.length % 2 === 0, json: async () => ({ ok: true }) };
      },
    });
    vm.runInContext(source.slice(start, end) + '\nglobalThis.request = requestByUrl;', context);
    await context.request('https://example.test/api', 'srs/review', {}, { apiToken: 'test' });
    await context.request('https://example.test/api', 'srs/review', {}, { apiToken: 'test' });
    assert.deepEqual(calls, ['operation-1', 'operation-1', 'operation-2', 'operation-2']);
  }
});

function loadHighlighter() {
  let now = 10_000;
  let nextId = 0;
  const timers = new Map();
  const elements = [];
  let observer;
  const events = [];
  const createElement = (tag) => {
    const element = {
      tag, style: {}, dataset: {}, children: [], isConnected: true, words: false, unparsedWords: false,
      appendChild(child) { this.children.push(child); },
      set innerHTML(_value) { this.children = []; this.words = false; this.unparsedWords = false; },
      querySelectorAll(selector) {
        if (selector === '.jiten-word:not(.unparsed)') return this.words ? [{}] : [];
        if (selector === '.jiten-word') return (this.words || this.unparsedWords) ? [{}] : [];
        if (selector === 'p[data-line-index]') return this.children;
        return [];
      },
    };
    elements.push(element);
    return element;
  };
  const document = {
    body: { appendChild() {} }, createElement,
    getElementById: id => elements.find(el => el.id === id),
    querySelectorAll: () => [], createTreeWalker: () => ({ nextNode: () => null }),
  };
  const context = vm.createContext({
    window: { addEventListener() {}, dispatchEvent: event => events.push(event) },
    document, console, module: { exports: {} }, NodeFilter: { SHOW_TEXT: 4 },
    MutationObserver: class { constructor(callback) { observer = callback; } observe() {} },
    KeyboardEvent: class { constructor(type) { this.type = type; } },
    Date: class extends Date { static now() { return now; } },
    setTimeout: (fn, delay) => { const id = ++nextId; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../jiten_highlight.js'), 'utf8'), context);
  const tick = duration => {
    const end = now + duration;
    while (true) {
      const next = [...timers.entries()].filter(([_id, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]); now = next[1].at; next[1].fn();
    }
    now = end;
  };
  return {
    api: context.module.exports, tick,
    parses: () => events.filter(event => event.type === 'keydown').length,
    paragraphs: () => document.getElementById('jiten-parse-container').children,
    complete: () => { document.getElementById('jiten-parse-container').words = true; observer(); tick(200); },
    completeUnparsed: () => { document.getElementById('jiten-parse-container').unparsedWords = true; observer(); tick(200); },
  };
}

test('highlight coalescing emits the newest frame on the next task and keeps original line indices', () => {
  const { api, tick, parses, paragraphs } = loadHighlighter();
  api.requestParse([{ text: '古い' }]);
  api.requestParse([{ text: 'English — café' }, { text: '新しい' }]);
  assert.equal(parses(), 0);
  tick(0);
  assert.equal(parses(), 1);
  assert.equal(paragraphs().length, 1);
  assert.equal(paragraphs()[0].textContent, '新しい');
  assert.equal(paragraphs()[0].dataset.lineIndex, '1');
});

test('identical pending and active highlight frames do not retrigger the Reader', () => {
  const { api, tick, parses, complete } = loadHighlighter();
  for (let i = 0; i < 30; i++) { api.requestParse([{ text: '猫' }]); tick(20); }
  assert.equal(parses(), 1);
  complete();
  for (let i = 0; i < 100; i++) { api.requestParse([{ text: '猫' }]); tick(20); }
  assert.equal(parses(), 1);
});

test('slow Reader parsing retains just the latest waiting frame', () => {
  const { api, tick, parses, complete, paragraphs } = loadHighlighter();
  api.requestParse([{ text: '猫' }]); tick(0);
  for (let i = 0; i < 10; i++) { api.requestParse([{ text: `犬${i}` }]); tick(30); }
  assert.equal(parses(), 1);
  assert.equal(paragraphs()[0].textContent, '猫');
  complete();
  assert.equal(parses(), 2);
  assert.equal(paragraphs()[0].textContent, '犬9');
});

test('an all-unparsed Reader result releases the newest waiting frame', () => {
  const { api, tick, parses, completeUnparsed, paragraphs } = loadHighlighter();
  api.requestParse([{ text: '猫' }]); tick(0);
  api.requestParse([{ text: '犬' }]);
  assert.equal(parses(), 1);

  completeUnparsed();

  assert.equal(parses(), 2);
  assert.equal(paragraphs()[0].textContent, '犬');
});

test('disabling highlighting or clearing text cancels a pending parse', () => {
  const { api, tick, parses } = loadHighlighter();
  api.requestParse([{ text: '猫' }]);
  api.setEnabled(false); tick(1000);
  assert.equal(parses(), 0);
  api.setEnabled(true);
  api.requestParse([{ text: '犬' }]);
  api.clearJitenHighlighting(); tick(1000);
  assert.equal(parses(), 0);
});

test('furigana script filter includes kana and extended kanji, excludes wide Latin', () => {
  for (const text of ['ひらがな', 'カタカナ', 'ｶﾅ', '𠮷', '猫']) assert.equal(textContainsJapanese(text), true);
  for (const text of ['café', 'English — text', 'ＡＢＣ', 'Привет', '한국어', '…']) assert.equal(textContainsJapanese(text), false);
});

function loadGamepad(invoke) {
  const context = vm.createContext({ module: { exports: {} }, window: { ipcRenderer: { invoke } }, console });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../gamepad.js'), 'utf8'), context);
  const handler = Object.create(context.module.exports.prototype);
  handler.config = { tokenizerBackend: 'jiten-api', jitenApiKey: 'test' };
  handler.normalizeFuriganaSegments = segments => segments;
  handler.getBackendAttemptOrder = () => ['jiten-api', 'sudachi'];
  return { handler, context };
}

test('furigana sends one IPC batch and maps every response row to its source line', async () => {
  const calls = [];
  const { handler } = loadGamepad(async (channel, args) => {
    calls.push({ channel, args });
    return { tokens: [[{ start: 0 }], [{ start: 3 }]], vocabulary: [] };
  });
  handler.convertJitenPayloadToFuriganaSegments = (payload, text) => [{ text, start: payload.tokens[0][0].start }];
  const results = await handler.requestJitenFuriganaFrame([{ text: '猫' }, { text: '犬' }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].channel, 'gsm-jiten-parse-frame');
  assert.equal(results[0].segments[0].text, '猫');
  assert.equal(results[1].segments[0].start, 3);
});

test('failed batch falls back locally without one Jiten retry per line', async () => {
  let calls = 0;
  const { handler } = loadGamepad(async () => { calls++; throw new Error('429'); });
  const backends = [];
  handler.requestFuriganaWithBackend = async (backend, text) => { backends.push(backend); return { segments: [{ text }] }; };
  const results = await handler.requestJitenFuriganaFrame([{ text: '猫' }, { text: '犬' }]);
  assert.equal(calls, 1);
  assert.deepEqual(backends, ['sudachi', 'sudachi']);
  assert.equal(results.length, 2);
});

test('unchanged furigana frames share pending and completed IPC results', async () => {
  let calls = 0;
  let resolve;
  const { handler } = loadGamepad(() => { calls++; return new Promise(done => { resolve = done; }); });
  handler.convertJitenPayloadToFuriganaSegments = () => [];
  const pending = Array.from({ length: 10 }, () => handler.requestJitenFuriganaFrame([{ text: '猫' }]));
  resolve({ tokens: [[]], vocabulary: [] });
  await Promise.all(pending);
  for (let i = 0; i < 100; i++) await handler.requestJitenFuriganaFrame([{ text: '猫' }]);
  assert.equal(calls, 1);
});

test('obsolete responses and account changes do not render or trigger fallback', async () => {
  let resolve;
  const { handler } = loadGamepad(() => new Promise(done => { resolve = done; }));
  handler.requestFuriganaWithBackend = () => assert.fail('stale fallback');
  const pending = handler.requestJitenFuriganaFrame([{ text: '猫' }]);
  handler.config.jitenApiKey = 'changed';
  resolve({ tokens: [[]], vocabulary: [] });
  assert.equal((await pending).length, 0);
});

test('missing IPC cannot bypass the broker with a direct fetch', async () => {
  const { handler, context } = loadGamepad();
  context.window.ipcRenderer = null;
  context.fetch = () => assert.fail('direct Jiten fetch');
  await assert.rejects(handler.requestJitenParse('猫'), /broker is unavailable/);
});

test('OCR highlighting reserves Jiten parsing for the authoritative final payload', () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.match(html, /const JITEN_SETTINGS_RESYNC_THROTTLE_MS = 1000;/);
  const start = html.indexOf('function applyJitenHighlightingForLines');
  const end = html.indexOf('// Initialize highlight module', start);
  const calls = [];
  const context = vm.createContext({
    jitenHighlightingEnabled: true,
    jitenReaderEnabled: true,
    jitenHighlightAvailable: true,
    lastJitenSettingsSyncAt: Date.now(),
    JITEN_SETTINGS_RESYNC_THROTTLE_MS: 1000,
    jitenHighlightParsedLineId: false,
    syncJitenSettings() {},
    Date,
    console,
    window: {
      GsmJitenHighlight: {
        requestParse: (lines) => { calls.push(lines); return Promise.resolve(); },
        reposition() {},
      },
    },
  });
  vm.runInContext(`${html.slice(start, end)}\nglobalThis.applyHighlight = applyJitenHighlightingForLines;`, context);

  context.applyHighlight([{ text: '途中' }], { lineId: 'line-1', isFinal: false });
  assert.equal(calls.length, 0);
  context.applyHighlight([{ text: '確定' }], { lineId: 'line-1', isFinal: true });
  assert.equal(calls.length, 1);
  context.applyHighlight([{ text: '単発' }], { lineId: null, isFinal: false });
  assert.equal(calls.length, 2);
});

test('Jiten availability recovery preserves authoritative OCR metadata', () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const start = html.indexOf('function applyVerifiedJitenAvailability');
  const end = html.indexOf('function jitenSettingTruthy', start);
  const calls = [];
  const context = vm.createContext({
    jitenHighlightAvailable: false,
    jitenReaderEnabled: true,
    jitenHighlightingEnabled: true,
    lastJitenHighlightLines: [{ text: '途中' }],
    lastJitenHighlightMeta: { lineId: 'line-1', isFinal: false },
    applyJitenHighlightingForLines: (lines, meta) => calls.push({ lines, meta }),
    console,
    window: {
      GsmJitenHighlight: {
        setAvailable() {},
        refresh: () => calls.push({ bypassedGate: true }),
      },
    },
  });
  vm.runInContext(`${html.slice(start, end)}\nglobalThis.applyAvailability = applyVerifiedJitenAvailability;`, context);

  context.applyAvailability(true, false);

  assert.deepEqual(calls, [{
    lines: context.lastJitenHighlightLines,
    meta: context.lastJitenHighlightMeta,
  }]);
});

test('all overlay inline scripts remain syntactically valid', () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc\s*=|type\s*=\s*["'](?:module|application\/json)/i.test(match[1])) continue;
    new vm.Script(match[2]);
  }
});
