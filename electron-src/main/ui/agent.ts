import frida, { MessageType, ScriptRuntime } from 'frida';
import type { LogLevel, Message, Script, Session } from 'frida';
import { BrowserWindow } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { exec } from 'node:child_process';
import { BASE_DIR, isWindows } from '../util.js';
import { mainWindow, sendTextHookLine } from '../main.js';
import type { StartHookResult, TextHookArchitecture } from './texthook.js';

interface AgentHookEntry {
    id: string;
    function: string;
    preview: string;
    samples: string[];
}

interface StartAgentHookOptions {
    pid: number;
    exeName: string;
    arch: TextHookArchitecture;
    scriptPath: string;
    flushDelayMs: number;
}

interface AgentTextPayload {
    text: string;
    hookId: string;
    hookFunction: string;
    engine: 'agent';
    exeName: string;
}

interface AgentHookSession {
    fridaSession: Session;
    script: Script;
    pid: number;
    exeName: string;
    arch: TextHookArchitecture;
    scriptPath: string;
    loaderPath: string;
    hook: AgentHookEntry;
    flushDelayMs: number;
    outputCollector: AgentTextPayload[];
    outputFlushTimer: NodeJS.Timeout | null;
    pidWatcher?: NodeJS.Timeout;
    localStorage: Map<string, string>;
    sessionStorage: Map<string, string>;
    uiHtml: string | null;
    uiFileName: string | null;
    uiWindow: BrowserWindow | null;
    stopping: boolean;
}

let agentSession: AgentHookSession | null = null;

const DEFAULT_AGENT_LOADER = path.resolve(process.cwd(), '.agent_scripts', 'libLoader.js');
const STORAGE_DIR = path.join(BASE_DIR, 'texthook', 'agent-storage');
const UI_DIR = path.join(BASE_DIR, 'texthook', 'agent-ui');

const FRIDA_COMPAT_SHIM = `
(function () {
  function defineCompat(target, name, value) {
    try {
      if (typeof target[name] !== 'function') {
        Object.defineProperty(target, name, { configurable: true, writable: true, value: value });
      }
    } catch (_) {
      try { target[name] = value; } catch (_) {}
    }
  }
  defineCompat(Process, 'findModuleByName', function (name) {
    try { return Process.getModuleByName(name); } catch (_) { return null; }
  });
  defineCompat(Process, 'findModuleByAddress', function (address) {
    try { return Process.getModuleByAddress(address); } catch (_) { return null; }
  });
  defineCompat(Module, 'findExportByName', function (moduleName, exportName) {
    try {
      if (moduleName === null) {
        if (typeof Module.findGlobalExportByName === 'function') {
          return Module.findGlobalExportByName(exportName);
        }
        const modules = Process.enumerateModules();
        for (let i = 0; i < modules.length; i++) {
          const found = modules[i].findExportByName(exportName);
          if (found !== null) return found;
        }
        return null;
      }
      const module = Process.findModuleByName(moduleName);
      return module !== null ? module.findExportByName(exportName) : null;
    } catch (_) {
      return null;
    }
  });
  defineCompat(Module, 'getExportByName', function (moduleName, exportName) {
    const address = Module.findExportByName(moduleName, exportName);
    if (address === null) throw new Error('Unable to find export ' + exportName);
    return address;
  });
})();
`;

function emitToRenderer(channel: string, payload: unknown): void {
    if (!mainWindow || mainWindow.isDestroyed()) {
        return;
    }
    try {
        mainWindow.webContents.send(channel, payload);
    } catch (err) {
        console.warn(`[AgentHook] Failed to send "${channel}" to renderer:`, err);
    }
}

function emitStatus(): void {
    emitToRenderer('texthook.status', getAgentHookRuntimeStatus() ?? { running: false });
}

function emitLog(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    emitToRenderer('texthook.log', { message, level, ts: Date.now() });
}

function emitHooks(): void {
    emitToRenderer('texthook.hooks', listAgentHooks());
}

function agentUiBridgeScript(): string {
    return `
<script>
(() => {
  const { ipcRenderer } = require("electron");
  const eventHandlers = new Map();

  ipcRenderer.on("agent-ui.rpc-event", (_event, payload) => {
    if (!payload || typeof payload.func !== "string" || !Array.isArray(payload.args)) {
      return;
    }
    const handlers = eventHandlers.get(payload.func) || [];
    for (const handler of handlers) {
      try {
        handler(...payload.args);
      } catch (error) {
        console.error(error);
      }
    }
  });

  window.rpc = {
    exports: new Proxy({}, {
      get(_target, property) {
        return (...args) => ipcRenderer.invoke("texthook.agentUiRpcCall", String(property), args);
      },
    }),
    on(name, handler) {
      const key = String(name);
      const handlers = eventHandlers.get(key) || [];
      handlers.push(handler);
      eventHandlers.set(key, handlers);
    },
    send(name, ...args) {
      return ipcRenderer.invoke("texthook.agentUiRpcSend", String(name), args);
    },
  };
})();
</script>`;
}

