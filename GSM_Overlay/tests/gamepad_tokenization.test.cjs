const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup() {
  const timers = new Map();
  const events = [];
  let timerId = 0;
  const context = vm.createContext({
    module: { exports: {} }, console: { log() {}, warn() {} },
    window: { dispatchEvent: event => events.push(event) },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../gamepad.js'), 'utf8'), context);
  const handler = Object.create(context.module.exports.prototype);
  Object.assign(handler, {
    config: { tokenizerBackend: 'yomitan-api', localTokenizerFallbackBackend: 'sudachi' },
    destroyed: false, currentBlockIndex: 0, currentCursorIndex: 0,
    characters: [], textBlocks: [{ text: '猫' }], tokens: [], tokensBlockIndex: -1,
    tokenCacheByBlock: new Map(), pendingTokenizationByBlock: new Map(),
    pendingTokenizationStartedWhileNavigationActive: new Map(), pendingTokenizationRequests: new Map(),
    pendingFuriganaRequests: new Map(), furiganaRequestId: 0, tokenizationRequestId: 0,
    isNavigationActive: () => false, updateModeIndicatorText: () => {},
    getCurrentAnchorCharIndex: () => 0,
  });
  handler.getBlockText = index => handler.textBlocks[index]?.text || '';
  return { handler, timers, events };
}

test('an old response cannot clear a newer request or replace its cached tokens', async () => {
  const { handler } = setup();
  const old = deferred();
  const current = deferred();
  handler.requestYomitanTokenize = text => text === '猫' ? old.promise : current.promise;
  handler.convertYomitanContentToTokens = (_content, text) => [{ word: text, start: 0, end: 1 }];
  const first = handler.requestTokenizationForBlock(0);
  handler.textBlocks[0].text = '犬';
  const second = handler.requestTokenizationForBlock(0);
  old.resolve([]);
  await first;
  assert.equal(handler.pendingTokenizationByBlock.get(0), '犬');
  assert.equal(handler.tokenCacheByBlock.size, 0);
  current.resolve([]);
  await second;
  assert.equal(handler.tokenCacheByBlock.get(0).text, '犬');
  assert.equal(handler.tokens[0].word, '犬');
  assert.equal(handler.pendingTokenizationByBlock.size, 0);
});

test('a superseded async failure does not start a fallback for the old text', async () => {
  const { handler } = setup();
  const old = deferred();
  const current = deferred();
  const fallbackTexts = [];
  handler.requestYomitanTokenize = text => text === '猫' ? old.promise : current.promise;
  handler.requestTokenizationFromServer = (_index, text) => { fallbackTexts.push(text); throw Error('offline'); };
  const first = handler.requestTokenizationForBlock(0);
  handler.textBlocks[0].text = '犬';
  const second = handler.requestTokenizationForBlock(0);
  old.reject(Error('slow backend failed'));
  await first;
  assert.deepEqual(fallbackTexts, []);
  assert.equal(handler.pendingTokenizationByBlock.get(0), '犬');
  current.resolve([]);
  await second;
});

test('cancelled requests cannot update a newly requested copy of the same text', async () => {
  const { handler } = setup();
  const old = deferred();
  const current = deferred();
  let calls = 0;
  handler.requestYomitanTokenize = () => ++calls === 1 ? old.promise : current.promise;
  handler.convertYomitanContentToTokens = content => content;
  const first = handler.requestTokenizationForBlock(0);
  handler.cancelPendingTokenization('Tokenizer settings changed');
  const second = handler.requestTokenizationForBlock(0);
  current.resolve([{ word: 'new', start: 0, end: 1 }]);
  await second;
  old.resolve([{ word: 'old', start: 0, end: 1 }]);
  await first;
  assert.equal(handler.tokens[0].word, 'new');
});

test('removed blocks discard late token responses without recreating cache entries', () => {
  const { handler } = setup();
  handler.textBlocks = [];
  handler.currentBlockIndex = -1;
  handler.onTokensReceived({ blockIndex: 0, text: '猫', tokens: [{ word: '猫', start: 0, end: 1 }] });
  assert.equal(handler.tokenCacheByBlock.size, 0);
});

test('furigana send failures clear pending requests and timeout handlers', async () => {
  const { handler, timers } = setup();
  handler.wsConnected = true;
  handler.sudachiAvailable = true;
  handler.ws = { send() { throw Error('socket closed'); } };
  await assert.rejects(handler.requestFuriganaFromServer('猫'), /socket closed/);
  assert.equal(handler.pendingFuriganaRequests.size, 0);
  assert.equal(timers.size, 0);
});

test('expired furigana replies do not emit results for obsolete requests', () => {
  const { handler, events } = setup();
  handler.onFuriganaReceived({ requestId: 1, lineIndex: 0, text: '猫', segments: [] });
  assert.equal(events.length, 0);
});

test('server replies require the current request identity even when the text is unchanged', async () => {
  const { handler, timers } = setup();
  const sent = [];
  handler.config.tokenizerBackend = 'sudachi';
  handler.wsConnected = true;
  handler.sudachiAvailable = true;
  handler.ws = { send: json => sent.push(JSON.parse(json)) };
  const first = handler.requestTokenizationForBlock(0);
  handler.cancelPendingTokenization();
  const second = handler.requestTokenizationForBlock(0);
  await first;
  const response = { blockIndex: 0, text: '猫', tokenSource: 'sudachi', sudachiAvailable: true };
  handler.onTokensReceived({ ...response, requestId: sent[0].requestId, tokens: [{ word: 'old', start: 0, end: 1 }] });
  assert.equal(handler.tokens.length, 0);
  assert.equal(handler.pendingTokenizationRequests.size, 1);
  handler.onTokensReceived({ ...response, requestId: sent[1].requestId, tokens: [{ word: '猫', start: 0, end: 1 }] });
  await second;
  assert.equal(handler.tokens[0].word, '猫');
  assert.equal(timers.size, 0);
});

test('server timeouts release deduplication state and permit a later retry', async () => {
  const { handler, timers } = setup();
  const sent = [];
  handler.config.tokenizerBackend = 'sudachi';
  handler.wsConnected = true;
  handler.sudachiAvailable = true;
  handler.ws = { send: json => sent.push(JSON.parse(json)) };
  const first = handler.requestTokenizationForBlock(0);
  for (const callback of [...timers.values()]) callback();
  await first;
  assert.equal(handler.pendingTokenizationByBlock.size, 0);
  assert.equal(handler.pendingTokenizationRequests.size, 0);
  assert.equal(timers.size, 0);
  const second = handler.requestTokenizationForBlock(0);
  assert.equal(sent.length, 2);
  handler.cancelPendingTokenization();
  await second;
  assert.equal(timers.size, 0);
});

test('unavailable local tokenizer responses try the configured fallback', async () => {
  const { handler } = setup();
  const sent = [];
  handler.config = { tokenizerBackend: 'sudachi', localTokenizerFallbackBackend: 'mecab' };
  handler.wsConnected = handler.sudachiAvailable = handler.mecabAvailable = true;
  handler.ws = { send: json => sent.push(JSON.parse(json)) };
  const result = handler.requestTokenizationForBlock(0);
  handler.onTokensReceived({ ...sent[0], tokenSource: 'sudachi', sudachiAvailable: false, tokens: [] });
  await Promise.resolve();
  assert.equal(sent[1].backend, 'mecab');
  handler.onTokensReceived({ ...sent[1], tokenSource: 'mecab', mecabAvailable: true, tokens: [{ word: '猫', start: 0, end: 1 }] });
  await result;
  assert.equal(handler.tokens[0].word, '猫');
});

test('remote UTF-16 token offsets map to glyph indices without splitting astral characters', async () => {
  const { handler } = setup();
  handler.textBlocks[0].text = '𠮷野家は猫';
  handler.requestYomitanTokenize = async () => [[{ text: '𠮷野家' }], [{ text: 'は' }], [{ text: '猫' }]];
  await handler.requestTokenizationForBlock(0);
  assert.deepEqual(Array.from(handler.tokens, token => [token.word, token.start, token.end]), [
    ['𠮷野家', 0, 3], ['は', 3, 4], ['猫', 4, 5],
  ]);
});

test('empty remote tokenization falls back to whole Unicode characters', async () => {
  const { handler } = setup();
  handler.textBlocks[0].text = '𠮷猫';
  handler.requestYomitanTokenize = async () => [];
  await handler.requestTokenizationForBlock(0);
  assert.deepEqual(Array.from(handler.tokens, token => [token.word, token.start, token.end]), [
    ['𠮷', 0, 1], ['猫', 1, 2],
  ]);
});

test('invalid tokenizer ranges are ignored and local code point offsets remain unchanged', () => {
  const { handler } = setup();
  const tokens = handler.normalizeNavigationTokens([
    null, { word: 'bad', start: -1, end: 1 }, { word: 'bad', start: 0, end: 20 },
    { word: '𠮷', start: 0, end: 1 }, { word: '猫', start: 1, end: 2 },
  ], '𠮷猫', 'sudachi');
  assert.deepEqual(Array.from(tokens, token => [token.word, token.start, token.end]), [
    ['𠮷', 0, 1], ['猫', 1, 2],
  ]);
});

test('losing tokens preserves the character anchor when navigation falls back to characters', async () => {
  const { handler } = setup();
  handler.textBlocks[0].text = '猫は犬を見る';
  handler.tokens = [{ word: '猫は', start: 0, end: 2 }, { word: '犬を見る', start: 2, end: 6 }];
  handler.currentCursorIndex = 1;
  handler.tokenMode = true;
  handler.isNavigationActive = () => true;
  handler.getCurrentAnchorCharIndex = () => 2;
  handler.getLineIndexForCursor = () => 0;
  handler.updateVisuals = handler.syncVirtualMouseToCurrentSelection = () => {};
  handler.onTokensReceived({ blockIndex: 0, text: '猫は犬を見る', tokens: [] });
  assert.equal(handler.currentCursorIndex, 2);
});
