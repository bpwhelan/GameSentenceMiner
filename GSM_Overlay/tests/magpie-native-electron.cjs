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
    let clickThrough = true;
    const hover = module.exports.createTextHoverController({window, document, onIgnore() {},
      isClickThroughEnabled: () => clickThrough});
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
    clickThrough = false;
    const capturedHit = hover.project(magpiePointerToViewport(point, display, window));
    document.body.classList.toggle('magpie-pointer-hover', capturedHit);
    const capturedSurface = getComputedStyle(box).backgroundColor;
    box.style.visibility = 'hidden';
    const hiddenHit = hover.project(magpiePointerToViewport(point, display, window));
    return { hit, capturedHit, capturedSurface, hiddenHit, before, after, surface, moves };
  })()`);
  assert.equal(hits.hit, false, 'hovered text must pass clicks to the game');
  assert.equal(hits.moves, 1, 'hover still reaches the dictionary scanner');
  assert.equal(hits.hiddenHit, false);
  assert.equal(hits.before, 'rgba(255, 255, 255, 0)');
  assert.equal(hits.after, hits.before, 'OCR text remains transparent over the game');
  assert.match(hits.surface, /, 0\)$/);
  assert.equal(hits.capturedHit, true, 'text accepts input when click-through is off');
  assert.match(hits.capturedSurface, /, 0\.004\)$/, 'Magpie can hit the text surface for native handoff');

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

    const foreground = lib.func('uintptr_t __stdcall GetForegroundWindow()');
    const beforeFocus = foreground();
    const scaler = new BrowserWindow({ show: false, focusable: false, skipTaskbar: true,
      frame: false, width: 100, height: 100, opacity: 0 });
    await scaler.loadURL('about:blank');
    scaler.setIgnoreMouseEvents(true);
    scaler.showInactive();
    scaler.setAlwaysOnTop(true);
    const scalerHwnd = Number(handleValue(scaler.getNativeWindowHandle()));
    win.setAlwaysOnTop(true);
    win.moveTop();
    assert.equal(native.isAbove(scalerHwnd, win), false);
    assert.equal(native.isAbove(Number(hwnd), scaler), true);
    assert.equal(native.isAbove(Number(hwnd), win), false);
    let repairs = 0;
    const stopOrderWatch = native.watch(win, () => {}, () => {
      if (!native.isAbove(scalerHwnd, win)) return;
      // The production repair changes only our own window, without activation.
      win.showInactive();
      win.setAlwaysOnTop(true, 'screen-saver');
      win.moveTop();
      repairs++;
    });
    for (let cycle = 0; cycle < 3; cycle++) {
      scaler.moveTop(); // A late native reorder, after the earlier overlay raise.
      assert.equal(native.isAbove(scalerHwnd, win), true);
      const end = Date.now() + 2000;
      while (repairs <= cycle && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(repairs, cycle + 1, 'desktop reorder must reach the Electron listener');
      assert.equal(native.isAbove(scalerHwnd, win), false, 'the overlay must end above the scaler');
      assert.equal(foreground(), beforeFocus, 'repair must not flicker foreground focus');
    }
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(repairs, 3, 'our own raises must not form a feedback loop');
    stopOrderWatch();
    stopOrderWatch(); // Cleanup is safe during overlapping window/session teardown.
    scaler.moveTop();
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(repairs, 3, 'a stopped listener must never raise the overlay');
    assert.equal(native.isAbove(scalerHwnd, win), true);
    scaler.hide();
    assert.equal(native.isAbove(scalerHwnd, win), false, 'a hidden scaler is not coverage');
    scaler.destroy();
    console.log('Native desktop reorder recovery, stable foreground focus, and listener cleanup: passed.');
  }
  console.log('Chromium hit testing, mixed DPI, hidden text, and projected hover painting: passed.');
  win.destroy();
  clearTimeout(deadline);
  app.quit();
}).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
