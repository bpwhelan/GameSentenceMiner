const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { between } = require('./helpers/overlay-startup.cjs');

const renderer = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
function setup(enabled = false, reader = 'yomitan', refresh = async () => {}) {
  const listeners = new Map(), closed = [];
  const context = vm.createContext({
    hideYomitanAfterMine: enabled, dictionaryReader: reader, console: { log() {} },
    refreshMinedAnkiPopupEntry: refresh,
    closeDictionaryLookups: reason => { closed.push(reason); return Promise.resolve(); },
    OverlayUtils: { hideYomitan: () => { throw new Error('Mining must not simulate a click'); } },
    CustomEvent: class { constructor(type) { this.type = type; } },
    window: {
      addEventListener: (type, listener) => listeners.set(type, listener),
      dispatchEvent: event => listeners.get(event.type)?.(event),
      gsmHachidoriBridge: { closePopups: () => { closed.push('hachidori'); return Promise.resolve(); } },
    },
  });
  vm.runInContext(between(renderer, '  // Listen for mining success signal', '  let unHoverTimer'), context);
  return { closed, context, saved: () => context.window.dispatchEvent({type: 'gsm-anki-note-added'}),
    iframeSaved: () => listeners.get('message')({data: {type: 'gsm-anki-note-added'}}) };
}

const settleRefresh = () => new Promise(setImmediate);

test('mining keeps the popup open by default and requires an explicit boolean opt-in', async () => {
  for (const value of [undefined, false, 'false', 'true', 1]) {
    const fixture = setup(value);
    fixture.saved();
    fixture.iframeSaved();
    await settleRefresh();
    assert.deepEqual(fixture.closed, []);
  }
});

test('opt-in closes Yomitan through its bridge after the targeted refresh', async () => {
  let finishRefresh;
  const fixture = setup(true, 'yomitan', () => new Promise(resolve => { finishRefresh = resolve; }));
  fixture.iframeSaved();
  assert.deepEqual(fixture.closed, []);
  finishRefresh();
  await settleRefresh();
  assert.deepEqual(fixture.closed, ['note-added']);
  fixture.context.hideYomitanAfterMine = false;
  fixture.iframeSaved();
  finishRefresh();
  await settleRefresh();
  assert.equal(fixture.closed.length, 1, 'turning the option off applies immediately');
});

test('the same opt-in continues to close Hachidori after mining', async () => {
  const fixture = setup(true, 'hachidori');
  fixture.saved();
  await settleRefresh();
  assert.deepEqual(fixture.closed, ['note-added']);
});