function injectAgentUiBridge(html: string): string {
    const bridge = agentUiBridgeScript();
    if (/<head(?:\s[^>]*)?>/i.test(html)) {
        return html.replace(/<head([^>]*)>/i, `<head$1>\n${bridge}`);
    }
    return `${bridge}\n${html}`;
}

function agentUiHtmlPath(current: AgentHookSession): string {
    const safeName = path
        .basename(current.scriptPath)
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .toLowerCase();
    return path.join(UI_DIR, `${safeName}.html`);
}

function writeAgentUiHtml(current: AgentHookSession): string | null {
    if (!current.uiHtml) return null;
    fs.mkdirSync(UI_DIR, { recursive: true });
    const filePath = agentUiHtmlPath(current);
    fs.writeFileSync(filePath, injectAgentUiBridge(current.uiHtml), 'utf8');
    return filePath;
}

function emitAgentUiEvent(current: AgentHookSession, func: string, args: unknown[]): void {
    const win = current.uiWindow;
    if (!win || win.isDestroyed()) return;
    win.webContents.send('agent-ui.rpc-event', { func, args });
}

async function loadAgentUiWindow(current: AgentHookSession): Promise<void> {
    const htmlPath = writeAgentUiHtml(current);
    if (!htmlPath) return;
    await current.uiWindow?.loadFile(htmlPath);
}

function closeAgentUiWindow(current: AgentHookSession): void {
    const win = current.uiWindow;
    current.uiWindow = null;
    if (!win || win.isDestroyed()) return;
    try {
        win.close();
    } catch {
        // Ignore close failures during teardown.
    }
}

function normalizeStorageValue(value: unknown): string {
    if (value === null || value === undefined) return '';
    return String(value);
}

function storageFileFor(scriptPath: string): string {
    const safeName = path
        .basename(scriptPath)
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .toLowerCase();
    return path.join(STORAGE_DIR, `${safeName}.json`);
}

function loadLocalStorage(scriptPath: string): Map<string, string> {
    try {
        const filePath = storageFileFor(scriptPath);
        if (!fs.existsSync(filePath)) return new Map();
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!parsed || typeof parsed !== 'object') return new Map();
        return new Map(
            Object.entries(parsed).map(([key, value]) => [key, normalizeStorageValue(value)]),
        );
    } catch {
        return new Map();
    }
}

function saveLocalStorage(current: AgentHookSession): void {
    try {
        fs.mkdirSync(STORAGE_DIR, { recursive: true });
        const filePath = storageFileFor(current.scriptPath);
        fs.writeFileSync(filePath, JSON.stringify(Object.fromEntries(current.localStorage), null, 2), 'utf8');
    } catch (err) {
        emitLog(`Failed to save Agent local storage: ${(err as Error).message}`, 'warn');
    }
}

function readAgentSource(loaderPath: string): string {
    const source = fs.readFileSync(loaderPath, 'utf8');
    return `${FRIDA_COMPAT_SHIM}\n${source}`;
}

function resolveScriptPath(scriptPath: string): string | null {
    const trimmed = scriptPath.trim();
    if (!trimmed) return null;
    const resolved = path.resolve(trimmed);
    if (!fs.existsSync(resolved)) return null;
    const stat = fs.statSync(resolved);
    return stat.isFile() ? resolved : null;
}

function resolveExistingLoader(scriptPath: string): string | null {
    const candidates = [
        path.join(path.dirname(scriptPath), 'libLoader.js'),
        DEFAULT_AGENT_LOADER,
    ];
    for (const candidate of candidates) {
        try {
            const resolved = path.resolve(candidate);
            if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
                return resolved;
            }
        } catch {
            // Try next candidate.
        }
    }
    return null;
}

function resolveAgentPath(requestedPath: string, basePath: string): string {
    if (path.isAbsolute(requestedPath)) return path.normalize(requestedPath);
    return path.normalize(path.resolve(basePath, requestedPath));
}

