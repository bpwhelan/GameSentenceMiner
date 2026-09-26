// Real Yomitan startup in a disposable profile, without selecting another reader.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { between } = require('./helpers/overlay-startup.cjs');
const { getExtensionContentRevision } = require('../extension_revision');

const root = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-yomitan-startup-'));
const phase = process.argv[3] || 'lookup';
const overlay = path.resolve(__dirname, '..');
app.setPath('userData', path.join(root, 'profile'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
app.on('window-all-closed', () => {});
const timeout = setTimeout(() => { console.error('Yomitan startup smoke timed out'); app.exit(1); }, 45000);

app.whenReady().then(async () => {
  const overlaySession = session.fromPath(path.join(root, 'overlay-profile'));
  overlaySession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] },
    (_details, callback) => callback({ cancel: true }));
  const context = vm.createContext({
    isDev: true, path, fs, __dirname: path.join(root, 'GSM_Overlay'), setTimeout, clearTimeout, console,
    dataPath: path.join(root, 'overlay-profile'),
    getExtensionContentRevision,
    getOverlaySession: () => overlaySession,
    ensureExtensionCopy: (_name, source) => source,
  });
  const main = fs.readFileSync(path.join(overlay, 'main.js'), 'utf8');
  vm.runInContext(between(main, 'const EXTENSION_READY_TIMEOUT_MS', '// hoshidicts keeps dictionaries'), context);
  vm.runInContext(`async function startYomitan() {
    let yomitanExt;
    ${between(main, "    const yomitanExtDir = isDev ? path.join(__dirname, 'yomitan')", '  } else if (dictionaryReader === DICTIONARY_READER_HACHIDORI)')}
    return yomitanExt;
  }`, context);
  const page = path.join(root, 'GSM_Overlay', 'index.html');
  fs.mkdirSync(path.dirname(page), { recursive: true });
  fs.writeFileSync(page, '<!doctype html><meta charset="utf-8"><div id="word" style="font:32px sans-serif;margin:80px">食べる</div>');
  const extension = await context.startYomitan();
  assert.ok(extension);
  if (phase === 'seed') {
    const settings = new BrowserWindow({ show: false, webPreferences: { session: overlaySession } });
    await settings.loadURL(`chrome-extension://${extension.id}/settings.html`);
    const archive = fs.readFileSync(path.join(__dirname, 'fixtures/yomitan-startup.zip')).toString('base64');
    await settings.webContents.executeJavaScript(`(async () => {
      const {API} = await import('./js/comm/api.js');
      const {WebExtension} = await import('./js/extension/web-extension.js');
      const {DictionaryDatabase} = await import('./js/dictionary/dictionary-database.js');
      const {DictionaryImporter} = await import('./js/dictionary/dictionary-importer.js');
      const {DictionaryImporterMediaLoader} = await import('./js/dictionary/dictionary-importer-media-loader.js');
      const {DictionaryController} = await import('./js/pages/settings/dictionary-controller.js');
      const database = new DictionaryDatabase();
      await database.prepare();
      const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
      const {errors} = await importer.importDictionary(database,
        Uint8Array.from(atob(${JSON.stringify(archive)}), c => c.charCodeAt(0)).buffer, {prefixWildcardsSupported: false});
      if (errors.length) throw new Error(errors.map(e => e.message).join('; '));
      await database.close();
      const api = new API(new WebExtension());
      const options = await api.optionsGetFull();
      const profile = options.profiles[options.profileCurrent].options;
      profile.general.showGuide = false;
      profile.general.enable = true;
      profile.audio.enabled = false;
      profile.dictionaries = [DictionaryController.createDefaultDictionarySettings('GSM startup fixture', true, '')];
      profile.scanning.inputs[0].include = '';
      profile.scanning.delay = 0;
      await api.setAllSettings(options, 'gsm-startup-smoke');
      await api.triggerDatabaseUpdated('dictionary', 'import');
    })()`);
    await overlaySession.flushStorageData();
    settings.destroy();
    clearTimeout(timeout);
    console.log('PASS: seeded a saved Yomitan dictionary and mouse-scan settings');
    app.exit(0);
    return;
  }
  const win = new BrowserWindow({ show: false, webPreferences: {
    session: overlaySession, nodeIntegration: true, contextIsolation: false, backgroundThrottling: false, webSecurity: false,
  } });
  win.webContents.on('console-message', event => console.log('[page]', event.message));
  await win.loadFile(page);
  for (const name of ['extension_bridge.js', 'yomitan_bridge.js']) {
    await win.webContents.executeJavaScript(fs.readFileSync(path.join(overlay, name), 'utf8'));
  }
  const version = await win.webContents.executeJavaScript(`(async () => {
    let lastError;
    for (let attempt = 0; attempt < 20; attempt++) {
      try { return await gsmYomitanBridge.yomitanVersion({timeoutMs: 500}); }
      catch (error) { lastError = error; }
    }
    throw lastError;
  })()`);
  console.log('Yomitan frontend ready:', version);
  const entries = await win.webContents.executeJavaScript("gsmYomitanBridge.termEntries('食べる')");
  assert.ok(entries.dictionaryEntries.length > 0, 'the saved dictionary must remain available');
  await win.webContents.executeJavaScript(`window.popupShown = false;
    window.addEventListener('yomitan-popup-shown', () => { window.popupShown = true; });`);
  const point = await win.webContents.executeJavaScript(`(() => {
    const r = document.querySelector('#word').getBoundingClientRect();
    return {x: Math.round(r.x + 12), y: Math.round(r.y + 16)};
  })()`);
  win.webContents.sendInputEvent({type: 'mouseMove', ...point});
  await win.webContents.executeJavaScript(`(async () => {
    for (let i = 0; i < 100; i++) {
      if (window.popupShown) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('A mouse lookup did not show a Yomitan popup');
  })()`);
  const popup = win.webContents.mainFrame.frames.find(frame => frame.url.includes('/popup.html'));
  assert.ok(popup, 'a real Yomitan popup frame must be created');
  const definition = await popup.executeJavaScript(`(async () => {
    for (let i = 0; i < 100; i++) {
      if (document.querySelector('.gloss-list')?.textContent.includes('to eat')) return true;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return false;
  })()`);
  assert.equal(definition, true, 'the popup must render the actual dictionary definition');
  console.log('PASS:', phase, 'startup, saved dictionary, bridge and real mouse popup without switching readers');
  win.destroy();
  clearTimeout(timeout);
  app.exit(0);
}).catch(error => { console.error(error); clearTimeout(timeout); app.exit(1); });
