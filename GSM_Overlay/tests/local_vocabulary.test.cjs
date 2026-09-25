const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LocalVocabulary, jitenWords, ankiWords, sourceId } = require('../local_vocabulary');

test('Jiten exports retain real identities and map FSRS states, not enum ordinals', () => {
  const words = jitenWords({ totalCards: 4, cards: [
    { w: 1, r: 2, s: 4, t: '猫', k: 'ねこ', du: 100 },
    { w: 2, r: 0, s: 5, t: '犬', k: 'いぬ', du: 100 },
    { w: 3, r: 0, s: 2, t: '見る', k: 'みる', lr: 100, du: 100 + 22 * 86400 },
    { w: 4, r: 0, s: 6, t: '聞く', k: 'きく', lr: 100, du: 101 },
  ] });
  assert.deepEqual(words.map(w => w.knownState), [[3], [5], [2], [1, 7]]);
  assert.equal(words[0].wordId, 1);
  assert.equal(words[0].readingIndex, 2);
  assert.equal(words[2].dueAt, 100 + 22 * 86400);
  assert.throws(() => jitenWords({ totalCards: 1, cards: [] }));
  assert.throws(() => jitenWords({ cards: [{ w: 1, r: 0, s: 5 }] }));
});

test('Anki imports selected word fields and uses card maturity instead of presence', () => {
  const card = (cardId, type, interval, value, queue = 2) => ({ cardId, type, interval, queue,
    fields: { Expression: { value }, Reading: { value: 'ねこ' }, Sentence: { value: '猫を見た' } } });
  const words = ankiWords([card(1, 0, 0, '<b>猫</b>'), card(2, 2, 30, '猫'),
    card(3, 1, -600, '犬', -1)], { wordField: 'Expression', readingField: 'Reading' }, new Set([2]));
  assert.equal(words.length, 2);
  assert.deepEqual(words[0].knownState, [2, 4]);
  assert.equal(words[0].spelling, '猫');
  assert.deepEqual(words[1].knownState, [1, 7]);
  assert.throws(() => ankiWords([card(1, 2, 21, '猫')], { wordField: 'Missing' }, new Set()));
});

test('source scopes separate accounts, endpoints and Anki configurations', () => {
  assert.notEqual(sourceId('jiten', ['https://one', 'a']), sourceId('jiten', ['https://one', 'b']));
  assert.notEqual(sourceId('jiten', ['https://one', 'a']), sourceId('jiten', ['https://two', 'a']));
  assert.ok(!sourceId('jiten', ['https://one', 'secret-key']).includes('secret-key'));
});

test('failed sync preserves the snapshot and local parsing makes no network request', async () => {
  const calls = [];
  let fetches = 0;
  const service = new LocalVocabulary({
    request: async request => { calls.push(request); return { tokens: [[]] }; },
    fetch: async () => { fetches++; throw new Error('offline'); },
  });
  const config = { enabled: true, source: 'jiten', apiKey: 'test' };
  await assert.rejects(service.sync(config));
  assert.equal(calls.some(c => c.action === 'replace'), false);
  await service.parse(['猫'], config);
  assert.equal(fetches, 1);
  assert.equal(calls.at(-1).action, 'parse');
});

test('empty successful Jiten snapshots remove stale words; malformed exports do not', async () => {
  const calls = [];
  const service = new LocalVocabulary({ request: async request => { calls.push(request); return {}; },
    fetch: async () => Response.json({ totalCards: 0, cards: [] }) });
  await service.sync({ enabled: true, source: 'jiten', apiKey: 'test' });
  assert.deepEqual(calls.find(c => c.action === 'replace').words, []);
});

test('a stale Jiten pull cannot replace a state changed by an acknowledged grade', async () => {
  let finishExport;
  const calls = [];
  const service = new LocalVocabulary({ request: async request => { calls.push(request); return {}; },
    fetch: () => new Promise(resolve => { finishExport = resolve; }) });
  const config = { source: 'jiten', apiKey: 'test' };
  const pulling = service.sync(config);
  await service.updateJitenStates(config, [{ wordId: 1, readingIndex: 0, knownState: [5] }]);
  finishExport(Response.json({ totalCards: 0, cards: [] }));
  await assert.rejects(pulling, /changed during sync/);
  assert.equal(calls.some(c => c.action === 'replace'), false);
});

test('Anki sync batches selected cards and refuses a partial batch', async () => {
  const requests = [];
  const actions = [];
  let incomplete = false;
  const service = new LocalVocabulary({ request: async request => { requests.push(request); return {}; },
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body); actions.push(body);
      const ids = Array.from({ length: 501 }, (_, i) => i + 1);
      if (body.action === 'findCards') return Response.json({ error: null, result: body.params.query.includes('is:due') ? [1] : ids });
      return Response.json({ error: null, result: incomplete ? [] : body.params.cards.map(cardId => ({
        cardId, type: 2, interval: 30, queue: 2, fields: { Word: { value: `猫${cardId}` } },
      })) });
    } });
  const config = { source: 'anki', wordField: 'Word', ankiQuery: 'deck:Japanese' };
  await service.sync(config);
  assert.deepEqual(actions.filter(a => a.action === 'cardsInfo').map(a => a.params.cards.length), [500, 1]);
  assert.equal(requests.find(r => r.action === 'replace').words.length, 501);
  requests.length = 0; incomplete = true;
  await assert.rejects(service.sync(config), /incomplete card batch/);
  assert.equal(requests.some(r => r.action === 'replace'), false);
});

test('both-source refresh retains successful imports when the other service is offline', async () => {
  const requests = [];
  const service = new LocalVocabulary({ request: async request => { requests.push(request); return {}; },
    fetch: async (_url, init) => {
      if (init.method === 'POST') return Response.json({ result: [], error: null });
      throw new Error('offline');
    } });
  await assert.rejects(service.sync({ source: 'both', apiKey: 'test' }));
  assert.equal(requests.filter(r => r.action === 'replace').length, 1);
  assert.match(requests.find(r => r.action === 'replace').source, /^anki:/);
});

test('disabling local mode cancels a download without reopening the database connection', async () => {
  let finish;
  let signal;
  const requests = [];
  const service = new LocalVocabulary({ request: async request => requests.push(request),
    fetch: async (_url, init) => { signal = init.signal; return new Promise(resolve => { finish = resolve; }); } });
  const syncing = service.sync({ source: 'jiten', apiKey: 'test' });
  service.cancel();
  assert.equal(signal.aborted, true);
  finish(Response.json({ totalCards: 0, cards: [] }));
  await assert.rejects(syncing);
  assert.deepEqual(requests, []);
});
