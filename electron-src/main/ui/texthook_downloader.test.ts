import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
const nodeFetchMock = vi.fn();
const sendMock = vi.fn();
let baseDir: string;
const { default: snapshot } = await vi.importActual<typeof import('./texthook_fallback_manifest.js')>(
    './texthook_fallback_manifest.js',
);
const primaryBase = 'https://r2.gamesentenceminer.com/texthook';
const fallbackBase = `https://raw.githubusercontent.com/bpwhelan/GameSentenceMiner/${snapshot.revision}/electron-src/assets/texthook`;
const fileContents = (file: string, fallback = false) =>
    `${file === 'NOTICE.md' && fallback ? 'GitHub notice' : 'R2 fixture'}: ${file}`;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const manifest = {
    version: snapshot.version,
    files: snapshot.files.map(({ path: file }) => ({ path: file, sha256: hash(fileContents(file)) })),
};
const fallbackManifest = {
    ...snapshot,
    files: snapshot.files.map(({ path: file }) => ({ path: file, sha256: hash(fileContents(file, true)) })),
};

vi.mock('electron', () => ({ net: { fetch: fetchMock } }));
vi.mock('../util.js', () => ({ get BASE_DIR() { return baseDir; } }));
vi.mock('../main.js', () => ({ mainWindow: { webContents: { send: sendMock } } }));
vi.mock('./texthook_fallback_manifest.js', () => ({ default: fallbackManifest }));

function respond(url: string): Response {
    if (url === `${primaryBase}/texthook_manifest.json`) return Response.json(manifest);
    const fallback = url.startsWith(fallbackBase);
    const prefix = fallback ? fallbackBase : primaryBase;
    const file = url.slice(prefix.length + 1);
    if (!manifest.files.some((entry) => entry.path === file)) throw new Error(`Unexpected URL: ${url}`);
    return new Response(fileContents(file, fallback));
}

function installLocal(version = manifest.version): void {
    for (const entry of manifest.files) {
        const dest = path.join(baseDir, 'texthook', entry.path);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, fileContents(entry.path));
    }
    fs.writeFileSync(path.join(baseDir, 'texthook/texthook_manifest.json'), JSON.stringify({ ...manifest, version }));
}

