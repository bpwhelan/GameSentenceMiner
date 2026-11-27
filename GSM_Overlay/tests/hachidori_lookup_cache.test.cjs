const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const create = async options => (await import('../integrations/hachidori/lookup-cache.mjs')).createLookupCache(options);

test('native lookup cache reuses only identical calls in the same engine generation', async () => {
  const cache = await create(); let calls = 0;
  const engine = {ccall: (...args) => JSON.stringify({call: ++calls, args})};
  const check = () => {};
  const read = (generation, word = '食べた', options = '{}') => cache.call(generation, engine, check, 'hdw_lookup', 'string', ['string'], [word, 32, 16, options]);
  assert.equal(read(1), read(1)); assert.equal(calls, 1);
  read(1, '読んだ'); read(1, '食べた', '{"frequencyOrder":"descending"}');
  assert.equal(calls, 3);
  read(2); assert.equal(calls, 4, 'dictionary imports, removals, order and reload invalidate results');
  read(1); assert.equal(calls, 5, 'a new engine incarnation can reuse an old generation number');
});

test('failed native lookups are never cached and can recover', async () => {
  const cache = await create(); let failed = true, calls = 0;
  const engine = {ccall: () => {++calls; return '{}';}};
  const check = () => {if (failed) throw Error('engine unavailable');};
  const read = () => cache.call(1, engine, check, 'hdw_lookup', 'string', [], []);
  assert.throws(read, /unavailable/); failed = false; read(); read();
  assert.equal(calls, 2);
});

test('native cache is bounded by bytes and entries, evicts least recently used results', async () => {
  const cache = await create({maxEntries: 2, maxBytes: 120}); let calls = 0;
  const engine = {ccall: (_name, _type, _types, [text]) => {++calls; return text;}};
  const read = text => cache.call(1, engine, () => {}, 'lookup', 'string', ['string'], [text]);
  read('a'); read('b'); read('a'); read('c'); read('a'); assert.equal(calls, 3);
  read('b'); assert.equal(calls, 4);
  read('x'.repeat(100)); read('x'.repeat(100)); assert.equal(calls, 6, 'oversized results bypass cache');
  assert.ok(cache.bytes <= 120); assert.ok(cache.size <= 2);
});

test('a cached lookup is independent of the native error from an unrelated failed operation', async () => {
  const cache = await create(); let failed = false;
  const engine = {ccall: () => '{"results":[],"dictionaryCount":1}'};
  const check = () => {if (failed) throw Error('previous native operation failed');};
  const source = fs.readFileSync(path.resolve(__dirname, '../hachidori/engine-service.js'), 'utf8');
  const body = source.match(/async hd_lookup\(message\) \{([\s\S]*?)\n  \},/)[1];
  const lookup = vm.runInNewContext(`(async function(message) {${body}})`, {
    engine, throwIfEngineFailed: check, ensureLoaded: async () => {}, lookupArguments: () => ['食べる'],
    gsmLookup: (...args) => cache.call(1, engine, check, ...args),
    withDefinitionTags: reply => reply, withoutPersonalDictionary: reply => reply,
    withoutKanjiWordFrequencies: reply => reply, termLookupReply: JSON.parse, kanaRuby: () => false,
  });
  await lookup({}); failed = true;
  assert.equal((await lookup({})).dictionaryCount, 1);
});
