// Exercise the real overlay renderer and its settings/hotkey IPC in Chromium.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-furigana-visibility-'));
app.setPath('userData', path.join(directory, 'profile'));
app.commandLine.appendSwitch('disable-background-networking');
app.on('window-all-closed', () => {});
const timeout = setTimeout(() => { console.error('Furigana visibility test timed out'); app.exit(1); }, 30000);
const errors = [];
ipcMain.on('settings-test-error', (_event, error) => errors.push(error));

app.whenReady().then(async () => {
  const settings = {
    fontSize: 42, weburl1: 'ws://127.0.0.1:1', weburl2: 'ws://127.0.0.1:2',
    gamepadEnabled: false, jitenHighlightingEnabled: false, showFurigana: true,
    readingLanguage: 'chinese', hideFuriganaOnStartup: true, hideFuriganaAfterSeconds: 0,
    overlaySettingsProfilesEnabled: true, overlayActiveProfileName: 'VN',
  };
  // The backend may identify the current profile after the overlay has loaded
  // the default profile. Exercise that real startup ordering with Japanese.
  const profileView = new BrowserWindow({ show: false, webPreferences: {
    nodeIntegration: true, contextIsolation: false, backgroundThrottling: false,
    preload: path.join(__dirname, 'helpers/settings-electron-preload.cjs'),
  } });
  const profileRun = source => profileView.webContents.executeJavaScript(source);
  const profileSend = async (channel, payload) => {
    profileView.webContents.send(channel, payload);
    await profileRun('new Promise(resolve => setTimeout(resolve, 0))');
  };
  await profileView.loadFile(path.join(__dirname, '../index.html'));
  await profileSend('load-settings', { ...settings, overlayActiveProfileName: 'Default',
    showFurigana: false, hideFuriganaOnStartup: false, readingLanguage: 'japanese' });
  await profileSend('settings-updated', { ...settings, readingLanguage: 'japanese' });
  await profileRun(`(async () => {
    await syncGamepadHandlerLifecycle();
    gamepadHandler.canRequestFurigana = () => true;
    gamepadHandler.isUsingJitenApi = () => false;
    gamepadHandler.requestFurigana = async text => ({ segments: [{ text, start: 0, end: text.length, reading: 'にほん' }] });
  })()`);
  await profileRun(`renderFuriganaForFrame([{ text: '日本', words: [{ text: '日本',
    bounding_rect: { x1: 0.1, y1: 0.1, x3: 0.3, y3: 0.15 } }] }], overlayRenderGeneration, null, null)`);
  assert.equal(await profileRun("document.querySelector('.furigana-reading')?.textContent"), 'にほん');
  assert.equal(await profileRun("getComputedStyle(document.getElementById('furigana-layer')).display"), 'none',
    'a profile loaded after startup must apply its hide-on-startup preference');
  await profileSend('toggle-furigana-visibility');
  assert.equal(await profileRun("getComputedStyle(document.getElementById('furigana-layer')).display"), 'block',
    'the first hotkey press reveals readings for the active profile');
  await profileSend('settings-updated', { ...settings, readingLanguage: 'japanese' });
  assert.equal(await profileRun("getComputedStyle(document.getElementById('furigana-layer')).display"), 'block',
    'a repeated profile snapshot must preserve the hotkey choice');
  await profileSend('settings-updated', { ...settings, overlayActiveProfileName: 'Default',
    hideFuriganaOnStartup: false, readingLanguage: 'japanese' });
  assert.equal(await profileRun("getComputedStyle(document.getElementById('furigana-layer')).display"), 'block',
    'a profile configured for visible readings starts visible');
  await profileSend('toggle-furigana-visibility');
  await profileSend('settings-updated', { ...settings, overlayActiveProfileName: 'Default',
    hideFuriganaOnStartup: false, readingLanguage: 'japanese' });
  assert.equal(await profileRun("getComputedStyle(document.getElementById('furigana-layer')).display"), 'none',
    'repeated snapshots also preserve a manually hidden state');
  await profileSend('settings-updated', { ...settings, readingLanguage: 'japanese' });
  assert.equal(await profileRun("getComputedStyle(document.getElementById('furigana-layer')).display"), 'none',
    'returning to a profile uses its startup preference');
  profileView.destroy();
  const view = new BrowserWindow({ show: false, width: 1280, height: 720, webPreferences: {
    nodeIntegration: true, contextIsolation: false, backgroundThrottling: false,
    preload: path.join(__dirname, 'helpers/settings-electron-preload.cjs'),
  } });
  const run = source => view.webContents.executeJavaScript(source);
  const send = async (channel, payload) => {
    view.webContents.send(channel, payload);
    await run('new Promise(resolve => setTimeout(resolve, 0))');
  };
  const visible = () => run("getComputedStyle(document.getElementById('furigana-layer')).display !== 'none'");
  const render = text => run(`renderFuriganaForFrame([${JSON.stringify({
    text, words: [{ text, bounding_rect: { x1: 0.1, y1: 0.1, x3: 0.3, y3: 0.15 } }],
  })}], overlayRenderGeneration, null, null)`);

  await view.loadFile(path.join(__dirname, '../index.html'));
  await send('load-settings', settings);
  assert.deepEqual(errors, []);
  await render('你好');
  assert.ok(await run("document.querySelectorAll('.furigana-reading').length > 0"), 'readings were rendered');
  assert.equal(await visible(), false, 'startup preference hides the rendered readings');
  await render('世界');
  assert.equal(await visible(), false, 'new text must not reveal readings hidden on startup');
  await send('toggle-furigana-visibility');
  assert.equal(await visible(), true, 'the first hotkey press reveals startup-hidden readings');
  await send('load-settings', settings);
  assert.equal(await visible(), true, 'a repeated startup settings delivery must not undo the hotkey');
  await send('load-settings', { ...settings, showFurigana: false });
  assert.equal(await visible(), false, 'a repeated delivery can disable readings');
  await send('load-settings', settings);
  assert.equal(await visible(), true, 're-enabling readings restores the hotkey choice');
  await send('toggle-furigana-visibility');
  assert.equal(await visible(), false, 'the hotkey can hide readings again');
  await send('toggle-furigana-visibility');
  assert.equal(await visible(), true, 'the hotkey can reveal readings again');

  await send('settings-updated', { hideFuriganaAfterSeconds: 0.05 });
  await run('new Promise(resolve => setTimeout(resolve, 100))');
  assert.equal(await visible(), false, 'the auto-hide timer hides readings');
  await send('toggle-furigana-visibility');
  assert.equal(await visible(), true, 'the first hotkey press reveals auto-hidden readings');
  assert.deepEqual(errors, []);
  view.destroy();

  const disabled = new BrowserWindow({ show: false, webPreferences: {
    nodeIntegration: true, contextIsolation: false, backgroundThrottling: false,
    preload: path.join(__dirname, 'helpers/settings-electron-preload.cjs'),
  } });
  await disabled.loadFile(path.join(__dirname, '../index.html'));
  disabled.webContents.send('load-settings', { ...settings, showFurigana: false });
  await disabled.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 0))');
  disabled.webContents.send('settings-updated', { showFurigana: true });
  await disabled.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 0))');
  assert.equal(await disabled.webContents.executeJavaScript("getComputedStyle(document.getElementById('furigana-layer')).display"), 'none',
    'the startup preference applies even when readings were disabled at launch');
  disabled.webContents.send('toggle-furigana-visibility');
  await disabled.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 0))');
  assert.equal(await disabled.webContents.executeJavaScript("getComputedStyle(document.getElementById('furigana-layer')).display"), 'block');
  disabled.webContents.send('settings-updated', { hideFuriganaOnStartup: false });
  await disabled.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 0))');
  assert.equal(await disabled.webContents.executeJavaScript("getComputedStyle(document.getElementById('furigana-layer')).display"), 'block',
    'changing the startup preference alone does not undo the current visibility');
  assert.deepEqual(errors, []);
  disabled.destroy();
  clearTimeout(timeout);
  console.log('Furigana startup, hotkey, repeated settings delivery, and auto-hide behavior passed.');
  app.quit();
}).catch(error => { console.error(error); clearTimeout(timeout); app.exit(1); });
