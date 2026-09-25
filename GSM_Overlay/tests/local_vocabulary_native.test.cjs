const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { VocabularyConnection, LocalVocabulary } = require('../local_vocabulary');

test('native server imports, parses offline, isolates accounts and rejects browser origins', {
  skip: !process.env.GSM_VOCABULARY_TEST_BINARY && 'Set GSM_VOCABULARY_TEST_BINARY after building the Rust server; requires the installed core dictionary',
  timeout: 30_000,
}, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gsm-vocabulary-native-'));
  const child = spawn(process.env.GSM_VOCABULARY_TEST_BINARY, ['--host', '127.0.0.1', '--port', '0'], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GSM_VOCABULARY_DB_PATH: path.join(directory, 'words.sqlite3'),
      GSM_SUDACHI_DICT_KIND: 'core', GSM_SUDACHI_USER_DICTS_PATH: path.join(directory, 'user-dictionaries') },
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill(); await exited;
    }
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('gsm-vocabulary-native-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('Rust server did not become ready')), 10_000);
    child.once('error', reject);
    child.stdout.on('data', data => {
      output += data.toString();
      const ready = output.match(/GSM_INPUT_SERVER_READY:(\{[^\n]+\})/);
      if (ready) { clearTimeout(timeout); resolve(JSON.parse(ready[1]).port); }
    });
  });
  const connection = new VocabularyConnection({ WebSocket, ensureServer: async () => {}, getPort: () => port });
  t.after(() => connection.close());
  let fetches = 0;
  const service = new LocalVocabulary({ request: request => connection.request(request), fetch: async () => {
    fetches++;
    return Response.json({ totalCards: 1, cards: [{ w: 123, r: 0, t: '猫', k: 'ねこ', s: 5, du: 0 }] });
  } });
  const config = { source: 'jiten', apiKey: 'fixture-account' };
  await service.sync(config);
  const parsed = await service.parse(['😀 猫を見た。'], config);
  const cat = parsed.tokens[0].find(token => token.word === '猫');
  assert.equal(cat.start, 3);
  assert.deepEqual(cat.knownState, [5]);
  assert.equal(cat.wordId, 123);
  assert.equal(fetches, 1, 'parsing must not call the remote API');
  await connection.request({ action: 'replace', source: 'jiten:rules-fixture', words: [
    { spelling: '屑', reading: 'くず', knownState: [5], wordId: 1246510, readingIndex: 1 },
    { spelling: 'いいか', reading: 'いいか', knownState: [2], wordId: 2555520, readingIndex: 0 },
  ] });
  const correctedText = '😀 クズ。いいか！';
  const corrected = await connection.request({ action: 'parse', sources: ['jiten:rules-fixture'], texts: [correctedText] });
  assert.equal(corrected.rules.importedRules, 133);
  assert.equal(corrected.rules.enabledRules, 128);
  assert.equal(corrected.rules.upstreamCommit, 'a2fd4a6ccbbcc55c975694627e3b54f3f4e23f11');
  const scum = corrected.tokens[0].find(token => token.word === 'クズ');
  assert.deepEqual([scum.wordId, scum.readingIndex, scum.knownState], [1246510, 1, [5]]);
  const listen = corrected.tokens[0].find(token => token.word === 'いいか');
  assert.deepEqual(listen.appliedRules, ['iika-listen']);
  assert.deepEqual(listen.knownState, [2]);
  for (const token of corrected.tokens[0]) assert.equal(correctedText.slice(token.start, token.end), token.word);
  assert.equal(fetches, 1, 'Jiten corrections must also be fully offline');
  const other = await service.parse(['猫'], { ...config, apiKey: 'different-account' });
  assert.deepEqual(other.tokens[0][0].knownState, [0]);
  await assert.rejects(connection.request({ action: 'parse', texts: ['a'.repeat(256001)], sources: [] }), /budget/);
  await assert.rejects(connection.request({ action: 'replace', source: 'test', words: [{ spelling: '猫', knownState: [99] }] }), /state/);
  const browser = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'https://example.com' });
  t.after(() => browser.close());
  const forbidden = new Promise(resolve => browser.on('message', data => {
    const message = JSON.parse(data);
    if (message.type === 'local_vocabulary') resolve(message);
  }));
  await once(browser, 'open');
  browser.send(JSON.stringify({ type: 'local_vocabulary', requestId: 'browser', request: { action: 'status', sources: [] } }));
  assert.match((await forbidden).error, /local desktop/);
});