beforeEach(() => {
    vi.resetModules();
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-texthook-download-'));
    fetchMock.mockReset().mockImplementation(async (url: string) => respond(url));
    nodeFetchMock.mockReset().mockRejectedValue(new Error('Node fetch must not be used'));
    vi.stubGlobal('fetch', nodeFetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    // Only remove the isolated directory allocated by this test.
    if (path.dirname(baseDir) !== path.resolve(os.tmpdir()) || !path.basename(baseDir).startsWith('gsm-texthook-download-')) {
        throw new Error(`Unexpected test directory: ${baseDir}`);
    }
    fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('texthook engine downloads', () => {
    it('uses Electron networking, verifies files and saves the completed manifest', async () => {
        const { downloadTexthookEngines, isTexthookInstalled } = await import('./texthook_downloader.js');
        const progress = vi.fn();
        await downloadTexthookEngines(progress);

        expect(isTexthookInstalled()).toBe(true);
        expect(nodeFetchMock).not.toHaveBeenCalled();
        expect(fetchMock).toHaveBeenCalledTimes(manifest.files.length + 1);
        expect(progress).toHaveBeenCalled();
        expect(JSON.parse(fs.readFileSync(path.join(baseDir, 'texthook/texthook_manifest.json'), 'utf8'))).toEqual(manifest);
        expect(fetchMock.mock.calls.every(([, init]) => init.signal instanceof AbortSignal)).toBe(true);
    });

    it('installs from the bundled manifest and pinned GitHub files when R2 is blocked', async () => {
        fetchMock.mockImplementation(async (url: string) => {
            if (url.startsWith(primaryBase)) throw new Error('net::ERR_NAME_NOT_RESOLVED');
            return respond(url);
        });
        const { downloadTexthookEngines, isTexthookInstalled } = await import('./texthook_downloader.js');
        await downloadTexthookEngines();

        expect(isTexthookInstalled()).toBe(true);
        expect(fs.readFileSync(path.join(baseDir, 'texthook/NOTICE.md'), 'utf8')).toBe(fileContents('NOTICE.md', true));
        expect(fetchMock.mock.calls.filter(([url]) => url.startsWith(fallbackBase))).toHaveLength(manifest.files.length);
        expect(fetchMock.mock.calls.filter(([url]) => url.startsWith(primaryBase))).toHaveLength(2);
    });

    it('retries a transient manifest failure before switching hosts', async () => {
        fetchMock.mockResolvedValueOnce(new Response('Unavailable', { status: 503 }));
        const { downloadTexthookEngines } = await import('./texthook_downloader.js');
        await downloadTexthookEngines();
        expect(fetchMock.mock.calls.every(([url]) => url.startsWith(primaryBase))).toBe(true);
        expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('.json'))).toHaveLength(2);
    });

    it('retries an interrupted file stream without keeping partial bytes', async () => {
        const entry = manifest.files[0];
        let interrupted = false;
        fetchMock.mockImplementation(async (url: string) => {
            if (url === `${primaryBase}/${entry.path}` && !interrupted) {
                interrupted = true;
                let sentChunk = false;
                return new Response(new ReadableStream({
                    pull(controller) {
                        if (sentChunk) controller.error(new Error('Connection reset during download'));
                        else {
                            controller.enqueue(new TextEncoder().encode('incomplete file'));
                            sentChunk = true;
                        }
                    },
                }));
            }
            return respond(url);
        });
        const { downloadTexthookEngines } = await import('./texthook_downloader.js');
        await downloadTexthookEngines();
        expect(fetchMock.mock.calls.filter(([url]) => url === `${primaryBase}/${entry.path}`)).toHaveLength(2);
        expect(fs.readFileSync(path.join(baseDir, 'texthook', entry.path), 'utf8')).toBe(fileContents(entry.path));
        expect(fs.existsSync(path.join(baseDir, 'texthook', `${entry.path}.download`))).toBe(false);
    });

    it('reuses verified files and downloads only a missing engine file', async () => {
        installLocal();
        const entry = manifest.files[2];
        fs.unlinkSync(path.join(baseDir, 'texthook', entry.path));
        const { downloadTexthookEngines, isTexthookInstalled } = await import('./texthook_downloader.js');
        await downloadTexthookEngines();
        expect(isTexthookInstalled()).toBe(true);
        expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
            `${primaryBase}/texthook_manifest.json`, `${primaryBase}/${entry.path}`,
        ]);
    });

    it('switches the complete manifest when an R2 binary is unavailable', async () => {
        const brokenFile = manifest.files[2].path;
        fetchMock.mockImplementation(async (url: string) => {
            if (url === `${primaryBase}/${brokenFile}`) return new Response('Forbidden', { status: 403 });
            return respond(url);
        });
        const { downloadTexthookEngines } = await import('./texthook_downloader.js');
        await downloadTexthookEngines();
        const saved = JSON.parse(fs.readFileSync(path.join(baseDir, 'texthook/texthook_manifest.json'), 'utf8'));
        expect(saved.files).toEqual(fallbackManifest.files);
        expect(fs.readFileSync(path.join(baseDir, 'texthook/NOTICE.md'), 'utf8')).toBe(fileContents('NOTICE.md', true));
    });

    it('reports the failed URLs and underlying errors when both hosts fail', async () => {
        fetchMock.mockImplementation(async (url: string) => {
            if (url.startsWith(primaryBase)) throw new Error('net::ERR_NAME_NOT_RESOLVED');
            return new Response('Forbidden', { status: 403 });
        });
        const { downloadTexthookEngines } = await import('./texthook_downloader.js');
        const error = await downloadTexthookEngines().catch((err: Error) => err);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('r2.gamesentenceminer.com');
        expect((error as Error).message).toContain('ERR_NAME_NOT_RESOLVED');
        expect((error as Error).message).toContain('raw.githubusercontent.com');
        expect((error as Error).message).toContain('HTTP 403');
        expect(fs.existsSync(path.join(baseDir, 'texthook/texthook_manifest.json'))).toBe(false);
    });

    it('rejects corrupt downloads and preserves an existing file', async () => {
        const entry = manifest.files[0];
        fs.mkdirSync(path.join(baseDir, 'texthook'), { recursive: true });
        fs.writeFileSync(path.join(baseDir, 'texthook', entry.path), 'previous valid install');
        fetchMock.mockImplementation(async (url: string) =>
            url.endsWith('.json') ? Response.json(manifest) : new Response('corrupted download'),
        );
        const { downloadTexthookEngines } = await import('./texthook_downloader.js');
        await expect(downloadTexthookEngines()).rejects.toThrow(/hash mismatch/);
        expect(fs.readFileSync(path.join(baseDir, 'texthook', entry.path), 'utf8')).toBe('previous valid install');
        expect(fs.existsSync(path.join(baseDir, 'texthook', `${entry.path}.download`))).toBe(false);
    });

    it('times out a stalled manifest request and retries', async () => {
        vi.useFakeTimers();
        let signal: AbortSignal | undefined;
        fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => {
            signal = init.signal as AbortSignal;
            return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason)));
        });
        const { getEngineStatus } = await import('./texthook_downloader.js');
        const statusPromise = getEngineStatus();
        await vi.advanceTimersByTimeAsync(30_000);
        expect(signal?.aborted).toBe(true);
        expect((await statusPromise).remoteVersion).toBe(manifest.version);
    });

    it('keeps installed engines usable and reports no update when R2 is offline', async () => {
        installLocal('2.0.0');
        fetchMock.mockRejectedValue(new Error('net::ERR_INTERNET_DISCONNECTED'));
        const { getEngineStatus, checkForTexthookUpdates } = await import('./texthook_downloader.js');
        expect(await getEngineStatus()).toEqual({ installed: true, version: '2.0.0', remoteVersion: null, updateAvailable: false });
        await checkForTexthookUpdates();
        expect(sendMock).not.toHaveBeenCalled();
    });

    it('does not downgrade a newer installation to the bundled fallback', async () => {
        installLocal('2.0.0');
        fetchMock.mockRejectedValue(new Error('net::ERR_NAME_NOT_RESOLVED'));
        const { downloadTexthookEngines } = await import('./texthook_downloader.js');
        await expect(downloadTexthookEngines()).rejects.toThrow(/fallback.*1\.0\.0.*2\.0\.0/i);
        expect(fetchMock.mock.calls.every(([url]) => url.startsWith(primaryBase))).toBe(true);
    });

    it('rejects unsafe manifest paths before writing outside the download directory', async () => {
        fetchMock.mockImplementation(async (url: string) => {
            if (url.endsWith('.json')) return Response.json({ ...manifest, files: [{ path: '../escaped.dll', sha256: hash('bad') }] });
            return respond(url);
        });
        const { downloadTexthookEngines } = await import('./texthook_downloader.js');
        await downloadTexthookEngines();
        expect(fs.existsSync(path.join(baseDir, 'escaped.dll'))).toBe(false);
        expect(fetchMock.mock.calls.some(([url]) => url.startsWith(fallbackBase))).toBe(true);
    });
});
