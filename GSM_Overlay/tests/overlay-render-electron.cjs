// Exact before/after DOM, pixel geometry and layout-cost comparison in Chromium.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { rendererFixtureSource, renderCases, line, overlayRoot, readRenderer } = require('./helpers/overlay-render.cjs');

const reference = execFileSync('git', ['rev-parse', process.argv[2] || 'HEAD'], { cwd: overlayRoot, encoding: 'utf8' }).trim();
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-overlay-render-'));
app.setPath('userData', path.join(directory, 'profile'));
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND');
const timeout = setTimeout(() => { console.error('Overlay render comparison timed out'); app.exit(1); }, 120_000);

app.whenReady().then(async () => {
  const baseline = execFileSync('git', ['show', `${reference}:GSM_Overlay/index.html`], { cwd: overlayRoot, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  const blocks = fs.readFileSync(path.join(overlayRoot, 'block_detection.js'), 'utf8');
  const referenceBlocks = execFileSync('git', ['show', `${reference}:GSM_Overlay/block_detection.js`], { cwd: overlayRoot, encoding: 'utf8' });
  const windows = [];
  for (const html of [baseline, readRenderer()]) {
    const window = new BrowserWindow({ show: false, width: 1920, height: 1080, webPreferences: { session: session.fromPartition(`render-${windows.length}`), backgroundThrottling: false } });
    window.webContents.on('console-message', event => { if (event.level === 'error') console.error(event.message); });
    await window.loadURL('about:blank');
    await window.webContents.executeJavaScript(rendererFixtureSource(html, windows.length === 0 ? referenceBlocks : blocks));
    if (windows.length === 1) {
      await window.webContents.executeJavaScript(fs.readFileSync(path.join(overlayRoot, 'window_occlusion.js'), 'utf8'));
    }
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Performance.enable');
    windows.push(window);
  }
  const run = (window, payload, options) => window.webContents.executeJavaScript(`renderFixture(${JSON.stringify(payload)}, ${JSON.stringify(options)})`);
  let comparisons = 0;
  for (const size of [[1920, 1080], [1280, 720], [1023, 767]]) {
    // Native window resize/menu updates can arrive asynchronously on Windows.
    // Pin the CSS viewport in Chromium so both versions see identical geometry.
    for (const window of windows) await window.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: size[0], height: size[1], screenWidth: size[0], screenHeight: size[1], deviceScaleFactor: 1, mobile: false,
    });
    for (const payload of renderCases()) {
      for (const options of [{}, { offsetX: -1.237, offsetY: 2.741, pinned: true, mainBoxBounds: { left: 100, top: 200, right: 1000, bottom: 750 } }, { recycled: true }, { magpie: {
        sourceWindowLeftEdgePosition: 321, sourceWindowTopEdgePosition: 157,
        sourceWindowRightEdgePosition: 1541, sourceWindowBottomEdgePosition: 867,
        magpieWindowLeftEdgePosition: 0, magpieWindowTopEdgePosition: 0,
        magpieWindowRightEdgePosition: 2560, magpieWindowBottomEdgePosition: 1440,
      } }]) {
        for (const window of windows) await window.webContents.executeJavaScript('resetFixture()');
        for (const frame of [options, { ...options, offsetX: 1.734, offsetY: -0.83 }, { ...options, supplemental: true }]) {
          const outputs = [];
          for (const window of windows) outputs.push(await run(window, payload, frame));
          try {
            assert.deepEqual(outputs[1], outputs[0]);
          } catch {
            const mismatchPath = path.join(directory, 'mismatch.json');
            fs.writeFileSync(mismatchPath, JSON.stringify({ comparisons, size, payload, frame, outputs }, null, 2));
            throw new Error(`Renderer mismatch at comparison ${comparisons}; details: ${mismatchPath}`);
          }
          comparisons++;
        }
      }
    }
  }
  const payload = renderCases().at(-1);
  const timings = [[], []], layoutCounts = [[], []];
  for (const window of windows) {
    await window.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 1920, height: 1080, screenWidth: 1920, screenHeight: 1080, deviceScaleFactor: 1, mobile: false,
    });
    await window.webContents.executeJavaScript('resetFixture()');
    await run(window, payload, {});
  }
  for (let repeat = 0; repeat < 6; repeat++) {
    for (const side of (repeat % 2 ? [0, 1] : [1, 0])) {
      const window = windows[side];
      const measure = async () => Object.fromEntries((await window.webContents.debugger.sendCommand('Performance.getMetrics')).metrics.map(({ name, value }) => [name, value]));
      const before = await measure();
      const elapsed = await window.webContents.executeJavaScript(`(() => { const start = performance.now(); for (let i = 0; i < 4; i++) { resetFixture(); renderFixture(${JSON.stringify(payload)}, { measureOnly: true }); } return (performance.now() - start) / 4; })()`);
      const after = await measure();
      timings[side].push(elapsed);
      layoutCounts[side].push((after.LayoutCount - before.LayoutCount) / 4);
    }
  }
  const median = values => { const sorted = values.slice().sort((a, b) => a - b); return (sorted[2] + sorted[3]) / 2; };
  const metrics = windows.map((_, side) => ({ milliseconds: median(timings[side]), layoutsPerFrame: median(layoutCounts[side]), roundsMs: timings[side] }));
  console.log(JSON.stringify({ comparisons, reference, benchmarkViewport: [1920, 1080], metrics }, null, 2));
  assert(metrics[1].layoutsPerFrame <= 3, 'Rendering must batch layout reads across the frame');
  // Exercise real Chromium hit-testing with production-rendered OCR boxes.
  // Physical desktop pixels include a negative monitor origin and 200% scaling.
  const coverage = await windows[1].webContents.executeJavaScript(`(() => {
    resetFixture();
    GSMWindowOcclusion.setDisplayInfo({ physicalBounds: { x: -3840, y: -200, width: 3840, height: 2160 } });
    const payload = ${JSON.stringify({ data: [line('猫犬鳥', 0.1, 0.2, 0.3, 0.04, false, true)] })};
    renderFixture(payload);
    const boxes = [...document.querySelectorAll('.text-box')].filter(box => box.textContent.trim());
    const first = boxes[0], last = boxes.at(-1);
    const rect = first.getBoundingClientRect();
    const point = box => { const r = box.getBoundingClientRect(); return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 }; };
    const hit = box => { const p = point(box); return document.elementFromPoint(p.x, p.y)?.closest('.text-box') === box; };
    const cover = { left: (rect.left - 1) * 2 - 3840, top: (rect.top - 1) * 2 - 200,
      right: rect.right * 2 - 3840, bottom: (rect.bottom + 1) * 2 - 200 };
    const before = hit(first);
    window.dispatchEvent(new CustomEvent('gsm-window-state-update', { detail: { data: 'background', occlusion_rects: [cover] } }));
    const hidden = getComputedStyle(first).visibility === 'hidden';
    const coveredHit = hit(first), visibleHit = hit(last);
    // Recalibration/new OCR must reuse the mask before allowing a lookup.
    renderFixture(payload);
    const hiddenAfterRender = getComputedStyle(document.querySelector('.text-box')).visibility === 'hidden';
    window.dispatchEvent(new CustomEvent('gsm-window-state-update', { detail: { data: 'active', occlusion_rects: [] } }));
    const restoredHit = hit(document.querySelector('.text-box'));
    return { before, hidden, coveredHit, visibleHit, hiddenAfterRender, restoredHit };
  })()`);
  assert.deepEqual(coverage, { before: true, hidden: true, coveredHit: false, visibleHit: true, hiddenAfterRender: true, restoredHit: true });
  console.log('Partial coverage: covered text rejects pointer hits; visible and restored text remain lookupable.');
  for (const window of windows) window.destroy();
  clearTimeout(timeout);
  app.quit();
}).catch(error => { console.error(error); clearTimeout(timeout); app.exit(1); });
