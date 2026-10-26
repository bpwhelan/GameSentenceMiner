const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { between } = require('./helpers/overlay-startup.cjs');

const renderer = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
function setup(enabled = false, reader = 'yomitan') {
  const listeners = new Map(), closed = [];
  const context = vm.createContext({
    hideYomitanAfterMine: enabled, dictionaryReader: reader, console: { log() {} },
    closeYomitanLookups: reason => { closed.push(reason); return Promise.resolve(); },
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

test('mining keeps the popup open by default and requires an explicit boolean opt-in', () => {
  for (const value of [undefined, false, 'false', 'true', 1]) {
    const fixture = setup(value);
    fixture.saved();
    fixture.iframeSaved();
    assert.deepEqual(fixture.closed, []);
  }
});

test('opt-in closes Yomitan through its bridge only after mining success', () => {
  const fixture = setup(true);
  fixture.iframeSaved();
  assert.deepEqual(fixture.closed, ['note-added']);
  fixture.context.hideYomitanAfterMine = false;
  fixture.iframeSaved();
  assert.equal(fixture.closed.length, 1, 'turning the option off applies immediately');
});

test('the same opt-in continues to close Hachidori after mining', () => {
  const fixture = setup(true, 'hachidori');
  fixture.saved();
  assert.deepEqual(fixture.closed, ['hachidori']);
});
