const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { getExtensionContentRevision } = require('../extension_revision');
const { between } = require('./helpers/overlay-startup.cjs');

const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const startup = between(main, "    const yomitanExtDir = isDev ? path.join(__dirname, 'yomitan')",
  '  } else if (dictionaryReader === DICTIONARY_READER_HACHIDORI)');

function setup(t, { failClear = false, failLoad = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-yomitan-revision-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'yomitan');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'manifest.json'), '{"version":"1.0"}');
  fs.writeFileSync(path.join(directory, 'sw.js'), 'old worker');
  const statePath = path.join(root, 'yomitan_last_revision.json');
  const calls = [];
  const context = vm.createContext({
    path, fs, isDev: true, __dirname: root, dataPath: root, getExtensionContentRevision,
    console: { log() {}, warn() {} },
    getOverlaySession: () => ({ clearStorageData: async options => {
      calls.push(['clear', JSON.parse(JSON.stringify(options))]);
      if (failClear) throw new Error('cache unavailable');
    } }),
    loadExtension: async name => { calls.push(['load', name]); return failLoad ? null : { id: 'yomitan' }; },
  });
  vm.runInContext(`async function start() { let yomitanExt; ${startup} return yomitanExt; }`, context);
  return { root, directory, statePath, calls, start: () => context.start() };
}

test('legacy timestamp-only installs clear stale workers without touching dictionary storage', async t => {
  const h = setup(t);
  fs.writeFileSync(path.join(h.root, 'yomitan_last_mtime.json'), JSON.stringify({
    mtime: fs.statSync(path.join(h.directory, 'manifest.json')).mtimeMs,
  }));
  await h.start();
  assert.deepEqual(h.calls, [['clear', { storages: ['serviceworkers'] }], ['load', 'yomitan']]);
  assert.equal(JSON.parse(fs.readFileSync(h.statePath)).revision, getExtensionContentRevision(h.directory));
});

test('same-version code updates invalidate workers even when the manifest timestamp is unchanged', async t => {
  const h = setup(t);
  await h.start();
  const manifest = path.join(h.directory, 'manifest.json');
  const originalMtime = fs.statSync(manifest).mtimeMs;
  h.calls.length = 0;
  fs.writeFileSync(path.join(h.directory, 'sw.js'), 'new worker');
  await h.start();
  assert.equal(fs.statSync(manifest).mtimeMs, originalMtime);
  assert.deepEqual(h.calls.map(([action]) => action), ['clear', 'load']);
});

test('unchanged contents reuse workers despite timestamp changes', async t => {
  const h = setup(t);
  await h.start();
  h.calls.length = 0;
  fs.utimesSync(path.join(h.directory, 'sw.js'), new Date(0), new Date(0));
  await h.start();
  assert.deepEqual(h.calls, [['load', 'yomitan']]);
});

for (const failure of ['failClear', 'failLoad']) {
  test(`${failure} does not mark a broken installation as refreshed`, async t => {
    const h = setup(t, { [failure]: true });
    await h.start();
    assert.equal(fs.existsSync(h.statePath), false);
    await h.start();
    assert.equal(h.calls.filter(([action]) => action === 'clear').length, 2);
  });
}

test('bundle revisions include nested assets and file names', t => {
  const h = setup(t);
  const before = getExtensionContentRevision(h.directory);
  fs.mkdirSync(path.join(h.directory, 'js'));
  fs.writeFileSync(path.join(h.directory, 'js/frontend.js'), 'frontend');
  const added = getExtensionContentRevision(h.directory);
  assert.notEqual(added, before);
  fs.renameSync(path.join(h.directory, 'js/frontend.js'), path.join(h.directory, 'js/background.js'));
  assert.notEqual(getExtensionContentRevision(h.directory), added);
});
