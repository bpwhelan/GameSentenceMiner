const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { loadOverlayStartup, rendererGamepadConfigSource } = require('./helpers/overlay-startup.cjs');

for (const [experimental, reader] of [
  [{ enable_experimental_features: true, enable_hachidori: true }, 'hachidori'],
  [{ enable_experimental_features: false, enable_hachidori: true }, 'yomitan'],
  [{ enable_experimental_features: true, enable_hachidori: false }, 'yomitan'],
  [undefined, 'yomitan'],
]) {
  test(`startup publishes the loaded reader to gamepad navigation: ${JSON.stringify(experimental)}`, () => {
    // An old overlay setting must never override the extension selected from GSM's config.
    const startup = loadOverlayStartup({ experimental }, { dictionaryReader: reader === 'hachidori' ? 'yomitan' : 'hachidori' });
    assert.equal(startup.selectedReader, reader);
    const payload = startup.settingsPayload();
    assert.equal(payload.dictionaryReader, reader);
    assert.equal(vm.runInNewContext(rendererGamepadConfigSource(payload)).dictionaryReader, reader);
  });
}

test('settings snapshots retain the running reader until the overlay restarts', () => {
  const config = { experimental: { enable_experimental_features: true, enable_hachidori: true } };
  const settings = { fontSize: 30 };
  const startup = loadOverlayStartup(config, settings);
  config.experimental.enable_hachidori = false;
  settings.fontSize = 40;
  assert.equal(startup.settingsPayload().dictionaryReader, 'hachidori');
  assert.equal(startup.settingsPayload().fontSize, 40);
  assert.equal(loadOverlayStartup(config, settings).settingsPayload().dictionaryReader, 'yomitan');
});

test('an explicit System dictionary selection overrides the legacy experimental flags', () => {
  const legacyEnabled = { experimental: { enable_experimental_features: true, enable_hachidori: true } };
  assert.equal(loadOverlayStartup(legacyEnabled, { dictionaryReaderSelection: 'yomitan' }).selectedReader, 'yomitan');
  assert.equal(loadOverlayStartup({}, { dictionaryReaderSelection: 'hachidori' }).selectedReader, 'hachidori');
  assert.equal(loadOverlayStartup(legacyEnabled, { dictionaryReaderSelection: 'invalid' }).selectedReader, 'hachidori');
});

test('changing the selection keeps renderer routing on the loaded reader until restart', () => {
  const settings = { dictionaryReaderSelection: 'yomitan' };
  const startup = loadOverlayStartup({}, settings);
  settings.dictionaryReaderSelection = 'hachidori';
  assert.equal(startup.settingsPayload().dictionaryReader, 'yomitan');
  assert.equal(startup.settingsPayload().dictionaryReaderSelection, 'hachidori');
  assert.equal(loadOverlayStartup({}, settings).selectedReader, 'hachidori');
});
