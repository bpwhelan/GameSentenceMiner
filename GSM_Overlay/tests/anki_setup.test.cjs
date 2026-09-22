const assert = require('node:assert/strict');
const test = require('node:test');
const { configureProfile, createSetupHandler } = require('../anki_setup.js');

function fixture() {
  const options = {
    version: 77, profileCurrent: 0, global: { untouched: true },
    profiles: [{ name: 'Personal', conditionGroups: [], options: {
      general: { resultOutputMode: 'split', theme: 'dark' },
      dictionaries: [{ name: 'My dictionary', enabled: true }],
      anki: { enable: false, server: 'http://old', tags: ['mine'], fieldTemplates: 'custom',
        cardFormats: [
          { name: 'Expression', icon: 'big-circle', type: 'term', model: 'Old model', deck: 'Old deck',
            fields: { Front: { value: '{expression}', overwriteMode: 'append' } } },
          { name: 'Reading', icon: 'small-circle', type: 'term', model: 'Old model', deck: 'Old deck',
            fields: { Front: { value: '{reading}', overwriteMode: 'skip' } } },
          { name: 'Kanji', icon: 'big-square', type: 'kanji', model: 'Kanji', deck: 'Characters',
            fields: { Character: { value: '{character}', overwriteMode: 'coalesce' } } },
        ],
      },
    } }],
  };
  const input = { preset: 'lapis', model: 'Lapis', deck: 'Mining', server: 'http://127.0.0.1:8765',
    tags: ['required-for-gsm'],
    fields: { Expression: '{expression}', Sentence: '{sentence}', SentenceAudio: '', Picture: '', Glossary: '{glossary}' },
  };
  return { options, input };
}

function assertTermFormats(anki, input) {
  assert.equal('terms' in anki, false, 'must not write the obsolete, unused terms setting');
  const formats = anki.cardFormats.filter((format) => format.type === 'term');
  assert.ok(formats.length > 0);
  const fields = Object.fromEntries(Object.entries(input.fields).map(([name, value]) => [name, { value, overwriteMode: 'coalesce' }]));
  for (const format of formats) {
    assert.equal(format.model, input.model);
    assert.equal(format.deck, input.deck);
    assert.deepEqual(format.fields, fields);
  }
}

test('creates a separate profile while preserving dictionaries and old mining settings', () => {
  const { options, input } = fixture();
  const before = structuredClone(options);
  const result = configureProfile(options, input);
  assert.deepEqual(options, before);
  assert.deepEqual(result.options.profiles[0], before.profiles[0]);
  const profile = result.options.profiles[1];
  assert.equal(result.options.profileCurrent, 1);
  assert.deepEqual(profile.options.dictionaries, before.profiles[0].options.dictionaries);
  assert.deepEqual(profile.options.anki.cardFormats[2], before.profiles[0].options.anki.cardFormats[2]);
  assert.deepEqual(profile.options.anki.cardFormats.map(({ name, icon, type }) => ({ name, icon, type })),
    before.profiles[0].options.anki.cardFormats.map(({ name, icon, type }) => ({ name, icon, type })));
  assertTermFormats(profile.options.anki, input);
  assert.equal(profile.options.anki.enable, true);
  assert.equal(profile.options.anki.fieldTemplates, null);
  assert.deepEqual(profile.options.anki.tags, ['mine', 'required-for-gsm']);
  assert.equal(profile.options.general.resultOutputMode, 'group');
});

test('retry does not create a duplicate profile but does preserve a customized preset', () => {
  const { options, input } = fixture();
  const first = configureProfile(options, input);
  const second = configureProfile(first.options, input);
  assert.equal(second.options.profiles.length, 2);
  second.options.profiles[1].options.anki.cardFormats[1].fields.Expression.value = 'custom';
  const third = configureProfile(second.options, input);
  assert.equal(third.options.profiles.length, 3);
  assert.equal(third.profileName, 'GSM - Lapis (2)');
  assert.equal(third.options.profiles[1].options.anki.cardFormats[1].fields.Expression.value, 'custom');
  assertTermFormats(third.options.profiles[2].options.anki, input);
});

test('reapplying a setup with obsolete terms data repairs the actual formats in a new profile', () => {
  const { options, input } = fixture();
  const broken = structuredClone(options.profiles[0]);
  broken.name = 'GSM - Lapis';
  Object.assign(broken.options.anki, { enable: true, server: input.server, tags: input.tags,
    terms: { model: input.model, deck: input.deck, fields: input.fields } });
  options.profiles.push(broken);
  options.profileCurrent = 1;
  const result = configureProfile(options, input);
  assert.equal(result.options.profileCurrent, 2);
  assert.equal(result.profileName, 'GSM - Lapis (2)');
  assert.deepEqual(result.options.profiles[1], broken);
  assertTermFormats(result.options.profiles[2].options.anki, input);
});

test('adds a term format when only kanji formats exist', () => {
  const { options, input } = fixture();
  const anki = options.profiles[0].options.anki;
  anki.cardFormats = anki.cardFormats.filter((format) => format.type === 'kanji');
  const result = configureProfile(options, input);
  const configured = result.options.profiles[1].options.anki;
  assert.equal(configured.cardFormats.length, 2);
  assert.deepEqual(configured.cardFormats[0], anki.cardFormats[0]);
  assertTermFormats(configured, input);
});

test('does not silently configure an unsupported Yomitan schema', () => {
  const { options, input } = fixture();
  delete options.profiles[0].options.anki.cardFormats;
  assert.throws(() => configureProfile(options, input), /Yomitan/);
});

test('invalid presets and incomplete inputs cannot change settings', () => {
  const { options, input } = fixture();
  for (const patch of [{ preset: 'unknown' }, { fields: [] }, { fields: {} }, { deck: '' }, { server: 'file:///tmp' }]) {
    assert.throws(() => configureProfile(options, { ...input, ...patch }));
  }
});

test('duplicate websocket deliveries share one operation and expired requests are rejected', async () => {
  let calls = 0;
  const replies = [];
  const handler = createSetupHandler(async () => { calls++; return { profileName: 'GSM - Lapis' }; }, (x) => replies.push(x));
  const request = { type: 'anki-setup-yomitan', request_id: 'request-1', deadline: Date.now() + 5000, data: fixture().input };
  await Promise.all([handler(request), handler(request)]);
  assert.equal(calls, 1);
  assert.equal(replies[0].success, true);
  await handler({ ...request, request_id: 'expired', deadline: 1 });
  assert.equal(calls, 1);
  assert.equal(replies.at(-1).success, false);
});

test('bridge failures are acknowledged rather than reported as success', async () => {
  let reply;
  const handler = createSetupHandler(async () => { throw new Error('Start Yomitan'); }, (x) => { reply = x; });
  await handler({ type: 'anki-setup-yomitan', request_id: 'failed', deadline: Date.now() + 5000, data: fixture().input });
  assert.equal(reply.success, false);
  assert.match(reply.error, /Start Yomitan/);
});
