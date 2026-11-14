// Profile the production renderer with isolated, deterministic desktop/reader data.
// No running GSM instance, game capture, user profile, or network is used.
// node scripts/benchmark-desktop-idle.cjs [renderer-dist-directory] [seconds]
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

if (process.type === 'renderer') {
  const count = Number(process.argv.find(arg => arg.startsWith('--fixture-lines='))?.split('=')[1] || 0);
  const listeners = new Map();
  window.__idleCalls = {};
  window.gsmEnv = { platform: 'win32' };
  window.clipboard = { readText: async () => '', writeText: async () => {} };
  window.ipcRenderer = {
    invoke: async (channel, action) => {
      window.__idleCalls[channel] = (window.__idleCalls[channel] || 0) + 1;
      // Return fresh values, just like a real IPC round trip.
      switch (channel) {
        case 'settings.getSettings': return { locale: 'en', hasCompletedSetup: true, theme: 'gsm-dark' };
        case 'get_gsm_status': return { ready: true, status: 'Running', obs_connected: true, anki_connected: false, clipboard_enabled: false, websockets_connected: {} };
        case 'getOverlayStatus': return { isRunning: false };
        case 'obs.getScenes': return [{ id: 'game', name: 'Saved game (closed)' }];
        case 'obs.getActiveScene': return { id: 'game', name: 'Saved game (closed)' };
        case 'settings.listGSMProfiles': return { profiles: ['Default'], profileScenes: {} };
        case 'reader.connection': return { baseUrl: 'http://127.0.0.1:1', websocketUrl: 'ws://127.0.0.1:1', storageKey: 'idle-fixture' };
        case 'reader.request': return action === 'state' ? { session_id: 'fixture', selected_ids: [], timed_out_ids: [], text_intake_paused: false } : {};
        case 'reader.dictionaryTransfers': return [];
        case 'game-background.getState': return { sceneId: 'game', phase: 'waiting', options: {} };
        case 'textprocess.load': return { config: {}, profiles: [] };
        case 'ocr.getStatus': return { isRunning: false };
        case 'obs.getWindows': case 'texthook.getProcesses': return [];
        default: return null;
      }
    },
    send() {},
    on(channel, fn) { const set = listeners.get(channel) || new Set(); set.add(fn); listeners.set(channel, set); return () => set.delete(fn); },
    once(channel, fn) { const off = this.on(channel, (...args) => { off(); fn(...args); }); },
    removeListener(channel, fn) { listeners.get(channel)?.delete(fn); },
    removeAllListeners(channel) { listeners.delete(channel); },
  };
  window.WebSocket = class {
    constructor() { queueMicrotask(() => this.onopen?.()); }
    send() {
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ event: 'text_v2_snapshot', session_id: 'fixture', lines: Array.from({ length: count }, (_, i) => ({
        id: String(i), session_id: 'fixture', text: '「何も動いていない時には、静かに待っていよう。」',
        stream_sequence: i + 1, revision: 1, state: 'expired', scene: 'Saved game', source: 'OCR', captured_at: '2026-11-14T12:00:00Z',
      })) }) }));
    }
    close() {}
  };
} else if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, ...process.argv.slice(2)], { env, stdio: 'inherit', windowsHide: true });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  const directory = path.resolve(process.argv[2] || path.join(__dirname, '../dist/renderer'));
  const seconds = Number(process.argv[3] || 8);
  if (!Number.isFinite(seconds) || seconds < 2 || seconds > 30) throw Error('Duration must be 2–30 seconds');
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-desktop-idle-')));
  app.commandLine.appendSwitch('disable-background-networking');
  app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND');
  app.on('window-all-closed', () => {});
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const deadline = setTimeout(() => app.exit(1), 180000);
  app.whenReady().then(async () => {
    for (const lines of [0, 1000]) {
      const win = new BrowserWindow({ show: false, width: 1440, height: 960, webPreferences: {
        preload: __filename, contextIsolation: false, sandbox: false, backgroundThrottling: false, additionalArguments: [`--fixture-lines=${lines}`],
      } });
      win.webContents.on('console-message', event => { if (event.level === 'error') console.error(event.message); });
      win.webContents.on('preload-error', (_event, _path, error) => console.error(error));
      try {
        await win.loadFile(path.join(directory, 'index.html'));
        await wait(3000);
        win.webContents.debugger.attach('1.3');
        const send = (name, params = {}) => win.webContents.debugger.sendCommand(name, params);
        const evaluate = expression => win.webContents.executeJavaScript(expression);
        await send('Performance.enable');
        const metrics = async () => Object.fromEntries((await send('Performance.getMetrics')).metrics.map(({ name, value }) => [name, value]));
        const rendered = await evaluate('document.querySelectorAll(".reading-line").length');
        if (!await evaluate('Boolean(document.querySelector(".reading-pane"))')) throw Error('Desktop fixture did not mount');
        if (rendered !== lines) throw Error(`Reader fixture did not load: expected ${lines}, got ${rendered}`);
        for (const hidden of [false, true]) {
          await evaluate(`Object.defineProperty(document, 'visibilityState', {configurable:true, value:${JSON.stringify(hidden ? 'hidden' : 'visible')}}); document.dispatchEvent(new Event('visibilitychange')); window.__idleCalls = {}`);
          await wait(300);
          const before = await metrics();
          await wait(seconds * 1000);
          const after = await metrics();
          console.log(JSON.stringify({ lines, hidden, seconds,
            rendererTaskMs: Math.round((after.TaskDuration - before.TaskDuration) * 1000),
            scriptMs: Math.round((after.ScriptDuration - before.ScriptDuration) * 1000),
            layouts: after.LayoutCount - before.LayoutCount,
            styleRecalculations: after.RecalcStyleCount - before.RecalcStyleCount,
            heapMB: Math.round(after.JSHeapUsedSize / 1048576),
            ...await evaluate('({calls: window.__idleCalls, domNodes:document.querySelectorAll("*").length, terminals:document.querySelectorAll(".xterm").length})'),
          }));
        }
      } finally { win.destroy(); }
    }
    clearTimeout(deadline); app.exit(0);
  }).catch(error => { console.error(error); app.exit(1); });
}