function resolveModulePath(requestedPath: string, basePath: string): string | null {
    const direct = resolveAgentPath(requestedPath, basePath);
    const candidates = [direct];
    if (!path.extname(direct)) {
        candidates.push(`${direct}.js`, `${direct}.json`);
    }
    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate)) return candidate;
        } catch {
            // Try next candidate.
        }
    }
    return null;
}

function statPath(requestedPath: string, basePath: string): { path: string; isFile: boolean; isDir: boolean; errno?: number } {
    const direct = resolveAgentPath(requestedPath, basePath);
    const candidates = [direct];
    if (!path.extname(direct)) candidates.push(`${direct}.js`, `${direct}.json`);
    for (const candidate of candidates) {
        try {
            const stat = fs.statSync(candidate);
            return {
                path: candidate,
                isFile: stat.isFile(),
                isDir: stat.isDirectory(),
            };
        } catch {
            // Try next candidate.
        }
    }
    return { path: direct, isFile: false, isDir: false, errno: -4058 };
}

function readFileForAgent(filePath: string, encoding: BufferEncoding | null, current: AgentHookSession): string | Buffer | null {
    const resolved = resolveModulePath(filePath, path.dirname(current.scriptPath));
    if (!resolved) return null;
    return encoding ? fs.readFileSync(resolved, encoding) : fs.readFileSync(resolved);
}

function replyToAgent(current: AgentHookSession, key: unknown, result: unknown, data?: Buffer | null): void {
    if (key === undefined || key === null) return;
    try {
        current.script.post({ type: key, result }, data ?? null);
    } catch (err) {
        emitLog(`Failed to reply to Agent script: ${(err as Error).message}`, 'warn');
    }
}

function runRemoteFunction(current: AgentHookSession, func: string, args: unknown[]): unknown {
    switch (func) {
        case '__mission':
            return current.scriptPath;
        case '__dirname':
            return path.dirname(current.scriptPath);
        case 'path_dirname':
            return typeof args[0] === 'string' ? path.dirname(args[0]) : '';
        case 'fs_realpathSync': {
            const requested = typeof args[0] === 'string' ? args[0] : '';
            const resolved = resolveModulePath(requested, path.dirname(current.scriptPath));
            return resolved ? fs.realpathSync(resolved) : null;
        }
        case 'fs_readFileSync': {
            const requested = typeof args[0] === 'string' ? args[0] : '';
            const encoding = typeof args[1] === 'string' ? args[1] as BufferEncoding : null;
            return readFileForAgent(requested, encoding, current);
        }
        case 'fs_writeFileSync': {
            if (typeof args[0] !== 'string') return false;
            const target = resolveAgentPath(args[0], path.dirname(current.scriptPath));
            const contents = args[1] === undefined || args[1] === null ? '' : String(args[1]);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, contents, typeof args[2] === 'string' ? args[2] as BufferEncoding : 'utf8');
            return true;
        }
        case '_statPath': {
            const requested = typeof args[0] === 'string' ? args[0] : '';
            const base = typeof args[1] === 'string' ? args[1] : path.dirname(current.scriptPath);
            return statPath(requested, base);
        }
        case 'evalJs':
            emitLog('Agent script requested evalJs; this embedded runner ignores UI eval requests.', 'warn');
            return null;
        default:
            emitLog(`Unhandled Agent host call: ${func}`, 'warn');
            return null;
    }
}

function handleStorageCommand(
    current: AgentHookSession,
    storage: Map<string, string>,
    cmd: string,
    args: unknown[],
): unknown {
    if (cmd.endsWith('_getItem')) {
        const key = normalizeStorageValue(args[0]);
        return storage.has(key) ? storage.get(key) : args[1] ?? null;
    }
    if (cmd.endsWith('_setItem')) {
        storage.set(normalizeStorageValue(args[0]), normalizeStorageValue(args[1]));
        if (cmd.startsWith('localStorage')) saveLocalStorage(current);
        return true;
    }
    if (cmd.endsWith('_removeItem')) {
        storage.delete(normalizeStorageValue(args[0]));
        if (cmd.startsWith('localStorage')) saveLocalStorage(current);
        return true;
    }
    if (cmd.endsWith('_clear')) {
        storage.clear();
        if (cmd.startsWith('localStorage')) saveLocalStorage(current);
        return true;
    }
    if (cmd.endsWith('_key')) {
        const index = Number(args[0]);
        return Number.isFinite(index) ? Array.from(storage.keys())[index] ?? null : null;
    }
    if (cmd.endsWith('_length')) {
        return storage.size;
    }
    if (cmd.endsWith('_keys')) {
        return Array.from(storage.keys());
    }
    return null;
}

