// Run the production overlay repeatedly inside one Electron host, with disposable
// data and no live GSM backend. The host's window, IPC and shortcut must survive.
const electron = require('electron');
const { app, BrowserWindow, ipcMain, globalShortcut, session, protocol } = electron;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const Module = require('node:module');

const directory = process.env.GSM_OVERLAY_LIFECYCLE_DIRECTORY;
assert.ok(directory, 'Use run-integrated-lifecycle-electron.cjs');
const overlayRoot = path.resolve(__dirname, '..');
const overlayData = path.join(directory, 'overlay');
const gsmData = path.join(directory, 'gsm');
fs.mkdirSync(overlayData, { recursive: true });
fs.mkdirSync(gsmData, { recursive: true });
app.setPath('userData', path.join(directory, 'host'));
app.setPath('sessionData', path.join(directory, 'host'));
process.env.GSM_OVERLAY_IN_PROCESS = '1';
process.env.GSM_OVERLAY_DATA_PATH = overlayData;
process.env.GSM_DATA_DIR = gsmData;
process.env.GSM_INPUT_SERVER_MANAGED = '1';
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
protocol.registerSchemesAsPrivileged([{ scheme: 'chrome-extension', privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true,
} }]);
app.on('window-all-closed', () => {});
app.on('browser-window-created', (_event, window) => window.on('show', () => window.hide()));
const timeout = setTimeout(() => { console.error('Integrated overlay lifecycle timed out'); app.exit(1); }, 90_000);
const overlayTrays = [];
const NativeTray = electron.Tray;
const overlayElectron = { ...electron, Tray: class extends NativeTray {
  constructor(...args) {
    super(...args);
    const setContextMenu = this.setContextMenu.bind(this);
    this.setContextMenu = menu => { this.contextMenu = menu; setContextMenu(menu); };
    overlayTrays.push(this);
  }
} };

const handlers = new Set();
const handle = ipcMain.handle.bind(ipcMain);
const removeHandler = ipcMain.removeHandler.bind(ipcMain);
ipcMain.handle = (channel, listener) => { handle(channel, listener); handlers.add(channel); };
ipcMain.removeHandler = channel => { removeHandler(channel); handlers.delete(channel); };

