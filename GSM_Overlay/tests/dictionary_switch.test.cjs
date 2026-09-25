const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { between } = require('./helpers/overlay-startup.cjs');

const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');

function loadSwitcher({ save = true, restart = async () => true, inProcess = true } = {}) {
  const calls = [];
  const settings = { dictionaryReaderSelection: 'yomitan' };
  const hostSymbol = Symbol.for('gsm.overlay.host');
  const context = vm.createContext({
    DICTIONARY_READER_YOMITAN: 'yomitan', DICTIONARY_READER_HACHIDORI: 'hachidori',
    activeDictionaryReader: 'yomitan', userSettings: settings,
    IN_PROCESS_OVERLAY: inProcess, OVERLAY_HOST_SYMBOL: hostSymbol,
    saveSettings() { calls.push(['save', settings.dictionaryReaderSelection]); return save; },
    publishOverlaySettingsSnapshot(reason) { calls.push(['snapshot', reason]); },
    settingsWindow: { isDestroyed: () => false, webContents: { send: (...args) => calls.push(args) } },
    dialog: { showErrorBox: (...args) => calls.push(['error', ...args]) },
    console: { error() {} },
    process: { argv: ['electron', 'overlay', '--gsm-overlay-settings-tab=overview'] },
    stopOverlayApp: async () => { calls.push(['stop']); },
    app: { on() {}, removeListener() {}, relaunch: options => calls.push(['relaunch', options]), quit: () => calls.push(['quit']) },
  });
  context[hostSymbol] = { requestRestart: async tab => { calls.push(['restart', tab]); return restart(); } };
  vm.runInContext(between(main, 'let dictionaryReaderSwitchPromise = null;', 'let isOverlayVisible = false;'), context);
  return { change: value => context.changeDictionaryReader(value), settings, calls };
}

test('dictionary selection is saved before restarting and duplicate switches are coalesced', async () => {
  let finish;
  const switcher = loadSwitcher({ restart: () => new Promise(resolve => { finish = resolve; }) });
  const first = switcher.change('hachidori');
  const second = switcher.change('hachidori');
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(switcher.settings.dictionaryReaderSelection, 'hachidori');
  assert.deepEqual(switcher.calls.slice(0, 3), [
    ['save', 'hachidori'], ['dictionary-reader-switching', true], ['restart', 'system'],
  ]);
  finish(true);
  await first;
  assert.deepEqual(switcher.calls.at(-1), ['dictionary-reader-switching', false]);
});

test('unchanged and invalid dictionary selections do not save or restart', async () => {
  const switcher = loadSwitcher();
  for (const value of ['yomitan', 'other', null, true]) await switcher.change(value);
  assert.deepEqual(switcher.calls, []);
});

test('a failed settings write preserves the current reader without restarting', async () => {
  const switcher = loadSwitcher({ save: false });
  await switcher.change('hachidori');
  assert.equal(switcher.settings.dictionaryReaderSelection, 'yomitan');
  assert.equal(switcher.calls.some(([event]) => event === 'restart'), false);
  assert.equal(switcher.calls.some(([event]) => event === 'snapshot'), true);
  assert.match(switcher.calls.find(([event]) => event === 'error')[2], /could not be saved/);
});

test('restart errors are reported and settings controls become available again', async () => {
  const switcher = loadSwitcher({ restart: async () => { throw new Error('Extension unavailable'); } });
  await switcher.change('hachidori');
  assert.match(switcher.calls.find(([event]) => event === 'error')[2], /Extension unavailable/);
  assert.deepEqual(switcher.calls.at(-1), ['dictionary-reader-switching', false]);
});

test('standalone switching finishes cleanup before relaunching into System settings', async () => {
  const switcher = loadSwitcher({ inProcess: false });
  await switcher.change('hachidori');
  const lifecycle = switcher.calls.filter(([event]) => ['save', 'stop', 'relaunch', 'quit'].includes(event));
  assert.deepEqual(JSON.parse(JSON.stringify(lifecycle)), [
    ['save', 'hachidori'], ['stop'],
    ['relaunch', { args: ['overlay', '--gsm-overlay-settings-tab=system'] }], ['quit'],
  ]);
});