function updateAgentHookPreview(text: string): void {
    if (!agentSession || !text.trim()) return;
    const hook = agentSession.hook;
    hook.preview = text.length > 80 ? `${text.slice(0, 80)}...` : text;
    if (hook.samples.length < 3) {
        hook.samples.push(text);
    }
    emitHooks();
}

function sendAgentText(payload: AgentTextPayload): void {
    sendTextHookLine(payload);
    emitToRenderer('texthook.text', {
        hookId: payload.hookId,
        text: payload.text,
        ts: Date.now(),
    });
}

function flushAgentText(): void {
    if (!agentSession) return;
    if (agentSession.outputFlushTimer) {
        clearTimeout(agentSession.outputFlushTimer);
        agentSession.outputFlushTimer = null;
    }
    if (agentSession.outputCollector.length === 0) return;
    const pending = agentSession.outputCollector;
    agentSession.outputCollector = [];
    const last = pending[pending.length - 1];
    const merged = {
        ...last,
        text: pending.map((item) => item.text).join('\n'),
    };
    updateAgentHookPreview(merged.text);
    sendAgentText(merged);
}

function queueAgentText(text: string): void {
    if (!agentSession || !text.trim()) return;
    const payload: AgentTextPayload = {
        text,
        hookId: agentSession.hook.id,
        hookFunction: agentSession.hook.function,
        engine: 'agent',
        exeName: agentSession.exeName,
    };
    const delayMs = Math.max(0, Math.round(agentSession.flushDelayMs));
    if (delayMs <= 0) {
        updateAgentHookPreview(text);
        sendAgentText(payload);
        return;
    }
    agentSession.outputCollector.push(payload);
    if (agentSession.outputFlushTimer) clearTimeout(agentSession.outputFlushTimer);
    agentSession.outputFlushTimer = setTimeout(flushAgentText, delayMs);
}

function handleAgentPayload(current: AgentHookSession, payload: any, data: Buffer | null): void {
    if (!payload || typeof payload !== 'object') return;
    const cmd = typeof payload.cmd === 'string' ? payload.cmd : '';
    const args = Array.isArray(payload.args) ? payload.args : [];
    try {
        if (cmd === 'copy') {
            const text = typeof payload.text === 'string' ? payload.text : '';
            queueAgentText(text);
            return;
        }
        if (cmd === 'detach') {
            void stopAgentHookSession();
            return;
        }
        if (cmd === 'eval') {
            const func = typeof payload.func === 'string' ? payload.func : '';
            replyToAgent(current, payload.key, runRemoteFunction(current, func, args));
            return;
        }
        if (cmd === 'writeBytes') {
            if (typeof payload.path === 'string' && data) {
                const target = resolveAgentPath(payload.path, path.dirname(current.scriptPath));
                fs.mkdirSync(path.dirname(target), { recursive: true });
                fs.writeFileSync(target, data);
                replyToAgent(current, payload.key, true);
            } else {
                replyToAgent(current, payload.key, false);
            }
            return;
        }
        if (cmd === 'prompt') {
            replyToAgent(current, payload.key, payload.default ?? '');
            return;
        }
        if (cmd === 'getScripts') {
            const dir = path.dirname(current.scriptPath);
            const scripts = fs
                .readdirSync(dir)
                .filter((name) => name.toLowerCase().endsWith('.js'))
                .map((name) => path.join(dir, name));
            replyToAgent(current, payload.key, scripts);
            return;
        }
        if (cmd.startsWith('localStorage_')) {
            replyToAgent(current, payload.key, handleStorageCommand(current, current.localStorage, cmd, args));
            return;
        }
        if (cmd.startsWith('sessionStorage_')) {
            replyToAgent(current, payload.key, handleStorageCommand(current, current.sessionStorage, cmd, args));
            return;
        }
        if (cmd === 'loadHtml') {
            current.uiHtml = typeof payload.text === 'string' ? payload.text : '';
            current.uiFileName = typeof payload.fileName === 'string' ? payload.fileName : null;
            emitStatus();
            if (current.uiWindow && !current.uiWindow.isDestroyed()) {
                void loadAgentUiWindow(current).catch((err) => {
                    emitLog(`Failed to refresh Agent script UI: ${(err as Error).message}`, 'warn');
                });
            }
            replyToAgent(current, payload.key, null, data);
            return;
        }
        if (cmd === 'rpc_send') {
            const func = typeof payload.func === 'string' ? payload.func : '';
            if (func) emitAgentUiEvent(current, func, args);
            replyToAgent(current, payload.key, null, data);
            return;
        }
        if (cmd === 'rpc_invoke' || cmd === 're_attach') {
            replyToAgent(current, payload.key, null, data);
            return;
        }
        if (cmd === 'setTargetID') {
            return;
        }
        emitLog(`Unhandled Agent message: ${cmd || JSON.stringify(payload)}`, 'warn');
        replyToAgent(current, payload.key, null);
    } catch (err) {
        emitLog(`Agent host message failed: ${(err as Error).message}`, 'error');
        replyToAgent(current, payload.key, null);
    }
}

