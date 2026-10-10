const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { between } = require('./helpers/overlay-startup.cjs');
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
  const state = { visible: true, index: 11, startIndex: 10, total: 58, routeTitle: 'テストルート', text: '大丈夫', kind: 'choice', saveInstructions: ['セーブ1'], saveNotice: true, nextHotkey: 'Alt+Shift+Right', toggleHotkey: 'Alt+Shift+G' };
  hud.update(state);
  await new Promise(resolve => window.webContents.once('did-finish-load', resolve));
  await new Promise(resolve => setTimeout(resolve, 250));
  const read = () => window.webContents.executeJavaScript(`({ text: document.querySelector('#instruction').textContent, next: document.querySelector('#next').textContent, note: document.querySelector('#note').textContent, reminder: document.querySelector('#save-reminder')?.textContent, footerVisible: !!document.querySelector('footer').offsetHeight, backDisabled: document.querySelector('#back').disabled, progress: document.querySelector('#progress').textContent, node: typeof require, overflowing: document.body.scrollHeight > innerHeight || document.body.scrollWidth > innerWidth })`);
  assert.equal(window.isFocusable(), false);
  assert.equal(window.isFocused(), false);
  assert.equal(window.webContents.getLastWebPreferences().sandbox, true);
  let rendered = await read();
  assert.equal(rendered.text, 'セーブ1');
  assert.match(rendered.note, /earliest convenience/);
  assert.equal(rendered.footerVisible, false);
  assert.equal(await window.webContents.executeJavaScript(`document.body.textContent.includes('大丈夫')`), false);
  assert.equal(window.getBounds().height, 176);
  assert.equal(rendered.node, 'undefined');
  assert.equal(rendered.overflowing, false);
  fs.writeFileSync(path.join(directory, 'save-notice.png'), (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript(`document.querySelector('#hide').click()`);
  await read();
  assert.deepEqual(commands, ['hide']);
  hud.update({ ...state, saveNotice: false, detected: true });
  rendered = await read();
  assert.equal(rendered.text, '大丈夫');
  assert.equal(rendered.reminder, 'Save before choosing: セーブ1');
  assert.equal(rendered.next, 'Next');
  assert.equal(rendered.footerVisible, true);
  assert.equal(rendered.progress, '11–12 / 58');
  assert.equal(rendered.overflowing, false);
  assert.equal(window.getBounds().height, 278);
  await new Promise(resolve => setTimeout(resolve, 100));
  fs.writeFileSync(path.join(directory, 'save-choice.png'), (await window.webContents.capturePage()).toPNG());
  const lookup = new BrowserWindow({ show: false, frame: false, alwaysOnTop: true, skipTaskbar: true, x: 0, y: 0, width: 600, height: 420, backgroundColor: '#243d50' });
  let captureAvailable = true;
  const mainSource = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const context = vm.createContext({
    mainWindow: lookup, vnGuideHud: hud, setTimeout,
    canUseOverlayCapture: () => captureAvailable,
    vnGuideController: { setAvailable: available => hud.update({ ...state, saveNotice: false, detected: true, visible: available }) },
  });
  vm.runInContext(mainSource.match(/^function refreshVnGuideWindow\([\s\S]*?^}/m)[0], context);
  vm.runInContext(between(mainSource, '  // Keep the VN guide above', '  // Update tray menu when window visibility changes'), context);
  let assertGuideAbove = () => {};
  if (process.platform === 'win32') {
    const user32 = require('koffi').load('user32.dll');
    const getWindow = user32.func('uintptr_t __stdcall GetWindow(uintptr_t hWnd, uint32_t uCmd)');
    const handle = win => win.getNativeWindowHandle().length === 8 ? win.getNativeWindowHandle().readBigUInt64LE() : BigInt(win.getNativeWindowHandle().readUInt32LE());
    assertGuideAbove = () => {
      const guideHandle = handle(window);
      let above = handle(lookup);
      for (let count = 0; above && count < 2000; count += 1) {
        above = BigInt(getWindow(above, 3)); // GW_HWNDPREV: next window above this one.
        if (above === guideHandle) return;
      }
      assert.fail('The guide must be above the re-shown lookup/freeze-frame window');
    };
  }
  for (let cycle = 0; cycle < 3; cycle += 1) {
    lookup.show();
    lookup.setAlwaysOnTop(true, 'screen-saver');
    lookup.moveTop();
    lookup.focus();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(window.isVisible(), true);
    assert.equal(window.isFocused(), false);
    assertGuideAbove();
    lookup.hide();
    assert.equal(window.isVisible(), true, 'manual hide-overlay must leave the guide available');
  }
  captureAvailable = false;
  lookup.show();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(window.isVisible(), false, 'a late reveal callback cannot revive the guide without capture');
  lookup.destroy();
  hud.update({ ...state, saveNotice: false, detected: false, rememberedChoice: true });
  rendered = await read();
  assert.match(rendered.note, /fresh scan/);
  assert.equal(rendered.reminder, 'Save before choosing: セーブ1');
  await window.webContents.executeJavaScript(`document.querySelector('#next').click()`);
  await read();
  assert.deepEqual(commands, ['hide', 'next']);
  hud.update({ ...state, saveNotice: false, saveInstructions: [], kind: 'load', text: 'セーブ1にロード' });
  rendered = await read();
  assert.equal(rendered.next, 'Done');
  assert.match(rendered.note, /then press Done/);
  assert.equal(window.getBounds().height, 246);
  const unsafe = '<img src=x onerror=alert(1)> 大丈夫？';
  hud.update({ ...state, saveNotice: false, text: unsafe.repeat(20), saveInstructions: [unsafe.repeat(20), 'セーブ2'], routeTitle: '<script>bad</script>', startIndex: 0 });
  rendered = await read();
  assert.equal(rendered.text, unsafe.repeat(20));
  assert.equal(rendered.reminder, `Save before choosing: ${unsafe.repeat(20)} · セーブ2`);
  assert.equal(rendered.backDisabled, true);
  assert.equal(rendered.overflowing, false);
  assert.equal(await window.webContents.executeJavaScript(`document.querySelectorAll('img').length`), 0);
  hud.update({ ...state, saveInstructions: [unsafe.repeat(20), 'セーブ2'] });
  rendered = await read();
  assert.equal(rendered.text, `${unsafe.repeat(20)}\nセーブ2`);
  assert.equal(rendered.overflowing, false);
  hud.update({ ...state, visible: false });
  hud.reassertTopmost();
  assert.equal(window.isVisible(), false);
  hud.dispose();
  assert.equal(window.isDestroyed(), true);
  console.log(JSON.stringify({ result: 'VN guide render, sandbox, focus, buttons and layout passed', screenshots: directory }));
  clearTimeout(timeout);
  app.quit();
}).catch(error => { console.error(error); clearTimeout(timeout); app.exit(1); });
