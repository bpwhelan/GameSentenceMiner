const { test } = require('node:test');
const assert = require('node:assert/strict');
// Fail closed if a regression bypasses the injected transport (including the
// previous implementation's direct http.request path). Tests never need Jiten.
require('node:http').request = require('node:https').request = () => {
  throw new Error('Live network access is forbidden in Jiten unit tests');
};
const { JitenParseCache } = require('../jiten_cache');

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const auth = { apiKey: 'test-key' };
test('Reader write IDs coalesce retries but preserve separate intentional grades', async (t) => {
  const { cache, calls } = setup(t, {}, () => Response.json({ ok: true }));
  const args = { ...auth, action: 'srs/review', body: { wordId: 1, readingIndex: 0, rating: 3 }, requestId: 'operation-1' };
  await Promise.all([cache.request(args), cache.request(args)]);
  await cache.request(args);
  assert.equal(calls.length, 1);
  await assert.rejects(cache.request({ ...args, body: { wordId: 2 } }), { statusCode: 409 });
  await cache.request({ ...args, requestId: 'operation-2' });
  assert.equal(calls.length, 2);
});

test('failed Reader write receipts survive the service cooldown', async (t) => {
  const { cache, calls } = setup(t, {}, () => new Response('', { status: 503 }));
  const args = { ...auth, action: 'srs/review', body: { wordId: 1 }, requestId: 'failed-operation' };
  await assert.rejects(cache.request(args), { statusCode: 503 });
  cache._scope(auth).blockedUntil = 0;
  await assert.rejects(cache.request(args), { statusCode: 503 });
  assert.equal(calls.length, 1);
});

