const { test } = require('node:test');
const assert = require('node:assert/strict');
require('node:http').request = require('node:https').request = () => {
  throw new Error('Live network access is forbidden in Jiten unit tests');
};
const { JitenParseCache } = require('../jiten_cache');

const auth = { apiKey: 'offline-test' };
const sentence = 'ラジカル６に効き目のある【抗ウイルス薬】――それを投与することです。';
const unbracketed = sentence.replace(/[【】]/gu, '');
const lexemes = ['抗ウイルス薬', 'ラジカル', '効き目', 'それ', '投与', 'ある', 'する', 'こと', 'です',
  'ルナ', '続く', '𠮷野', '新宿', '学校', 'ゲーム', 'コーヒー', '６', 'に', 'の', 'を', '猫', 'が', 'いる', '駅', '前', '宿'];
const wordPattern = new RegExp(lexemes.join('|'), 'gu');
const sentenceWords = ['ラジカル', '６', 'に', '効き目', 'の', 'ある', '抗ウイルス薬', 'それ', 'を', '投与', 'する', 'こと', 'です'];

function fixture(texts) {
  const vocabulary = new Map();
  const tokens = texts.map(text => Array.from(text.matchAll(wordPattern), match => {
    const wordId = lexemes.indexOf(match[0]) + 1;
    vocabulary.set(wordId, { wordId, readingIndex: 0, spelling: match[0], reading: match[0], knownState: [0], studyDeckIds: [] });
    return { wordId, readingIndex: 0, start: match.index, length: match[0].length, end: match.index + match[0].length };
  }));
  return { tokens, vocabulary: [...vocabulary.values()] };
}

function setup(t, options = {}) {
  const calls = [];
  const cache = new JitenParseCache({
    batchDelayMs: 0, minIntervalMs: 0, parseIntervalMs: 0,
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url, body });
      return Response.json(url.endsWith('reader/parse') ? fixture(body.text)
        : { result: body.words.map(() => [2]), decks: body.words.map(() => [42]) });
    },
    ...options,
  });
  t.after(() => cache.dispose());
  return { cache, calls, parseCalls: () => calls.filter(call => call.url.endsWith('reader/parse')) };
}

function surfaces(text, result) {
  return result.tokens[0].map(token => {
    assert.equal(token.end, token.start + token.length);
    assert.ok(token.start >= 0 && token.end <= text.length);
    const surface = text.slice(token.start, token.end);
    assert.equal(surface, result.vocabulary.find(word => word.wordId === token.wordId).spelling);
    return surface;
  });
}

for (const [label, cachedText, requestedText] of [
  ['added name', sentence, `ルナ\n${sentence}`],
  ['removed name', `ルナ\n${sentence}`, sentence],
  ['joined name', sentence, `ルナ${sentence}`],
  ['added suffix', sentence, `${sentence}\n続く`],
  ['removed suffix', `${sentence}\n続く`, sentence],
  ['added prefix and suffix', sentence, `ルナ\n${sentence}\n続く`],
  ['removed prefix and suffix', `ルナ\n${sentence}\n続く`, sentence],
  ['removed brackets', sentence, unbracketed],
  ['added brackets', unbracketed, sentence],
  ['punctuation and whitespace', sentence, ` 「${unbracketed.replace('――', '…')}」 \r\n`],
  ['combined name and punctuation', sentence, `ルナ\n${unbracketed}`],
  ['combined removal', `ルナ\n${sentence}`, unbracketed],
]) {
  test(`cached dialogue survives ${label} with correctly remapped offsets`, async t => {
    const { cache, parseCalls } = setup(t);
    await cache.parse({ ...auth, text: cachedText });
    const result = await cache.parse({ ...auth, text: requestedText });
    assert.equal(parseCalls().length, 1, 'only the original paragraph should reach Jiten');
    assert.deepEqual(surfaces(requestedText, result), sentenceWords);
    assert.deepEqual(result.vocabulary.map(word => word.spelling), [...new Set(sentenceWords)]);
    assert.equal(cache.getStats().cacheHits, 1);
    assert.equal(cache.getStats().variantCacheHits, 1);
  });
}

test('punctuation remapping keeps supplementary characters and later token offsets intact', async t => {
  const { cache, parseCalls } = setup(t);
  await cache.parse({ ...auth, text: `𠮷野「${sentence}」` });
  const text = `𠮷野 ${unbracketed}`;
  const result = await cache.parse({ ...auth, text });
  assert.equal(parseCalls().length, 1);
  assert.deepEqual(surfaces(text, result), ['𠮷野', ...sentenceWords]);
  assert.equal(result.tokens[0][0].length, 3);
  assert.equal(result.tokens[0].find(token => lexemes[token.wordId - 1] === '投与').start, text.indexOf('投与'));
});

test('exact parses take precedence and retain tokens for the speaker', async t => {
  const { cache, parseCalls } = setup(t);
  const text = `ルナ\n${sentence}`;
  await cache.parseMany({ ...auth, texts: [sentence, text] });
  const result = await cache.parse({ ...auth, text });
  assert.equal(parseCalls().length, 1);
  assert.deepEqual(surfaces(text, result), ['ルナ', ...sentenceWords]);
  assert.equal(cache.getStats().variantCacheHits, 0);
});

