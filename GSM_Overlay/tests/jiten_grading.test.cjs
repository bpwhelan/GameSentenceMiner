const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JitenParseCache, DEFAULT_JITEN_PARSE_URL } = require('../jiten_cache');

test('duplicate Yomitan popup messages submit one grade through real renderer and IPC handlers', async (t) => {
  const calls = [];
  const broker = new JitenParseCache({ batchDelayMs: 1, minIntervalMs: 0, parseIntervalMs: 0,
    fetch: async (url) => { calls.push(url); return Response.json({ ok: true }); },
  });
  t.after(() => broker.dispose());
  const handlers = new Map();
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const mainContext = vm.createContext({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    jitenParseCache: broker, JITEN_DEFAULT_PARSE_URL: DEFAULT_JITEN_PARSE_URL,
  });
  vm.runInContext(main.slice(main.indexOf("ipcMain.handle('gsm-jiten-review'"), main.indexOf('// Fetch the list of active goals')), mainContext);
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const renderer = vm.createContext({
    getJitenGradingApiKey: () => 'offline-test',
    resolveJitenWordRef: async () => ({ wordId: 1, readingIndex: 0 }),
    JITEN_GRADING_PARSE_URL: DEFAULT_JITEN_PARSE_URL,
    ipcRenderer: { invoke: (name, args) => handlers.get(name)({}, args) },
    applyOptimisticHighlightState() {},
  });
  const start = html.indexOf('  async function handleJitenGradeRequest(');
  vm.runInContext(html.slice(start, html.indexOf("  window.addEventListener('message'", start)), renderer);
  const replies = [];
  const source = { postMessage: value => replies.push(value) };
  for (const kind of ['review', 'state']) {
    const message = { requestId: `popup-${kind}`, kind, term: '猫', reading: 'ねこ', rating: 3, deck: 'blacklist', action: 'add' };
    await Promise.all([renderer.handleJitenGradeRequest(message, source), renderer.handleJitenGradeRequest(message, source)]);
  }
  assert.equal(replies.length, 4);
  assert.ok(replies.every(reply => reply.ok));
  assert.equal(calls.length, 2, 'one review and one state change, despite duplicate messages');
});
