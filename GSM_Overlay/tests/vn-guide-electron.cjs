const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createVnGuideHud } = require('../vn_guide_hud');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-vn-render-'));
app.setPath('userData', path.join(directory, 'profile'));
app.commandLine.appendSwitch('disable-background-networking');
const timeout = setTimeout(() => { console.error('VN guide Electron test timed out'); app.exit(1); }, 25000);

app.whenReady().then(async () => {
  let window;
  const commands = [];
  class TestWindow extends BrowserWindow {
    constructor(options) { super(options); window = this; }
  }
  const hud = createVnGuideHud({ BrowserWindow: TestWindow, getBounds: () => ({ x: 0, y: 0, width: 1920, height: 1080 }) });
  ipcMain.handle('vn-guide-command', (event, { action }) => { assert.ok(hud.owns(event.sender)); commands.push(action); });
  const state = { visible: true, index: 10, total: 58, routeTitle: 'テストルート', text: 'セーブ1', kind: 'save', nextHotkey: 'Alt+Shift+Right', toggleHotkey: 'Alt+Shift+G' };
  hud.update(state);
  await new Promise(resolve => window.webContents.once('did-finish-load', resolve));
  await new Promise(resolve => setTimeout(resolve, 250));
  const read = () => window.webContents.executeJavaScript(`({ text: document.querySelector('#instruction').textContent, next: document.querySelector('#next').textContent, note: document.querySelector('#note').textContent, node: typeof require, overflowing: document.body.scrollHeight > innerHeight || document.body.scrollWidth > innerWidth })`);
  assert.equal(window.isFocusable(), false);
  assert.equal(window.isFocused(), false);
  assert.equal(window.webContents.getLastWebPreferences().sandbox, true);
  let rendered = await read();
  assert.equal(rendered.text, 'セーブ1');
  assert.equal(rendered.next, 'Done');
  assert.equal(rendered.node, 'undefined');
  assert.equal(rendered.overflowing, false);
  fs.writeFileSync(path.join(directory, 'save.png'), (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript(`document.querySelector('#next').click()`);
  await read();
  assert.deepEqual(commands, ['next']);
  hud.update({ ...state, kind: 'choice', text: '大丈夫', detected: true });
  rendered = await read();
  assert.equal(rendered.text, '大丈夫');
  await new Promise(resolve => setTimeout(resolve, 100));
  fs.writeFileSync(path.join(directory, 'choice.png'), (await window.webContents.capturePage()).toPNG());
  const unsafe = '<img src=x onerror=alert(1)> 大丈夫？';
  hud.update({ ...state, kind: 'choice', text: unsafe.repeat(20), routeTitle: '<script>bad</script>' });
  rendered = await read();
  assert.equal(rendered.text, unsafe.repeat(20));
  assert.equal(rendered.overflowing, false);
  assert.equal(await window.webContents.executeJavaScript(`document.querySelectorAll('img').length`), 0);
  hud.update({ ...state, visible: false });
  assert.equal(window.isVisible(), false);
  hud.dispose();
  assert.equal(window.isDestroyed(), true);
  console.log(JSON.stringify({ result: 'VN guide render, sandbox, focus, buttons and layout passed', screenshots: directory }));
  clearTimeout(timeout);
  app.quit();
}).catch(error => { console.error(error); clearTimeout(timeout); app.exit(1); });