test('overlap matching prefers the cached paragraph covering more of the request', async t => {
  const { cache, parseCalls } = setup(t);
  await cache.parseMany({ ...auth, texts: [`ルナ\n${sentence}`, sentence] });
  const text = `ルナ\n${unbracketed}\n続く`;
  const result = await cache.parse({ ...auth, text });
  assert.equal(parseCalls().length, 1);
  assert.deepEqual(surfaces(text, result), ['ルナ', ...sentenceWords]);
});

test('short matches, changed words, and large additions still request a fresh parse', async t => {
  for (const [cachedText, text] of [
    ['猫', '猫がいる'],
    [sentence, sentence.replace('効き目', '学校')],
    [sentence, `${sentence}猫がいる`.repeat(2)],
    ['ゲーム', 'ゲム'],
    ['コーヒー', 'コヒ'],
    [sentence, sentence.replace('６', '6')],
  ]) {
    const { cache, parseCalls } = setup(t);
    await cache.parse({ ...auth, text: cachedText });
    await cache.parse({ ...auth, text });
    assert.equal(parseCalls().length, 2);
  }
});

test('a substring that cuts through a cached word is not assigned that word', async t => {
  const { cache, parseCalls } = setup(t);
  await cache.parse({ ...auth, text: '新宿駅前にある抗ウイルス薬を投与することです。' });
  await cache.parse({ ...auth, text: '宿駅前にある抗ウイルス薬を投与することです。' });
  assert.equal(parseCalls().length, 2);
});

test('punctuation inserted inside a word cannot reuse incompatible reading offsets', async t => {
  const { cache, parseCalls } = setup(t);
  await cache.parse({ ...auth, text: sentence });
  await cache.parse({ ...auth, text: sentence.replace('抗ウイルス薬', '抗【ウイルス】薬') });
  assert.equal(parseCalls().length, 2);
});

test('cache variants remain isolated by account and endpoint', async t => {
  const { cache, parseCalls } = setup(t);
  await cache.parse({ ...auth, text: sentence });
  await cache.parse({ apiKey: 'different', text: unbracketed });
  await cache.parse({ ...auth, endpoint: 'https://example.test/api/reader/parse', text: unbracketed });
  assert.equal(parseCalls().length, 3);
});

test('expired and evicted paragraphs cannot supply variant hits', async t => {
  const expired = setup(t, { ttlMs: 10 });
  await expired.cache.parse({ ...auth, text: sentence });
  await new Promise(resolve => setTimeout(resolve, 25));
  await expired.cache.parse({ ...auth, text: unbracketed });
  assert.equal(expired.parseCalls().length, 2);

  const evicted = setup(t, { maxEntries: 1 });
  await evicted.cache.parse({ ...auth, text: sentence });
  await evicted.cache.parse({ ...auth, text: '猫がいる' });
  await evicted.cache.parse({ ...auth, text: unbracketed });
  assert.equal(evicted.parseCalls().length, 3);
  assert.equal(evicted.cache.getStats().cachedParagraphs, 1);
});

test('variant hits refresh source recency without extending its lifetime', async t => {
  const { cache, parseCalls } = setup(t, { maxEntries: 2 });
  await cache.parse({ ...auth, text: sentence });
  const source = [...cache._entries.entries.values()][0];
  const expiresAt = source.expiresAt;
  await cache.parse({ ...auth, text: '猫がいる' });
  await cache.parse({ ...auth, text: unbracketed });
  assert.equal(source.expiresAt, expiresAt);
  await cache.parse({ ...auth, text: '学校' });
  await cache.parse({ ...auth, text: `ルナ\n${sentence}` });
  assert.equal(parseCalls().length, 3);
});

test('partial hits do not turn uncached prefixes into cached syntax', async t => {
  const { cache, parseCalls } = setup(t);
  await cache.parse({ ...auth, text: sentence });
  await cache.parse({ ...auth, text: `ルナ\n${sentence}` });
  assert.equal(cache.getStats().cachedParagraphs, 1);
  assert.equal(cache.getCached('ルナ', auth), null);
  await cache.parse({ ...auth, text: 'ルナ' });
  assert.deepEqual(parseCalls().map(call => call.body.text), [[sentence], ['ルナ']]);
});

test('variant results are independent copies and use current vocabulary states', async t => {
  const { cache, calls, parseCalls } = setup(t);
  await cache.parse({ ...auth, text: sentence });
  const first = cache.getCached(unbracketed, auth);
  assert.ok(first);
  first.tokens[0][0].start = 999;
  first.vocabulary[0].knownState.push(99);
  assert.equal(cache.getCached(sentence, auth).tokens[0][0].start, 0);
  assert.deepEqual(cache.getCached(unbracketed, auth).vocabulary[0].knownState, [0]);
  cache.invalidateState(auth);
  const result = await cache.parse({ ...auth, text: unbracketed });
  assert.deepEqual(surfaces(unbracketed, result), sentenceWords);
  assert.ok(result.vocabulary.every(word => word.knownState[0] === 2 && word.studyDeckIds[0] === 42));
  assert.equal(parseCalls().length, 1);
  assert.equal(calls.filter(call => call.url.endsWith('lookup-vocabulary')).length, 1);
});
