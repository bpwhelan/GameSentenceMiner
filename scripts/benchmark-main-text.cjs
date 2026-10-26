// Profile the built desktop renderer with synthetic Agent text and no backend.
// node scripts/benchmark-main-text.cjs [renderer-directory] [line-count]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
    const { app, BrowserWindow } = require('electron');
    const renderer = path.resolve(process.argv[2] || path.join(__dirname, '../dist/renderer'));
    const lineCount = Number(process.argv[3] || 50);
    if (!Number.isInteger(lineCount) || lineCount < 1 || lineCount > 10_000) throw new Error('Line count must be 1–10000.');
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-main-text-'));
    app.setPath('userData', path.join(scratch, 'profile'));
    app.commandLine.appendSwitch('disable-background-networking');
    app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND');
    app.on('window-all-closed', () => {});
    const deadline = setTimeout(() => { console.error('Desktop text benchmark timed out.'); app.exit(1); }, 60_000);
    const preload = path.join(scratch, 'preload.cjs');
    fs.writeFileSync(preload, `
        const { contextBridge } = require('electron');
        const listeners = new Map();
        const emit = (channel, payload) => {
            for (const callback of listeners.get(channel) || []) callback({}, payload);
        };
        contextBridge.exposeInMainWorld('ipcRenderer', {
            send() {},
            async invoke(channel) {
                switch (channel) {
                    case 'settings.getSettings': return { locale: 'en', hasCompletedSetup: true, consoleMode: 'simple' };
                    case 'obs.getScenes': case 'obs.getWindows': return [];
                    case 'settings.listGSMProfiles': return { profiles: [], profileScenes: {} };
                    case 'get_gsm_status': return { ready: true, status: 'Running', websockets_connected: {} };
                    case 'getOverlayStatus': return { isRunning: false };
                    case 'ocr.get-running-state': return { isRunning: false };
                    case 'texthook.getStatus': return { running: false };
                    case 'texthook.listHooks': return { hooks: [], selectedHookId: null };
                    case 'texthook.getSettings': return { maxBufferSize: 3000, targetLanguage: 'ja' };
                    case 'python.getPythonInfo': return { success: true };
                    default: return null;
                }
            },
            on(channel, callback) {
                const callbacks = listeners.get(channel) || [];
                callbacks.push(callback);
                listeners.set(channel, callbacks);
                return () => listeners.set(channel, (listeners.get(channel) || []).filter(value => value !== callback));
            },
        });
        contextBridge.exposeInMainWorld('clipboard', { readText: () => '', writeText() {} });
        contextBridge.exposeInMainWorld('gsmEnv', { platform: 'win32' });
        contextBridge.exposeInMainWorld('__gsmBenchmark', { emit });
    `);

    app.whenReady().then(async () => {
        console.error('Loading isolated desktop renderer...');
        const win = new BrowserWindow({ show: false, width: 1280, height: 900,
            webPreferences: { preload, backgroundThrottling: false },
        });
        try {
            win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] },
                (_details, callback) => callback({ cancel: true }));
            await win.loadFile(path.join(renderer, 'index.html'));
            console.error('Preparing synthetic text workload...');
            await new Promise(resolve => setTimeout(resolve, 500));
            await win.webContents.executeJavaScript(`(() => {
                if (!document.querySelector('.texthook-output')) throw new Error('Desktop renderer failed to mount.');
                window.__gsmBenchmark.emit('texthook.status', {
                    running: true, engine: 'agent', pid: 1234, arch: 'x64', exeName: 'benchmark.exe',
                    sessionId: 'benchmark', agentPhase: 'receiving', selectedHookId: 'agent', hookCount: 1,
                });
                window.__benchmarkLine = i => {
                    const text = '今日は一緒に帰ろう。静かな夜の街を歩いていた。' + i;
                    const emit = window.__gsmBenchmark.emit;
                    emit('texthook.hooks', { selectedHookId: 'agent', hooks: [
                        { id: 'agent', function: 'Dialogue', preview: text, samples: [text] },
                    ] });
                    emit('texthook.text', { text, ts: i, hookId: 'agent', sessionId: 'benchmark' });
                    emit('texthook.log', { message: text, ts: i, level: 'info' });
                    emit('terminal-output', { message: text, level: 'TEXT_RECEIVED', source: 'python' });
                };
            })()`);
            // Fill the rolling history before measuring its steady-state behavior.
            await win.webContents.executeJavaScript(`(() => { for (let i = 0; i < 310; i++) window.__benchmarkLine(i); })()`);
            await new Promise(resolve => setTimeout(resolve, 100));
            win.webContents.debugger.attach('1.3');
            await win.webContents.debugger.sendCommand('Performance.enable');
            const metrics = async () => Object.fromEntries((await win.webContents.debugger.sendCommand('Performance.getMetrics'))
                .metrics.map(({ name, value }) => [name, value]));
            const before = await metrics();
            console.error('Measuring hidden-panel text workload...');
            const result = await win.webContents.executeJavaScript(`(async () => {
                let added = 0, removed = 0;
                const observer = new MutationObserver(records => {
                    for (const record of records) { added += record.addedNodes.length; removed += record.removedNodes.length; }
                });
                observer.observe(document.querySelector('#texthook-workspace'), { childList: true, subtree: true });
                const started = performance.now();
                for (let i = 0; i < ${lineCount}; i++) {
                    window.__benchmarkLine(i + 310);
                    await new Promise(resolve => setTimeout(resolve, 4));
                }
                observer.disconnect();
                return { elapsedMs: performance.now() - started, addedNodes: added, removedNodes: removed,
                    renderedHistoryRows: document.querySelectorAll('.texthook-output-line').length };
            })()`);
            const after = await metrics();
            console.log(JSON.stringify({ renderer, lineCount, scenario: 'Home tab open; Text Hook and Logs hidden', ...result,
                scriptMs: (after.ScriptDuration - before.ScriptDuration) * 1000,
                taskMs: (after.TaskDuration - before.TaskDuration) * 1000,
            }, null, 2));
        } finally {
            win.destroy();
            clearTimeout(deadline);
        }
        app.quit();
    }).catch(error => { console.error(error); app.exit(1); });
}
