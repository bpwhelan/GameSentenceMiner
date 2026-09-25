// Real bundled Yomitan, using a disposable Electron profile with network blocked.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { configureYomitan } = require('../anki_setup');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-anki-setup-smoke-'));
app.setPath('userData', path.join(directory, 'profile'));
app.commandLine.appendSwitch('disable-background-networking');
app.on('window-all-closed', () => {});
const timeout = setTimeout(() => { console.error('Anki setup smoke test timed out'); app.exit(1); }, 45000);

function withApi(window, script) {
  return window.webContents.executeJavaScript(`(async () => {
    const {API} = await import('./js/comm/api.js');
    const {WebExtension} = await import('./js/extension/web-extension.js');
    const api = new API(new WebExtension());
    ${script}
  })()`);
}

async function assertSettingsUI(window, expected) {
  const deadline = Date.now() + 8000;
  let actual;
  do {
    actual = await window.webContents.executeJavaScript(`(() => {
      const card = document.querySelector('#anki-card-primary');
      const names = Array.from(card?.querySelectorAll('.anki-card-field-name') || [], (node) => node.textContent);
      const values = Array.from(card?.querySelectorAll('.anki-card-field-value') || [], (node) => node.value);
      return {
        model: card?.querySelector('.anki-card-model')?.value,
        deck: card?.querySelector('.anki-card-deck')?.value,
        fields: Object.fromEntries(names.map((name, index) => [name, values[index]])),
      };
    })()`);
    if (JSON.stringify(actual) === JSON.stringify(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.deepEqual(actual, expected, 'the existing settings page must show the configured model, deck and fields');
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
  const extension = await session.defaultSession.extensions.loadExtension(path.resolve(__dirname, '../yomitan'), { allowFileAccess: true });
  const input = {
    preset: 'senren', model: 'Senren', deck: 'GSM test', server: 'http://127.0.0.1:1',
    fields: { word: '{expression}', sentence: '{sentence}', picture: '', sentenceAudio: '', glossary: '{glossary}' },
  };
  // Keep the settings page open throughout setup to check the UI's active profile too.
  const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  await window.loadURL(`chrome-extension://${extension.id}/settings.html`);
  const original = await withApi(window, `
    const options = await api.optionsGetFull();
    for (const format of options.profiles[0].options.anki.cardFormats) {
      format.model = 'Old model';
      format.deck = 'Old deck';
      format.fields = {Front: {value: '{expression}', overwriteMode: 'append'}};
    }
    await api.setAllSettings(options, 'smoke-test-seed');
    return (await api.optionsGetFull()).profiles[0];
  `);
  await assertSettingsUI(window, { model: 'Old model', deck: 'Old deck', fields: { Front: '{expression}' } });

  const first = await configureYomitan(BrowserWindow, extension, input, Date.now() + 20000);
  assert.equal(first.profileName, 'GSM - Senren');
  const options = await withApi(window, 'return await api.optionsGetFull();');
  assert.equal(options.profiles.length, 2);
  assert.equal(options.profileCurrent, 1);
  assert.deepEqual(options.profiles[0], original);
  const expectedFields = Object.fromEntries(Object.entries(input.fields).map(([name, value]) => [name, { value, overwriteMode: 'coalesce' }]));
  const configured = options.profiles[1].options.anki;
  assert.equal('terms' in configured, false);
  assert.equal(configured.cardFormats.filter((format) => format.type === 'term').length, 2);
  for (const format of configured.cardFormats.filter((format) => format.type === 'term')) {
    assert.equal(format.model, input.model);
    assert.equal(format.deck, input.deck);
    assert.deepEqual(format.fields, expectedFields);
  }
  assert.deepEqual(configured.cardFormats.filter((format) => format.type === 'kanji'),
    original.options.anki.cardFormats.filter((format) => format.type === 'kanji'));
  const mining = await withApi(window, `return await api.optionsGet({depth: 0, url: 'file:///GSM_Overlay/index.html'});`);
  assert.deepEqual(mining.anki, configured, 'lookups must resolve to the configured mining profile');
  await assertSettingsUI(window, { model: input.model, deck: input.deck, fields: input.fields });
  await window.webContents.executeJavaScript(`document.querySelector('#anki-cards-tabs input[data-card-format-index="1"]').click()`);
  await assertSettingsUI(window, { model: input.model, deck: input.deck, fields: input.fields });

  const second = await configureYomitan(BrowserWindow, extension, input, Date.now() + 20000);
  assert.equal(second.profileName, first.profileName);
  assert.equal(await withApi(window, 'return (await api.optionsGetFull()).profiles.length;'), 2);
  window.destroy();
  clearTimeout(timeout);
  console.log('PASS: real Yomitan card formats, open settings UI, lookup profile, profile preservation and idempotent retry');
  app.exit(0);
}).catch(error => { console.error(error); clearTimeout(timeout); app.exit(1); });
