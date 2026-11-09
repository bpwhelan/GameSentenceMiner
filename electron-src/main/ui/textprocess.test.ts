import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();
const ipcHandleMock = vi.fn();
const readFileMock = vi.fn();

vi.mock('fs', () => ({
    existsSync: () => true,
    readFileSync: readFileMock,
}));

vi.mock('electron', () => ({
    ipcMain: {
        handle: ipcHandleMock,
    },
}));

vi.mock('child_process', () => ({
    spawn: spawnMock,
}));

vi.mock('../main.js', () => ({
    sendReloadSettings: vi.fn(),
}));

vi.mock('../python/python_downloader.js', () => ({
    getOrInstallPython: vi.fn(async () => 'python.exe'),
}));

vi.mock('../services/latest_text.js', () => ({
    getLatestTextProcessingInput: vi.fn(),
}));

vi.mock('../util.js', () => ({
    BASE_DIR: 'C:\\test-gsm',
    getGSMBaseDir: () => 'C:\\repo',
    getSanitizedPythonEnv: () => ({ PATH: 'safe-path' }),
}));

function createPreviewProcess() {
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: vi.fn() };
    child.kill = vi.fn();
    return child;
}

describe('text processing preview IPC helpers', () => {
    beforeEach(() => {
        spawnMock.mockReset();
        ipcHandleMock.mockReset();
        readFileMock.mockReset().mockReturnValue('{}');
    });

    it('parses Python preview JSON after startup logging noise', async () => {
        const { parseTextProcessingPreviewOutput } = await import('./textprocess.js');

        expect(
            parseTextProcessingPreviewOutput(
                '2026-05-26 12:00:00 | MAIN       | BACKGROUND | Logging initialized\n{"result":"bar"}\n'
            )
        ).toBe('bar');
    });

    it('runs the Python text_processing module for previews', async () => {
        const child = createPreviewProcess();
        spawnMock.mockReturnValue(child);
        const { runTextProcessingPreview } = await import('./textprocess.js');
        const payload = {
            text: 'foo',
            config: {
                string_replacement: { enabled: true, rules: [] },
            },
        } as any;

        const preview = runTextProcessingPreview('C:\\Python\\python.exe', payload, 1000);

        expect(spawnMock).toHaveBeenCalledWith(
            'C:\\Python\\python.exe',
            ['-m', 'GameSentenceMiner.util.text_processing', '--preview-json'],
            expect.objectContaining({
                cwd: 'C:\\repo',
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
                env: expect.objectContaining({
                    GSM_ELECTRON: '1',
                    PATH: 'safe-path',
                }),
            })
        );
        expect(child.stdin.end).toHaveBeenCalledWith(JSON.stringify(payload), 'utf8');

        child.stdout.emit('data', Buffer.from('log line\n{"result":"bar"}\n'));
        child.emit('close', 0);

        await expect(preview).resolves.toBe('bar');
    });

    it('previews with the active profile target language, including profile changes', async () => {
        const { registerTextProcessIPC } = await import('./textprocess.js');
        registerTextProcessIPC();
        const handler = ipcHandleMock.mock.calls.find(([channel]) => channel === 'textprocess.preview')![1];

        for (const language of ['ko', 'ja']) {
            readFileMock.mockReturnValue(JSON.stringify({
                current_profile: 'Game',
                configs: { Game: { general: { target_language: language } } },
            }));
            const child = createPreviewProcess();
            spawnMock.mockReturnValue(child);
            const request = handler({}, {
                text: '日本語\n한국어',
                config: { language_filter: true, language_filter_config: { mode: 'blocks' } },
            });
            await Promise.resolve();
            const payload = JSON.parse(child.stdin.end.mock.calls[0][0]);
            expect(payload.target_language).toBe(language);
            expect(payload.config.language_filter_config.mode).toBe('blocks');
            child.stdout.emit('data', Buffer.from('{"result":"filtered"}\n'));
            child.emit('close', 0);
            await expect(request).resolves.toEqual({ success: true, result: 'filtered' });
        }
    });
});
