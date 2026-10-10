// Exercise the production overlay, extension, WASM importer and IndexedDB.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const directory = process.env.GSM_HACHIDORI_PERSISTENCE_DIRECTORY;
const phase = process.env.GSM_HACHIDORI_PERSISTENCE_PHASE;
assert.ok(directory && phase, 'run through run-hachidori-persistence-electron.cjs');
const overlayData = path.join(directory, 'overlay');
const gsmData = path.join(directory, 'gsm');
fs.mkdirSync(overlayData, { recursive: true });
fs.mkdirSync(gsmData, { recursive: true });
app.setPath('userData', path.join(directory, 'app'));
process.env.GSM_OVERLAY_IN_PROCESS = '1';
process.env.GSM_OVERLAY_DATA_PATH = overlayData;
process.env.GSM_DATA_DIR = gsmData;
fs.writeFileSync(path.join(gsmData, 'config.json'), JSON.stringify({
  current_profile: 'Default', configs: { Default: { general: { single_port: 7275 }, advanced: {}, overlay: {} } },
}));
fs.writeFileSync(path.join(overlayData, 'settings.json'), JSON.stringify({
  dictionaryReaderSelection: 'hachidori', pushToShowEnforcedDialogDismissed: true,
  mainBoxStartupWarningAcknowledged: true, openSettingsOnStartup: false,
  enableJitenReader: false, gamepadEnabled: false, gamepadControllerEnabled: false,
  gamepadKeyboardEnabled: false, routeAllHotkeysThroughInputServer: false,
}));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1');
const engineDocuments = [];
app.on('web-contents-created', (_event, contents) => {
  contents.on('did-navigate', (_event, url) => {
    if (url.endsWith('/offscreen.html')) engineDocuments.push(contents.id);
  });
});
const timeout = setTimeout(() => { console.error(`${phase} timed out`); app.exit(1); }, 120_000);

async function waitFor(callback) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const result = await callback();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('dictionary engine did not become ready');
}

app.whenReady().then(async () => {
  let overlay = require('../main.js');
  try {
    await overlay.startOverlayApp();
    const ses = session.fromPath(overlayData);
    const extension = ses.extensions.getAllExtensions().find(item => item.name === 'Hachidori');
    assert.ok(extension, 'production startup loaded Hachidori');
    const page = new BrowserWindow({ show: false, webPreferences: { session: ses, backgroundThrottling: false } });
    await page.loadURL(`chrome-extension://${extension.id}/settings.html`);
    const request = (type, fields = {}, target = 'hoshidicts-offscreen') => page.webContents.executeJavaScript(
      `chrome.runtime.sendMessage(${JSON.stringify({ target, type, requestId: `persistence-${Date.now()}`, ...fields })})`,
    );
    const ready = () => waitFor(async () => {
      const status = await request('hd_status');
      assert.equal(status.ok, true, JSON.stringify(status));
      return status.ready && !status.loading && status;
    });
    await ready();
    assert.equal(engineDocuments.length, 1, 'startup must create exactly one engine document; two IDBFS mirrors can erase committed files');

    if (phase === 'import') {
      for (const file of [path.join(__dirname, 'fixtures/hachidori-fixture.zip'), path.join(directory, 'second.zip')]) {
        const bytes = [...fs.readFileSync(file)];
        const blobUrl = await page.webContents.executeJavaScript(
          `URL.createObjectURL(new Blob([new Uint8Array(${JSON.stringify(bytes)})]))`,
        );
        const result = await request('hd_import', { blobUrl, fileName: path.basename(file) });
        assert.equal(result.ok, true, JSON.stringify(result));
        await page.webContents.executeJavaScript(`URL.revokeObjectURL(${JSON.stringify(blobUrl)})`);
      }
      const state = (await page.webContents.executeJavaScript('chrome.storage.local.get("dictionaryState")')).dictionaryState;
      const dictionaries = state.dictionaries.toReversed().map((dictionary, index) => ({
        ...dictionary, displayName: `Saved alias ${index}`, favorite: true, enabled: index === 0,
      }));
      const applied = await request('hd_apply_state', { baseRevision: state.revision, dictionaries });
      assert.equal(applied.ok, true, JSON.stringify(applied));
    }

    if (phase === 'overlay-restart') {
      // Match overlay_runtime.ts: stop, unload the overlay's modules, and start
      // again without ending Electron or changing its persistent session.
      await overlay.stopOverlayApp();
      const overlayRoot = path.resolve(__dirname, '..') + path.sep;
      for (const filename of Object.keys(require.cache)) {
        if (filename.startsWith(overlayRoot)) delete require.cache[filename];
      }
      overlay = require('../main.js');
      await overlay.startOverlayApp();
      await page.loadURL(`chrome-extension://${extension.id}/settings.html`);
      await ready();
      assert.equal(engineDocuments.length, 2, 'each overlay start creates one engine');
    }

    const status = await ready();
    assert.equal(status.storageBackend, 'idbfs', 'exercise Electron dictionary persistence');
    assert.deepEqual(status.failedDictionaries, [], JSON.stringify(status));
    const lookup = await request('hd_lookup', { text: '保存語', options: {} });
    assert.ok(lookup.results.some(result => result.term?.expression === '保存語'), 'the enabled dictionary still answers lookups');
    const state = (await page.webContents.executeJavaScript('chrome.storage.local.get("dictionaryState")')).dictionaryState;
    const keys = await page.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const request = indexedDB.open('/dicts');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction('FILE_DATA', 'readonly');
        const keys = transaction.objectStore('FILE_DATA').getAllKeys();
        transaction.oncomplete = () => { database.close(); resolve(keys.result); };
        transaction.onerror = () => reject(transaction.error);
      };
    })`);
    assert.equal(state.dictionaries.length, 2);
    for (const dictionary of state.dictionaries) {
      assert.ok(keys.some(key => key.startsWith(`${dictionary.path}/.hoshidicts_`)), `${dictionary.title} has a persisted import marker`);
    }
    const baselinePath = path.join(directory, 'import.json');
    const result = { phase, pid: process.pid, extensionId: extension.id, engineDocuments, status, state, keys };
    if (phase !== 'import') {
      const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
      assert.equal(extension.id, baseline.extensionId, 'extension identity stays stable');
      assert.deepEqual(state, baseline.state, 'package IDs, generation paths, order, aliases, enabled state and favorites survive');
      assert.deepEqual(keys, baseline.keys, 'all committed dictionary files survive');
    }
    fs.writeFileSync(path.join(directory, `${phase}.json`), `${JSON.stringify(result, null, 2)}\n`);
    await overlay.stopOverlayApp();
    page.destroy();
    clearTimeout(timeout);
    console.log(`Hachidori dictionary persistence: ${phase} passed`);
    app.exit(0);
  } catch (error) {
    console.error(error);
    await overlay.stopOverlayApp();
    clearTimeout(timeout);
    app.exit(1);
  }
});