app.whenReady().then(async () => {
  // Reserve an isolated local port, so test requests cannot reach a user's GSM.
  const offlineServer = net.createServer(socket => socket.destroy());
  await new Promise(resolve => offlineServer.listen(0, '127.0.0.1', resolve));
  const port = offlineServer.address().port;
  process.env.GSM_INPUT_SERVER_PORT = String(port);
  fs.writeFileSync(path.join(gsmData, 'config.json'), JSON.stringify({
    current_profile: 'Default', configs: { Default: { general: { single_port: port }, advanced: {}, overlay: {} } },
  }));
  const hostShortcut = 'Control+Alt+Shift+F11';
  fs.writeFileSync(path.join(overlayData, 'settings.json'), JSON.stringify({
    dictionaryReaderSelection: 'yomitan', pushToShowEnforcedDialogDismissed: true,
    mainBoxStartupWarningAcknowledged: true, openSettingsOnStartup: false,
    hideOnStartup: true, manualMode: true, showHotkey: hostShortcut,
    enableJitenReader: false, gamepadEnabled: false, gamepadControllerEnabled: false,
    gamepadKeyboardEnabled: false, routeAllHotkeysThroughInputServer: false,
  }));
  const host = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } });
  await host.loadURL('data:text/html,Host');
  ipcMain.handle('host-lifecycle-check', () => 'host-alive');
  assert.equal(globalShortcut.register(hostShortcut, () => {}), true, 'host shortcut is available');
  const baselineListeners = Object.fromEntries(ipcMain.eventNames().map(name => [name, ipcMain.listenerCount(name)]));
  const baselineApp = Object.fromEntries(['before-quit', 'will-quit', 'window-all-closed', 'child-process-gone']
    .map(name => [name, app.listenerCount(name)]));
  let stopRequested = false;
  globalThis[Symbol.for('gsm.overlay.host')] = {
    requestStop: () => { stopRequested = true; },
  };
  let extensionId;
  for (let cycle = 0; cycle < 3; cycle++) {
    const load = Module._load;
    let overlay;
    try {
      Module._load = function (request, ...args) {
        return request === 'electron' ? overlayElectron : load.call(this, request, ...args);
      };
      overlay = require('../main.js');
    } finally {
      Module._load = load;
    }
    await overlay.startOverlayApp();
    assert.equal(overlay.isOverlayRunning(), true);
    assert.equal(app.getPath('userData'), path.join(directory, 'host'));
    assert.equal(overlayTrays.length, cycle + 1, 'each enable creates its own overlay tray');
    const overlayTray = overlayTrays[cycle];
    assert.equal(overlayTray.isDestroyed(), false);
    const menu = overlayTray.contextMenu.items;
    assert.ok(menu.some(item => item.label === 'Settings'));
    menu.find(item => item.label === 'Turn off overlay').click();
    assert.equal(stopRequested, true, 'off delegates to the host instead of quitting Electron');
    stopRequested = false;

    const overlaySession = session.fromPath(overlayData);
    const extension = overlaySession.extensions.getAllExtensions().find(item => /Yomitan/i.test(item.name));
    assert.ok(extension, 'loads the real Yomitan extension');
    if (extensionId) assert.equal(extension.id, extensionId);
    extensionId = extension.id;
    const dictionary = new BrowserWindow({ show: false, webPreferences: { session: overlaySession } });
    await dictionary.loadURL(`chrome-extension://${extension.id}/settings.html`);
    if (cycle === 0) {
      const archive = fs.readFileSync(path.join(__dirname, 'fixtures/yomitan-startup.zip')).toString('base64');
      await dictionary.webContents.executeJavaScript(`(async () => {
        const {DictionaryDatabase} = await import('./js/dictionary/dictionary-database.js');
        const {DictionaryImporter} = await import('./js/dictionary/dictionary-importer.js');
        const {DictionaryImporterMediaLoader} = await import('./js/dictionary/dictionary-importer-media-loader.js');
        const database = new DictionaryDatabase();
        await database.prepare();
        const importer = new DictionaryImporter(new DictionaryImporterMediaLoader());
        const {errors} = await importer.importDictionary(database,
          Uint8Array.from(atob(${JSON.stringify(archive)}), c => c.charCodeAt(0)).buffer, {prefixWildcardsSupported: false});
        if (errors.length) throw new Error(errors.map(e => e.message).join('; '));
        await database.close();
        await chrome.storage.local.set({gsmLifecycleMarker: 'saved-dictionary-settings'});
      })()`);
    }
    const saved = await dictionary.webContents.executeJavaScript(`(async () => {
      const {DictionaryDatabase} = await import('./js/dictionary/dictionary-database.js');
      const database = new DictionaryDatabase();
      await database.prepare();
      const dictionaries = await database.getDictionaryInfo();
      await database.close();
      return {dictionaries, marker: (await chrome.storage.local.get('gsmLifecycleMarker')).gsmLifecycleMarker};
    })()`);
    assert.ok(saved.dictionaries.some(item => item.title === 'GSM startup fixture'), 'imported dictionary survives toggling');
    assert.equal(saved.marker, 'saved-dictionary-settings');
    dictionary.destroy();
    overlay.openSettings();
    assert.ok(BrowserWindow.getAllWindows().some(window => window.getTitle() === 'Overlay Settings'));
    await overlay.stopOverlayApp();
    assert.equal(overlay.isOverlayRunning(), false);
    assert.ok(overlayTrays.every(tray => tray.isDestroyed()), 'disabling removes the overlay tray without leaving duplicates');
    assert.equal(host.isDestroyed(), false);
    assert.equal(globalShortcut.isRegistered(hostShortcut), true, 'host shortcut survives overlay shutdown');
    assert.deepEqual([...handlers], ['host-lifecycle-check'], 'all overlay IPC handlers are removed');
    assert.deepEqual(Object.fromEntries(ipcMain.eventNames().map(name => [name, ipcMain.listenerCount(name)])), baselineListeners);
    for (const [event, count] of Object.entries(baselineApp)) assert.equal(app.listenerCount(event), count, event);
    assert.deepEqual(BrowserWindow.getAllWindows().map(window => window.id), [host.id], 'only the host window remains');
    assert.equal(await host.webContents.executeJavaScript("require('electron').ipcRenderer.invoke('host-lifecycle-check')"), 'host-alive');
    for (const filename of Object.keys(require.cache)) {
      if (filename.startsWith(overlayRoot + path.sep)) delete require.cache[filename];
    }
    console.log(`Integrated overlay cycle ${cycle + 1}: passed`);
  }
  offlineServer.close();
  clearTimeout(timeout);
  console.log('PASS: one host, separate overlay tray, clean toggles, persistent Yomitan data');
  app.exit(0);
}).catch(error => { console.error(error); clearTimeout(timeout); app.exit(1); });