function handleAgentMessage(current: AgentHookSession, message: Message, data: Buffer | null): void {
    if (message.type === MessageType.Send) {
        handleAgentPayload(current, message.payload, data);
        return;
    }
    const detail = message.stack || message.description;
    emitLog(detail, 'error');
}

function handleAgentLog(level: LogLevel, text: string): void {
    const normalized = String(level).toLowerCase();
    emitLog(`[Agent] ${text}`, normalized === 'error' ? 'error' : normalized === 'warning' ? 'warn' : 'info');
}

async function isPidAlive(pid: number): Promise<boolean> {
    if (pid <= 0) return false;
    if (isWindows()) {
        return new Promise((resolve) => {
            exec(
                `tasklist /FI "PID eq ${pid}" /FO CSV /NH`,
                { windowsHide: true, encoding: 'utf8' },
                (error, stdout) => {
                    if (error) {
                        resolve(false);
                        return;
                    }
                    const out = stdout.trim().toLowerCase();
                    resolve(out.length > 0 && !out.includes('no tasks are running') && out.includes(`"${pid}"`));
                },
            );
        });
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function teardownAgentSession(): Promise<void> {
    const current = agentSession;
    if (!current || current.stopping) return;
    current.stopping = true;
    flushAgentText();
    if (current.pidWatcher) {
        clearInterval(current.pidWatcher);
        current.pidWatcher = undefined;
    }
    if (current.outputFlushTimer) {
        clearTimeout(current.outputFlushTimer);
        current.outputFlushTimer = null;
    }
    closeAgentUiWindow(current);
    try {
        await current.script.unload();
    } catch {
        // Ignore unload failures during shutdown.
    }
    try {
        await current.fridaSession.detach();
    } catch {
        // Ignore detach failures during shutdown.
    }
    if (agentSession === current) {
        agentSession = null;
    }
    emitStatus();
    emitHooks();
}

export async function startAgentHookSession(options: StartAgentHookOptions): Promise<StartHookResult> {
    if (agentSession) {
        return { success: false, error: 'An Agent hook session is already running.' };
    }
    const scriptPath = resolveScriptPath(options.scriptPath);
    if (!scriptPath) {
        return { success: false, error: 'Select a valid Agent script before starting.' };
    }
    const loaderPath = resolveExistingLoader(scriptPath);
    if (!loaderPath) {
        return { success: false, error: 'Agent loader missing. Expected libLoader.js next to the script.' };
    }
    try {
        const fridaSession = await frida.attach(options.pid);
        const source = readAgentSource(loaderPath);
        const script = await fridaSession.createScript(source, {
            name: `GSM Agent: ${path.basename(scriptPath)}`,
            runtime: ScriptRuntime.V8,
        });
        const current: AgentHookSession = {
            fridaSession,
            script,
            pid: options.pid,
            exeName: options.exeName,
            arch: options.arch,
            scriptPath,
            loaderPath,
            hook: {
                id: 'agent',
                function: path.basename(scriptPath),
                preview: '',
                samples: [],
            },
            flushDelayMs: options.flushDelayMs,
            outputCollector: [],
            outputFlushTimer: null,
            localStorage: loadLocalStorage(scriptPath),
            sessionStorage: new Map(),
            uiHtml: null,
            uiFileName: null,
            uiWindow: null,
            stopping: false,
        };
        agentSession = current;
        script.logHandler = handleAgentLog;
        script.message.connect((message, data) => handleAgentMessage(current, message, data));
        fridaSession.detached.connect((reason, crash) => {
            const crashSummary = crash ? ` crash=${crash.summary}` : '';
            emitLog(`Agent Frida session detached: ${reason}${crashSummary}`, reason === 'application-requested' ? 'info' : 'warn');
            void teardownAgentSession();
        });
        await script.load();
        current.pidWatcher = setInterval(() => {
            void (async () => {
                if (!agentSession || agentSession !== current) return;
                if (!(await isPidAlive(current.pid))) {
                    emitLog(`Target PID ${current.pid} (${current.exeName}) is no longer running.`);
                    void stopAgentHookSession();
                }
            })();
        }, 4000);
        emitLog(`Attached Agent script ${path.basename(scriptPath)} to ${options.exeName} (PID ${options.pid}).`);
        emitStatus();
        emitHooks();
        return { success: true, pid: options.pid, exeName: options.exeName, arch: options.arch };
    } catch (err) {
        const error = err as Error;
        emitLog(`Agent attach failed: ${error.message}`, 'error');
        if (agentSession) {
            await teardownAgentSession();
        }
        return { success: false, error: error.message };
    }
}

export function stopAgentHookSession(): void {
    void teardownAgentSession();
}

export function isAgentHookRunning(): boolean {
    return agentSession !== null;
}

export function listAgentHooks(): { hooks: AgentHookEntry[]; selectedHookId: string | null } {
    if (!agentSession) return { hooks: [], selectedHookId: null };
    return {
        hooks: [agentSession.hook],
        selectedHookId: agentSession.hook.id,
    };
}

export function getAgentHookRuntimeStatus() {
    if (!agentSession) return null;
    return {
        running: true as const,
        engine: 'agent' as const,
        arch: agentSession.arch,
        pid: agentSession.pid,
        exeName: agentSession.exeName,
        selectedHookId: agentSession.hook.id,
        hookCount: 1,
        flushDelayMs: agentSession.flushDelayMs,
        agentScriptPath: agentSession.scriptPath,
        agentHasUi: agentSession.uiHtml !== null,
    };
}

export async function showAgentScriptUi(): Promise<{ success: boolean; error?: string }> {
    const current = agentSession;
    if (!current) {
        return { success: false, error: 'No active Agent hook session.' };
    }
    if (!current.uiHtml) {
        return { success: false, error: 'The active Agent script has not exposed a UI.' };
    }
    try {
        if (current.uiWindow && !current.uiWindow.isDestroyed()) {
            current.uiWindow.show();
            current.uiWindow.focus();
            return { success: true };
        }

        current.uiWindow = new BrowserWindow({
            width: 760,
            height: 720,
            title: `Agent UI - ${path.basename(current.scriptPath)}`,
            show: false,
            webPreferences: {
                contextIsolation: false,
                nodeIntegration: true,
                sandbox: false,
                devTools: true,
                backgroundThrottling: false,
            },
        });
        current.uiWindow.on('closed', () => {
            if (agentSession === current) {
                current.uiWindow = null;
            }
        });
        await loadAgentUiWindow(current);
        current.uiWindow.show();
        current.uiWindow.focus();
        return { success: true };
    } catch (err) {
        const message = (err as Error).message;
        emitLog(`Failed to open Agent script UI: ${message}`, 'error');
        return { success: false, error: message };
    }
}

export async function callAgentUiRpc(func: string, args: unknown[]): Promise<unknown> {
    const current = agentSession;
    if (!current) {
        throw new Error('No active Agent hook session.');
    }
    const exportsProxy = current.script.exports as Record<string, (...rpcArgs: unknown[]) => Promise<unknown>>;
    const method = exportsProxy[func];
    if (typeof method !== 'function') {
        throw new Error(`Agent UI RPC method "${func}" is not available.`);
    }
    return method(...args);
}

export function sendAgentUiRpc(func: string, args: unknown[]): { success: boolean; error?: string } {
    const current = agentSession;
    if (!current) {
        return { success: false, error: 'No active Agent hook session.' };
    }
    try {
        current.script.post({ type: func, args });
        return { success: true };
    } catch (err) {
        return { success: false, error: (err as Error).message };
    }
}

export function setAgentFlushDelayMs(value: number): { success: boolean; flushDelayMs?: number; error?: string } {
    if (!agentSession) return { success: false, error: 'No active Agent hook session.' };
    const next = Math.min(5000, Math.max(0, Math.round(value)));
    agentSession.flushDelayMs = next;
    if (next <= 0) {
        flushAgentText();
    } else if (agentSession.outputCollector.length > 0) {
        if (agentSession.outputFlushTimer) clearTimeout(agentSession.outputFlushTimer);
        agentSession.outputFlushTimer = setTimeout(flushAgentText, next);
    }
    emitStatus();
    return { success: true, flushDelayMs: next };
}