test('an aborted running write cannot be replayed by a Reader retry', async (t) => {
  let finish;
  const { cache, calls } = setup(t, {}, () => finish ? Response.json({ ok: true }) : new Promise(resolve => { finish = resolve; }));
  const controller = new AbortController();
  const args = { ...auth, action: 'srs/review', body: { wordId: 1, readingIndex: 0, rating: 3 } };
  const pending = cache.request({ ...args, signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  while (!finish) await pause(1);
  controller.abort();
  await rejected;
  finish(Response.json({ ok: true }));
  await pause(5);
  await assert.rejects(cache.request(args), { statusCode: 409 });
  assert.equal(calls.length, 1);
});

test('inconsistent token end offsets are rejected before caching', async (t) => {
  const { cache } = setup(t, {}, (_url, body) => {
    const payload = fixture(body.text);
    payload.tokens[0][0].end = 999;
    return Response.json(payload);
  });
  await assert.rejects(cache.parse({ ...auth, text: '猫' }), /Invalid Jiten token/);
  assert.equal(cache.getStats().cachedParagraphs, 0);
});
function fixture(texts) {
  return {
    tokens: texts.map((text) => [{ wordId: text.codePointAt(0), readingIndex: 0, start: 0, end: text.length, length: text.length }]),
    vocabulary: texts.map((text) => ({ wordId: text.codePointAt(0), readingIndex: 0, spelling: text, reading: `${text}[ねこ]`, knownState: [0], studyDeckIds: [] })),
  };
}
function setup(t, options = {}, respond) {
  const calls = [];
  const cache = new JitenParseCache({
    batchDelayMs: 5, minIntervalMs: 0, parseIntervalMs: 0,
    fetch: async (url, init) => {
      const body = init.body ? JSON.parse(init.body) : {};
      calls.push({ url, body, at: Date.now(), headers: init.headers });
      if (respond) return respond(url, body, calls.length);
      return Response.json(fixture(body.text));
    },
    ...options,
  });
  t.after(() => cache.dispose());
  return { cache, calls };
}

test('batches a burst and deduplicates overlapping renderer and Reader paragraphs', async (t) => {
  const { cache, calls } = setup(t);
  const results = await Promise.all([
    cache.parse({ ...auth, text: '猫です' }),
    cache.parse({ ...auth, text: '犬です' }),
    cache.parseMany({ ...auth, texts: ['犬です', '猫です', '猫です'] }),
  ]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, { text: ['猫です', '犬です'] });
  assert.deepEqual(results[2].tokens.map((row) => row[0].wordId), ['犬', '猫', '猫'].map((x) => x.codePointAt(0)));
  assert.equal(results[2].vocabulary.length, 2);
});

test('partial cache hits only send missing text and preserve empty and duplicate rows', async (t) => {
  const { cache, calls } = setup(t);
  await cache.parse({ ...auth, text: '猫' });
  const result = await cache.parseMany({ ...auth, texts: ['猫', 'English — café ＡＢＣ', '', '犬', '猫'] });
  assert.deepEqual(calls.map((call) => call.body.text), [['猫'], ['犬']]);
  assert.equal(result.tokens.length, 5);
  assert.deepEqual(result.tokens[1], []);
  assert.deepEqual(result.tokens[2], []);
  assert.deepEqual(result.tokens[0], result.tokens[4]);
});

test('does not query punctuation, accents, Cyrillic, Hangul, or fullwidth Latin', async (t) => {
  const { cache, calls } = setup(t);
  await cache.parseMany({ ...auth, texts: ['…', 'café', 'Привет', '한국어', 'ＡＢＣ１２３', 'カナ', 'かな', '𠮷'] });
  assert.deepEqual(calls[0].body.text, ['カナ', 'かな', '𠮷']);
});

test('cache and inflight requests are isolated by credential and endpoint', async (t) => {
  const { cache, calls } = setup(t);
  await Promise.all([
    cache.parse({ apiKey: 'one', text: '猫' }),
    cache.parse({ apiKey: 'two', text: '猫' }),
    cache.parse({ apiKey: 'one', endpoint: 'https://example.test/api/reader/parse', text: '猫' }),
  ]);
  assert.equal(calls.length, 3);
  await cache.parse({ apiKey: 'one', text: '猫' });
  assert.equal(calls.length, 3);
});

test('long-lived syntax refreshes states without reparsing and keeps UTF-16 offsets', async (t) => {
  const { cache, calls } = setup(t, { stateTtlMs: 15 }, (url, body) =>
    Response.json(url.endsWith('lookup-vocabulary') ? { result: body.words.map(() => [2]), decks: body.words.map(() => [42]) } : fixture(body.text)));
  await cache.parse({ ...auth, text: '𠮷野' });
  await pause(20);
  const result = await cache.parse({ ...auth, text: '𠮷野' });
  assert.equal(calls.length, 2);
  assert.ok(calls[1].url.endsWith('lookup-vocabulary'));
  assert.deepEqual(result.vocabulary[0].knownState, [2]);
  assert.deepEqual(result.vocabulary[0].studyDeckIds, [42]);
  assert.equal(result.tokens[0][0].end, 3);
});

test('successful empty parses are cached', async (t) => {
  const { cache, calls } = setup(t, {}, (_url, body) => Response.json({ tokens: body.text.map(() => []), vocabulary: [] }));
  await cache.parse({ ...auth, text: 'ん' });
  await cache.parse({ ...auth, text: 'ん' });
  assert.equal(calls.length, 1);
});

test('429 Retry-After blocks different texts and never automatically retries', async (t) => {
  const { cache, calls } = setup(t, {}, () => new Response('Too many requests', { status: 429, headers: { 'Retry-After': '60' } }));
  await assert.rejects(cache.parse({ ...auth, text: '猫' }), { statusCode: 429 });
  await assert.rejects(cache.parse({ ...auth, text: '犬' }), { statusCode: 429 });
  assert.equal(calls.length, 1);
});

test('401 latches rejected credentials, but a changed key works', async (t) => {
  const { cache, calls } = setup(t, {}, (_url, body, count) => count === 1 ? new Response('', { status: 401 }) : Response.json(fixture(body.text)));
  await assert.rejects(cache.parse({ ...auth, text: '猫' }));
  await assert.rejects(cache.parse({ ...auth, text: '犬' }));
  await cache.parse({ apiKey: 'changed', text: '犬' });
  assert.equal(calls.length, 2);
});

test('malformed responses fail once without poisoning cache or amplifying requests', async (t) => {
  const { cache, calls } = setup(t, {}, () => Response.json({ tokens: [], vocabulary: [] }));
  await assert.rejects(cache.parseMany({ ...auth, texts: ['猫', '犬'] }));
  await assert.rejects(cache.parse({ ...auth, text: '猫' }));
  assert.equal(calls.length, 1);
});

test('limits request size and serializes upstream batches', async (t) => {
  let active = 0;
  let peak = 0;
  const { cache, calls } = setup(t, { maxBatchCharacters: 5, minIntervalMs: 25 }, async (_url, body) => {
    peak = Math.max(peak, ++active);
    await pause(10);
    --active;
    return Response.json(fixture(body.text));
  });
  const result = await cache.parseMany({ ...auth, texts: ['猫です', '犬です', '鳥です'] });
  assert.equal(result.tokens.length, 3);
  assert.equal(calls.length, 3);
  assert.equal(peak, 1);
  assert.ok(calls[1].at - calls[0].at >= 23);
});

test('cancels obsolete queued paragraphs without cancelling shared consumers', async (t) => {
  const { cache, calls } = setup(t, { batchDelayMs: 30 });
  const controller = new AbortController();
  const old = cache.parseMany({ ...auth, texts: ['古い', '共有'], signal: controller.signal });
  const rejected = assert.rejects(old, { name: 'AbortError' });
  const current = cache.parseMany({ ...auth, texts: ['共有', '新しい'] });
  controller.abort();
  await Promise.all([rejected, current]);
  assert.deepEqual(calls[0].body.text, ['共有', '新しい']);
});

test('cached results cannot be changed by a consumer', async (t) => {
  const { cache } = setup(t);
  const first = await cache.parse({ ...auth, text: '猫' });
  first.tokens[0][0].start = 99;
  first.vocabulary[0].knownState.push(99);
  const second = await cache.parse({ ...auth, text: '猫' });
  assert.equal(second.tokens[0][0].start, 0);
  assert.deepEqual(second.vocabulary[0].knownState, [0]);
});

test('replaying 300 OCR frames with 20 repeated lines sends one parse batch', async (t) => {
  const { cache, calls } = setup(t);
  const texts = Array.from({ length: 20 }, (_x, i) => `猫がいる${i}`);
  for (let frame = 0; frame < 300; frame++) await cache.parseMany({ ...auth, texts });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.text.length, 20);
  assert.equal(cache.getStats().cacheHits, 299 * 20);
});

test('rolling character budget delays batches independently of request spacing', async (t) => {
  const { cache, calls } = setup(t, { characterBudget: 2000, budgetWindowMs: 60, maxBatchParagraphs: 1 });
  await cache.parseMany({ ...auth, texts: ['猫', '犬'] });
  assert.ok(calls[1].at - calls[0].at >= 58);
});

test('metadata reads coalesce/cache, while intentional writes are never deduplicated', async (t) => {
  const { cache, calls } = setup(t, {}, (url) => Response.json(url.endsWith('reader-study-decks') ? { decks: [] } : { ok: true }));
  await Promise.all(Array.from({ length: 10 }, () => cache.request({ ...auth, action: 'srs/reader-study-decks' })));
  await cache.request({ ...auth, action: 'srs/reader-study-decks' });
  assert.equal(calls.length, 1);
  await Promise.all(Array.from({ length: 2 }, () => cache.request({ ...auth, action: 'srs/review', body: { wordId: 1, readingIndex: 0, rating: 3 } })));
  assert.equal(calls.length, 3);
});

test('grading invalidates state without discarding expensive syntax', async (t) => {
  let knownState = [0];
  const { cache, calls } = setup(t, {}, (url, body) => {
    if (url.endsWith('reader/parse')) return Response.json(fixture(body.text));
    if (url.endsWith('srs/review')) { knownState = [2]; return Response.json({ ok: true }); }
    return Response.json({ result: body.words.map(() => knownState), decks: body.words.map(() => [3]) });
  });
  const first = await cache.parse({ ...auth, text: '猫' });
  await cache.request({ ...auth, action: 'srs/review', body: { wordId: first.vocabulary[0].wordId, readingIndex: 0, rating: 3 } });
  const second = await cache.parse({ ...auth, text: '猫' });
  assert.deepEqual(second.vocabulary[0].knownState, [2]);
  assert.equal(calls.filter(call => call.url.endsWith('reader/parse')).length, 1);
});

test('failed refresh retains most recently learned state and cached readings', async (t) => {
  let lookups = 0;
  const { cache, calls } = setup(t, { stateTtlMs: 10 }, (url, body) => {
    if (url.endsWith('reader/parse')) return Response.json(fixture(body.text));
    if (++lookups === 1) return Response.json({ result: body.words.map(() => [5]), decks: body.words.map(() => [99]) });
    throw new Error('offline');
  });
  await cache.parse({ ...auth, text: '猫' });
  await pause(20);
  await cache.parse({ ...auth, text: '猫' });
  await pause(20);
  const result = await cache.parse({ ...auth, text: '猫' });
  assert.deepEqual(result.vocabulary[0].knownState, [5]);
  assert.deepEqual(result.vocabulary[0].studyDeckIds, [99]);
  await cache.parse({ ...auth, text: '猫' });
  assert.equal(calls.length, 3);
});

test('LRU hits retain recent paragraphs and caches obey byte bounds', async (t) => {
  const { cache, calls } = setup(t, { maxEntries: 2 });
  await cache.parse({ ...auth, text: '猫' });
  await cache.parse({ ...auth, text: '犬' });
  await cache.parse({ ...auth, text: '猫' });
  await cache.parse({ ...auth, text: '鳥' });
  await cache.parse({ ...auth, text: '犬' });
  assert.equal(calls.length, 4);
  assert.equal(cache.getStats().cachedParagraphs, 2);
  const tiny = setup(t, { maxBytes: 100 }).cache;
  await tiny.parse({ ...auth, text: '猫' });
  assert.ok(tiny.getStats().cacheBytes <= 100);
});

test('queue overflow releases partially admitted requests without sending them', async (t) => {
  const { cache, calls } = setup(t, { maxPending: 2 });
  await assert.rejects(cache.parseMany({ ...auth, texts: ['猫', '犬', '鳥'] }), { statusCode: 429 });
  await pause(20);
  assert.equal(calls.length, 0);
  assert.equal(cache.getStats().pending, 0);
});

test('shutdown rejects queued consumers and prevents requests', async (t) => {
  const { cache, calls } = setup(t);
  const pending = cache.parse({ ...auth, text: '猫' });
  const rejected = assert.rejects(pending, /closed/);
  cache.dispose();
  await rejected;
  await pause(20);
  assert.equal(calls.length, 0);
});

test('errors never replay a potentially successful SRS write', async (t) => {
  const { cache, calls } = setup(t, {}, () => { throw new Error('Connection lost after sending body'); });
  await assert.rejects(cache.request({ ...auth, action: 'srs/review', body: { wordId: 1 } }));
  await assert.rejects(cache.request({ ...auth, action: 'srs/review', body: { wordId: 1 } }));
  assert.equal(calls.length, 1);
});

test('parse budget waiting does not block newly arrived explicit actions', async (t) => {
  const { cache, calls } = setup(t, { characterBudget: 2000, budgetWindowMs: 120 }, (url, body) => Response.json(url.endsWith('reader/parse') ? fixture(body.text) : { ok: true }));
  await cache.parse({ ...auth, text: '猫' });
  const next = cache.parse({ ...auth, text: '犬' });
  await pause(15);
  await cache.request({ ...auth, action: 'srs/review', body: { wordId: 1 } });
  assert.ok(calls[1].url.endsWith('srs/review'));
  await next;
});
