// Controlled Chromium profile of production hover/stats code. No game, capture,
// network, installed settings, or running GSM instance is touched.
// node scripts/benchmark-overlay-idle.cjs [baseline-source-directory] [seconds]
// The optional directory contains magpie_session.js and live_stats_widget.js.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');
const overlayRoot = path.resolve(__dirname, '../GSM_Overlay');

if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, ...process.argv.slice(2)], {
    env, windowsHide: true, stdio: 'inherit',
  });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const { rendererFixtureSource, readRenderer, line } = require('../GSM_Overlay/tests/helpers/overlay-render.cjs');
  const baseline = process.argv[2] ? path.resolve(process.argv[2]) : null;
  const seconds = Number(process.argv[3] || 8);
  if (!Number.isFinite(seconds) || seconds < 2 || seconds > 30) throw new Error('Duration must be 2–30 seconds');
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-idle-profile-')));
  app.commandLine.appendSwitch('disable-background-networking');
  app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND');
  app.on('window-all-closed', () => {});
  const deadline = setTimeout(() => app.exit(1), 240_000);
  const read = (directory, file) => fs.readFileSync(path.join(directory, file), 'utf8');
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const metrics = async win => Object.fromEntries((await win.webContents.debugger.sendCommand('Performance.getMetrics')).metrics.map(({ name, value }) => [name, value]));

  async function profile(directory, scenario) {
    const win = new BrowserWindow({ show: false, width: 1920, height: 1080,
      webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
    let session = null, hitTests = 0;
    const receive = (event, reply) => { if (event.sender === win.webContents) session?.handleHit(reply); };
    try {
      await win.loadURL('about:blank');
      await win.webContents.executeJavaScript(rendererFixtureSource(readRenderer(), read(overlayRoot, 'block_detection.js')));
      const payload = { data: Array.from({ length: 16 }, (_, i) => line('日本語の台詞です。'.repeat(5), 0.05, 0.03 + i * 0.055, 0.86, 0.04, false, true)) };
      await win.webContents.executeJavaScript(`(() => {
        renderFixture(${JSON.stringify(payload)});
        window.__timerTicks = 0;
        const interval = window.setInterval.bind(window);
        window.setInterval = (fn, ms, ...args) => interval(() => { window.__timerTicks++; fn(...args); }, ms);
        const module = { exports: {} };
        ${read(overlayRoot, 'text_hover.js')}
        const hover = module.exports.createTextHoverController({ window, document, onIgnore() {} });
        require('electron').ipcRenderer.on('profile-pointer', (_event, sample) => {
          const hit = hover.project(sample);
          require('electron').ipcRenderer.send('profile-hit', { sequence: sample.sequence, hit });
        });
        ${read(directory, 'live_stats_widget.js')}
        GSMLiveStatsWidget.applySettings({ showLiveStats: false, showLiveGoals: false });
      })()`);
      if (scenario !== 'disabled-stats') {
        const context = { module: { exports: {} }, require: id => require(path.join(overlayRoot, id)), setInterval, clearInterval, Date };
        vm.runInNewContext(read(directory, 'magpie_session.js'), context);
        let x = 200;
        const info = { source_hwnd: 42, scaling_hwnd: 99,
          sourceWindowLeftEdgePosition: 0, sourceWindowTopEdgePosition: 0,
          sourceWindowRightEdgePosition: 1920, sourceWindowBottomEdgePosition: 1080,
          magpieWindowLeftEdgePosition: 0, magpieWindowTopEdgePosition: 0,
          magpieWindowRightEdgePosition: 1920, magpieWindowBottomEdgePosition: 1080 };
        session = context.module.exports.createMagpieSession({
          native: { read: () => info, watch: () => () => {}, cursor: () => ({ x: scenario === 'moving-pointer' ? (x = 200 + (x - 199) % 500) : x, y: 50, captured: false, buttons: 0 }) },
          // Keep the fixture off the desktop while exercising the visible
          // overlay's pointer path (the real session gates on visibility).
          window: { isVisible: () => true, isDestroyed: () => win.isDestroyed() },
          canTrackPointer: () => true, onScaling() {}, requestRefresh() {}, setIgnoreMouseEvents() {},
          onPointer: sample => { hitTests++; win.webContents.send('profile-pointer', sample); },
        });
        ipcMain.on('profile-hit', receive);
        session.updateTarget(42);
      }
      win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Performance.enable');
      await win.webContents.debugger.sendCommand('Profiler.enable');
      await wait(1000); // Exclude initial layout/font/script work.
      hitTests = 0;
      await win.webContents.executeJavaScript('window.__timerTicks = 0');
      const before = await metrics(win);
      const started = performance.now();
      const mainCpu = process.cpuUsage();
      await win.webContents.debugger.sendCommand('Profiler.start');
      await wait(seconds * 1000);
      const elapsed = performance.now() - started;
      const cpu = process.cpuUsage(mainCpu);
      const after = await metrics(win);
      if (scenario !== 'disabled-stats' && hitTests === 0) throw new Error('Pointer fixture did not run');
      const { profile: samples } = await win.webContents.debugger.sendCommand('Profiler.stop');
      const nodes = new Map(samples.nodes.map(node => [node.id, node.callFrame.functionName || '(anonymous)']));
      const counts = new Map();
      for (const id of samples.samples || []) {
        const name = nodes.get(id);
        if (name !== '(idle)') counts.set(name, (counts.get(name) || 0) + 1);
      }
      return { scenario, source: directory === overlayRoot ? 'current' : 'baseline',
        elapsedMs: Math.round(elapsed), hitTests, timerTicks: await win.webContents.executeJavaScript('window.__timerTicks'),
        mainCpuMs: (cpu.user + cpu.system) / 1000,
        rendererTaskMs: (after.TaskDuration - before.TaskDuration) * 1000,
        scriptMs: (after.ScriptDuration - before.ScriptDuration) * 1000,
        layouts: after.LayoutCount - before.LayoutCount,
        styleRecalculations: after.RecalcStyleCount - before.RecalcStyleCount,
        topSamples: [...counts].sort((a, b) => b[1] - a[1]).slice(0, 6),
      };
    } finally {
      session?.dispose();
      ipcMain.removeListener('profile-hit', receive);
      win.destroy();
    }
  }

  app.whenReady().then(async () => {
    const results = [];
    for (const scenario of ['disabled-stats', 'stationary-pointer', 'moving-pointer']) {
      for (const directory of baseline ? [baseline, overlayRoot] : [overlayRoot]) {
        const result = await profile(directory, scenario);
        results.push(result);
        console.log(JSON.stringify(result));
      }
    }
    console.log(JSON.stringify({ seconds, results }, null, 2));
    clearTimeout(deadline);
    app.exit(0);
  }).catch(error => { console.error(error); app.exit(1); });
}
