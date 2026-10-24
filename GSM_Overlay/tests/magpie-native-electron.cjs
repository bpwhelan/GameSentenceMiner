const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMagpieNative, handleValue } = require('../magpie_native');
const { magpiePointerToViewport } = require('../magpie_hit_test');
const { rendererFixtureSource, readRenderer, line, overlayRoot } = require('./helpers/overlay-render.cjs');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-magpie-test-')));
app.commandLine.appendSwitch('disable-background-networking');
const deadline = setTimeout(() => app.exit(1), 20000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, focusable: false, skipTaskbar: true, frame: false,
    width: 960, height: 540, opacity: 0, webPreferences: { backgroundThrottling: false } });
  await win.loadURL('about:blank');
  await win.webContents.executeJavaScript(rendererFixtureSource(readRenderer(), fs.readFileSync(path.join(overlayRoot, 'block_detection.js'), 'utf8')));
  const hits = await win.webContents.executeJavaScript(`(() => {
    const magpiePointerToViewport = ${magpiePointerToViewport.toString()};
    const module = {exports: {}};
    ${fs.readFileSync(path.join(overlayRoot, 'text_hover.js'), 'utf8')}
    const hover = module.exports.createTextHoverController({window, document, onIgnore() {}});
    const display = { physicalBounds: { x: -1920, y: 164 }, physicalSize: { width: 1920, height: 1080 } };
    renderFixture(${JSON.stringify({ data: [line('日本語', 0.2, 0.4, 0.3, 0.1)] })});
    document.body.classList.add('magpie-active');
    const box = document.querySelector('.text-box');
    const rect = box.getBoundingClientRect();
    const point = { x: (rect.left + rect.width / 2) / innerWidth * 1920 - 1920,
      y: (rect.top + rect.height / 2) / innerHeight * 1080 + 164 };
    let moves = 0;
    box.addEventListener('pointermove', () => moves++);
    const before = getComputedStyle(box).color;
    const hit = hover.project(magpiePointerToViewport(point, display, window));
    const after = getComputedStyle(box).color;
    const surface = getComputedStyle(box).backgroundColor;
    box.style.visibility = 'hidden';
    const hiddenHit = hover.project(magpiePointerToViewport(point, display, window));
    return { hit, hiddenHit, before, after, surface, moves };
  })()`);
  assert.equal(hits.hit, false, 'hovered text must pass clicks to the game');
  assert.equal(hits.moves, 1, 'hover still reaches the dictionary scanner');
  assert.equal(hits.hiddenHit, false);
  assert.equal(hits.before, 'rgba(255, 255, 255, 0)');
  assert.equal(hits.after, hits.before, 'OCR text remains transparent over the game');
  assert.match(hits.surface, /, 0\)$/);

  if (process.platform === 'win32') {
    const native = createMagpieNative();
    const lib = require('koffi').load('user32.dll');
    const message = lib.func('uint32 __stdcall RegisterWindowMessageW(str16)')('MagpieScalingChanged');
    const post = lib.func('int __stdcall PostMessageW(uintptr_t, uint32, uintptr_t, intptr_t)');
    const prop = lib.func('int __stdcall SetPropW(uintptr_t, str16, uintptr_t)');
    const remove = lib.func('uintptr_t __stdcall RemovePropW(uintptr_t, str16)');
    const hwnd = handleValue(win.getNativeWindowHandle());
    const received = new Promise(resolve => {
      const unwatch = native.watch(win, (code, parameter) => { unwatch(); resolve({ code, parameter }); });
    });
    // Send only to this test window, never to HWND_BROADCAST or another app.
    assert.ok(post(hwnd, message, 2, 0x123456789n));
    assert.deepEqual(await received, { code: 2, parameter: 0x123456789 });
    assert.ok(prop(hwnd, 'Magpie.SrcHWND', 42));
    win.showInactive(); // Invisible, non-focusable fixture for IsWindowVisible.
    const info = { scaling_hwnd: Number(hwnd), source_hwnd: 42 };
    win.setIgnoreMouseEvents(false);
    const cursor = native.cursor(info);
    assert.ok(Number.isFinite(cursor.x) && Number.isFinite(cursor.y));
    assert.equal(cursor.captured, false);
    win.setIgnoreMouseEvents(true);
    assert.equal(native.cursor(info).captured, true);
    remove(hwnd, 'Magpie.SrcHWND');
    assert.equal(native.cursor(info), null);
    console.log('Native Windows broadcast, 64-bit message parameters, cursor coordinates, and capture style: passed.');
  }
  console.log('Chromium hit testing, mixed DPI, hidden text, and projected hover painting: passed.');
  win.destroy();
  clearTimeout(deadline);
  app.quit();
}).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
