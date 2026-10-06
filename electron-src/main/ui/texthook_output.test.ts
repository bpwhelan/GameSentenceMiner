import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    spawn: vi.fn(),
    sendTextHookLine: vi.fn(),
    send: vi.fn(),
}));

vi.mock('child_process', () => ({ spawn: mocks.spawn, execFile: vi.fn(), exec: vi.fn() }));
vi.mock('node:fs', () => ({ existsSync: (filename: string) => filename.endsWith('.exe') }));
vi.mock('electron', () => ({ BrowserWindow: class {}, ipcMain: { handle: vi.fn() } }));
vi.mock('../util.js', () => ({
    BASE_DIR: 'C:\\test-gsm',
    getAssetsDir: () => 'C:\\test-gsm\\assets',
    isWindows: () => true,
    isLinux: () => false,
    sanitizeFilename: (value: string) => value,
}));
vi.mock('../main.js', () => ({
    mainWindow: { isDestroyed: () => false, webContents: { send: mocks.send } },
    sendTextHookLine: mocks.sendTextHookLine,
    sendTextHookStatus: vi.fn(),
}));
vi.mock('../store.js', () => ({}));
vi.mock('../gsm_config.js', () => ({}));
vi.mock('./obs.js', () => ({}));
vi.mock('./linux_wine.js', () => ({}));
vi.mock('./wine_frida.js', () => ({}));
vi.mock('./texthook_downloader.js', () => ({
    getTexthookRuntimeDir: () => 'C:\\test-gsm\\texthook',
    FORCE_TEXTHOOK_DOWNLOAD: false,
    isTexthookInstalled: () => true,
}));
vi.mock('./agent.js', () => ({
    getAgentHookRuntimeStatus: () => null,
    isAgentHookRunning: () => false,
    stopAgentHookSession: vi.fn(),
}));
vi.mock('./detached_agent_client.js', () => ({
    reconnectDetachedAgentHookSession: async () => false,
    getDetachedAgentHookRuntimeStatus: () => null,
    isDetachedAgentHookRunning: () => false,
}));
vi.mock('../engine_hooks/session.js', () => ({
    getEngineHookRuntimeStatus: () => null,
    isEngineHookRunning: () => false,
    stopEngineHookSession: vi.fn(),
}));
vi.mock('../engine_hooks/support.js', () => ({}));

type CliEngine = 'luna' | 'textractor';
type TextHookModule = typeof import('./texthook.js');

function createProcess() {
    return Object.assign(new EventEmitter(), {
        pid: 1234,
        killed: false,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        stdin: {
            write: vi.fn((_data: Buffer, callback: (error: Error | null) => void) => callback(null)),
        },
        kill: vi.fn(),
    });
}

function hookLine(engine: CliEngine, hookId: string, text: string): string {
    const context = engine === 'luna'
        ? `#${hookId}|0:ABCD:F0AB70:921:0:TextMeshPro:HS@0`
        : `${hookId}:ABCD:F0AB70:921:0:TextOutW:HS@0`;
    return `[${context}] ${text}\r\n`;
}

