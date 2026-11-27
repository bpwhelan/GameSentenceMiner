const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { loadOverlayStartup, rendererGamepadConfigSource } = require('./helpers/overlay-startup.cjs');

for (const reader of ['hachidori', 'yomitan']) {
  test('startup publishes the loaded reader to gamepad navigation for ' + reader, () => {
    const startup = loadOverlayStartup({}, { dictionaryReaderSelection: reader });
    assert.equal(startup.selectedReader, reader);
    assert.equal(vm.runInNewContext(rendererGamepadConfigSource(startup.settingsPayload())).dictionaryReader, reader);
  });
}

test('missing or invalid dictionary selections default to Yomitan', () => {
  for (const selection of [undefined, 'invalid']) {
    assert.equal(loadOverlayStartup({}, { dictionaryReaderSelection: selection }).selectedReader, 'yomitan');
  }
});

test('changing the selection keeps renderer routing on the loaded reader until restart', () => {
  const settings = { dictionaryReaderSelection: 'yomitan' };
  const startup = loadOverlayStartup({}, settings);
  settings.dictionaryReaderSelection = 'hachidori';
  assert.equal(startup.settingsPayload().dictionaryReader, 'yomitan');
  assert.equal(startup.settingsPayload().dictionaryReaderSelection, 'hachidori');
  assert.equal(loadOverlayStartup({}, settings).selectedReader, 'hachidori');
});