describe('selected CLI hook duplicate output', () => {
    let hook: TextHookModule;
    let proc: ReturnType<typeof createProcess>;
    let engine: CliEngine;
    const subtitle = '加拨赈灾粮饷的事该赶紧筹备了';

    function emitText(text: string, hookId = '43', repeats = 1): void {
        proc.stdout.emit('data', Buffer.from(hookLine(engine, hookId, text).repeat(repeats), 'utf16le'));
    }

    function outputTexts(): string[] {
        return mocks.sendTextHookLine.mock.calls.map(([payload]) => payload.text);
    }

    async function start(selectedEngine: CliEngine = 'luna', flushDelayMs = 0): Promise<void> {
        engine = selectedEngine;
        proc = createProcess();
        mocks.spawn.mockReturnValue(proc);
        expect(await hook.startHookSession({
            engine,
            exeName: 'sstx2.exe',
            sceneId: 'scene-1',
            pidOverride: 4567,
            archOverride: 'x64',
            flushDelayMs,
        })).toMatchObject({ success: true });
        emitText('candidate');
        expect(await hook.selectHook('43')).toBe(true);
        mocks.send.mockClear();
    }

    beforeEach(async () => {
        vi.useFakeTimers();
        vi.resetModules();
        vi.clearAllMocks();
        hook = await import('./texthook.js');
    });

    afterEach(() => {
        hook?.stopHookSession();
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it.each(['luna', 'textractor'] as const)('drops a burst of 1,000 identical %s events before forwarding', async (selectedEngine) => {
        await start(selectedEngine);

        emitText(subtitle, '43', 1_000);

        expect(outputTexts()).toEqual([subtitle]);
        expect(mocks.send.mock.calls.filter(([channel]) => channel === 'texthook.text')).toHaveLength(1);
    });

    it('keeps suppressing redraws across stdout chunks and long pauses', async () => {
        await start();
        emitText(subtitle);
        vi.setSystemTime(Date.now() + 60_000);
        emitText(subtitle, '43', 1_000);

        expect(outputTexts()).toEqual([subtitle]);
    });

    it('forwards changed text immediately and allows a previous line after another line', async () => {
        await start();
        emitText(subtitle, '43', 500);
        emitText('下一句', '43', 500);
        emitText(subtitle, '43', 500);

        expect(outputTexts()).toEqual([subtitle, '下一句', subtitle]);
    });

    it('preserves progressive text and repetition inside a single payload', async () => {
        await start();
        for (const text of ['你', '你好', '你好！', '哈哈哈哈']) emitText(text, '43', 20);

        expect(outputTexts()).toEqual(['你', '你好', '你好！', '哈哈哈哈']);
    });

    it('does not let output from unselected hooks reset duplicate suppression', async () => {
        await start();
        emitText(subtitle);
        emitText('other hook', '44', 500);
        emitText(subtitle, '43', 500);

        expect(outputTexts()).toEqual([subtitle]);
    });

    it('forwards the first line again when another hook is selected or reselected', async () => {
        await start();
        emitText(subtitle);
        emitText(subtitle, '44');
        expect(await hook.selectHook('44')).toBe(true);
        emitText(subtitle, '44', 500);
        expect(await hook.selectHook('43')).toBe(true);
        emitText(subtitle, '43', 500);
        expect(await hook.selectHook('43')).toBe(true);
        emitText(subtitle, '43', 500);

        expect(outputTexts()).toEqual([subtitle, subtitle, subtitle, subtitle]);
    });

    it('does not carry duplicate state into a new session', async () => {
        await start();
        emitText(subtitle, '43', 500);
        hook.stopHookSession();
        await start();
        emitText(subtitle, '43', 500);

        expect(outputTexts()).toEqual([subtitle, subtitle]);
    });

    it('filters duplicates after erasing hook noise without accepting blocked text', async () => {
        await start();
        emitText(subtitle);
        emitText(`${subtitle}%D$vl123;`, '43', 500);
        emitText('「text」'.repeat(11));
        emitText(subtitle);

        expect(outputTexts()).toEqual([subtitle]);
    });

    it('keeps debounced previews from accumulating repeated copies of the selected line', async () => {
        await start('luna', 100);
        await vi.advanceTimersByTimeAsync(100);
        emitText(subtitle, '43', 1_000);
        await vi.advanceTimersByTimeAsync(100);

        const previews = mocks.send.mock.calls.filter(([channel]) => channel === 'texthook.hooks');
        const entry = previews.at(-1)![1].hooks.find((item: { id: string }) => item.id === '43');
        expect(entry.preview).toBe(subtitle);
        expect(entry.samples).toEqual(['candidate', subtitle]);
    });
});
