import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import archiver from 'archiver';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
const nodeFetchMock = vi.fn();
let baseDir: string;
let zipBytes: Buffer;
const primaryBase = 'https://r2.gamesentenceminer.com/texthook/zip';
const fileContents = (file: string) => `R2 fixture: ${file}`;
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const runtimeFiles = [
    'NOTICE.md',
    ...[32, 64].flatMap(bits => [`luna_builds/LunaHook${bits}.dll`, `luna_builds/LunaHost${bits}.dll`, `luna_builds/LunaHostCLI${bits}.exe`]),
    'luna_builds/LunaTmpFontLoader.dll',
    ...['_x64', '_x86'].flatMap(arch => ['LoaderDll.dll', 'LocaleEmulator.dll', 'TextractorCLI.exe', 'texthook.dll'].map(file => `textractor_builds/${arch}/${file}`)),
];
const manifest = {
    version: '1.0.2',
    archive: { path: 'texthook.zip', sha256: '' },
    files: runtimeFiles.map(file => ({ path: file, sha256: hash(fileContents(file)) })),
};

vi.mock('electron', () => ({ net: { fetch: fetchMock } }));
vi.mock('../util.js', () => ({ get BASE_DIR() { return baseDir; } }));

async function makeZip(entries = runtimeFiles.map(file => [file, fileContents(file)]), symlink = false): Promise<Buffer> {
    const archive = archiver('zip');
    const chunks: Buffer[] = [];
    const result = new Promise<Buffer>((resolve, reject) => {
        archive.on('data', chunk => chunks.push(chunk));
        archive.on('end', () => resolve(Buffer.concat(chunks)));
        archive.on('error', reject);
    });
    for (const [name, content] of entries) archive.append(content, { name });
    if (symlink) archive.symlink('luna_builds/link.dll', '../../outside.dll');
    await archive.finalize();
    return result;
}

function respond(url: string): Response {
    if (url === `${primaryBase}/texthook_manifest.json`) return Response.json(manifest);
    if (url === `${primaryBase}/texthook.zip`) return new Response(new Uint8Array(zipBytes), { headers: { 'content-length': String(zipBytes.length) } });
    throw new Error(`Unexpected URL: ${url}`);
}

function installLocal(version = manifest.version): void {
    for (const entry of manifest.files) {
        const dest = path.join(baseDir, 'texthook', entry.path);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, fileContents(entry.path));
    }
    // Legacy installations have a file manifest with no archive metadata.
    fs.writeFileSync(path.join(baseDir, 'texthook/texthook_manifest.json'), JSON.stringify({ version, files: manifest.files }));
}

async function readInstalledFile(file: string): Promise<string> {
    const { getTexthookRuntimeDir } = await import('./texthook_downloader.js');
    return fs.readFileSync(path.join(getTexthookRuntimeDir(), file), 'utf8');
}

beforeEach(async () => {
    vi.resetModules();
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-texthook-download-'));
    zipBytes = await makeZip();
    manifest.archive.sha256 = hash(zipBytes);
    fetchMock.mockReset().mockImplementation(async (url: string) => respond(url));
    nodeFetchMock.mockReset().mockRejectedValue(new Error('Node fetch must not be used'));
    vi.stubGlobal('fetch', nodeFetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (path.dirname(baseDir) !== path.resolve(os.tmpdir()) || !path.basename(baseDir).startsWith('gsm-texthook-download-')) {
        throw new Error(`Unexpected test directory: ${baseDir}`);
    }
    fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('texthook ZIP downloads', () => {
    it('downloads only the manifest and ZIP using Electron, verifies and installs every file', async () => {
        const { downloadTexthookEngines, isTexthookInstalled, getTexthookRuntimeDir } = await import('./texthook_downloader.js');
        const progress = vi.fn();
        await downloadTexthookEngines(progress);
        expect(isTexthookInstalled()).toBe(true);
        expect(nodeFetchMock).not.toHaveBeenCalled();
        expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
            `${primaryBase}/texthook_manifest.json`, `${primaryBase}/texthook.zip`,
        ]);
        expect(progress).toHaveBeenLastCalledWith({ file: 'texthook.zip', fileIndex: 0, totalFiles: 1, bytesDownloaded: zipBytes.length, bytesTotal: zipBytes.length });
        expect(JSON.parse(fs.readFileSync(path.join(baseDir, 'texthook/texthook_manifest.json'), 'utf8'))).toMatchObject(manifest);
        expect(fetchMock.mock.calls.every(([, init]) => init.signal instanceof AbortSignal)).toBe(true);
        for (const entry of manifest.files) expect(await readInstalledFile(entry.path)).toBe(fileContents(entry.path));
        expect(fs.existsSync(path.join(getTexthookRuntimeDir(), 'texthook.zip'))).toBe(false);
    });

    it('rejects a ZIP hash mismatch before extraction and preserves the old installation', async () => {
        installLocal();
        const oldManifest = fs.readFileSync(path.join(baseDir, 'texthook/texthook_manifest.json'), 'utf8');
        zipBytes = Buffer.from('corrupt archive');
        const { downloadTexthookEngines } = await import('./texthook_downloader.js');
        await expect(downloadTexthookEngines()).rejects.toThrow(/hash mismatch/);
        for (const entry of manifest.files) expect(await readInstalledFile(entry.path)).toBe(fileContents(entry.path));
        expect(fs.readFileSync(path.join(baseDir, 'texthook/texthook_manifest.json'), 'utf8')).toBe(oldManifest);
        expect(fs.readdirSync(path.join(baseDir, 'texthook/packages'))).toEqual([]);
    });

    it.each(['corrupt', 'missing', 'extra', 'symlink', 'invalid zip'])('rejects %s archive contents even with a matching ZIP hash', async (kind) => {
        installLocal();
        let entries = runtimeFiles.map(file => [file, fileContents(file)]);
        if (kind === 'corrupt') entries[1][1] = 'corrupted engine';
        if (kind === 'missing') entries = entries.slice(1);
        if (kind === 'extra') entries.push(['profiles.json', 'overwrite']);
        zipBytes = kind === 'invalid zip' ? Buffer.from('not a zip') : await makeZip(entries, kind === 'symlink');
        manifest.archive.sha256 = hash(zipBytes);
        const { downloadTexthookEngines, getTexthookRuntimeDir } = await import('./texthook_downloader.js');
        await expect(downloadTexthookEngines()).rejects.toThrow();
        expect(getTexthookRuntimeDir()).toBe(path.join(baseDir, 'texthook'));
        expect(await readInstalledFile(runtimeFiles[1])).toBe(fileContents(runtimeFiles[1]));
        expect(fs.readdirSync(path.join(baseDir, 'texthook/packages'))).toEqual([]);
        expect(fs.existsSync(path.join(baseDir, 'outside.dll'))).toBe(false);
    });

    it.each([
        undefined,
        { path: '../escaped.zip', sha256: 'a'.repeat(64) },
        { path: 'texthook.zip', sha256: 'invalid' },
    ])('rejects missing or unsafe archive metadata without fetching binaries', async (archive) => {
        fetchMock.mockImplementation(async () => Response.json({ ...manifest, archive }));
        const { downloadTexthookEngines } = await import('./texthook_downloader.js');
        await expect(downloadTexthookEngines()).rejects.toThrow(/archive/i);
        expect(fetchMock.mock.calls.every(([url]) => url.endsWith('.json'))).toBe(true);
        expect(fs.existsSync(path.join(baseDir, 'escaped.zip'))).toBe(false);
    });

    it('does not offer or download an older published version', async () => {
        installLocal('2.0.0');
        const { getEngineStatus, downloadTexthookEngines } = await import('./texthook_downloader.js');
        expect((await getEngineStatus()).updateAvailable).toBe(false);
        await expect(downloadTexthookEngines()).rejects.toThrow(/downgrade/i);
        expect(fetchMock.mock.calls.every(([url]) => url.endsWith('.json'))).toBe(true);
    });

    it('retries a transient manifest failure', async () => {
        fetchMock.mockResolvedValueOnce(new Response('Unavailable', { status: 503 }));
        const { downloadTexthookEngines } = await import('./texthook_downloader.js');
        await downloadTexthookEngines();
        expect(fetchMock.mock.calls.every(([url]) => url.startsWith(primaryBase))).toBe(true);
        expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('.json'))).toHaveLength(2);
    });

    it('retries an interrupted ZIP stream without keeping partial bytes', async () => {
        let interrupted = false;
        fetchMock.mockImplementation(async (url: string) => {
            if (url.endsWith('.zip') && !interrupted) {
                interrupted = true;
                let sentChunk = false;
                return new Response(new ReadableStream({
                    pull(controller) {
                        if (sentChunk) controller.error(new Error('Connection reset during download'));
                        else {
                            controller.enqueue(new TextEncoder().encode('incomplete zip'));
                            sentChunk = true;
                        }
                    },
                }));
            }
            return respond(url);
        });
        const { downloadTexthookEngines, getTexthookRuntimeDir } = await import('./texthook_downloader.js');
        await downloadTexthookEngines();
        expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('.zip'))).toHaveLength(2);
        expect(await readInstalledFile(runtimeFiles[1])).toBe(fileContents(runtimeFiles[1]));
        expect(fs.existsSync(path.join(getTexthookRuntimeDir(), 'texthook.zip.download'))).toBe(false);
    });

    it('repairs a missing engine by downloading the complete ZIP', async () => {
        installLocal();
        fs.unlinkSync(path.join(baseDir, 'texthook', runtimeFiles[2]));
        const { downloadTexthookEngines, isTexthookInstalled } = await import('./texthook_downloader.js');
        await downloadTexthookEngines();
        expect(isTexthookInstalled()).toBe(true);
        expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
            `${primaryBase}/texthook_manifest.json`, `${primaryBase}/texthook.zip`,
        ]);
    });

    it('reports a blocked ZIP URL without falling back to loose DLL or EXE downloads', async () => {
        fetchMock.mockImplementation(async (url: string) => url.endsWith('.zip') ? new Response('Forbidden', { status: 403 }) : respond(url));
        const { downloadTexthookEngines } = await import('./texthook_downloader.js');
        await expect(downloadTexthookEngines()).rejects.toThrow(/texthook\/zip\/texthook.zip.*HTTP 403/);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fs.existsSync(path.join(baseDir, 'texthook/texthook_manifest.json'))).toBe(false);
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

    it('keeps legacy engines usable when R2 is offline', async () => {
        installLocal('2.0.0');
        fetchMock.mockRejectedValue(new Error('net::ERR_INTERNET_DISCONNECTED'));
        const { getEngineStatus, downloadTexthookEngines } = await import('./texthook_downloader.js');
        expect(await getEngineStatus()).toEqual({ installed: true, version: '2.0.0', remoteVersion: null, updateAvailable: false });
        await expect(downloadTexthookEngines()).rejects.toThrow(/ERR_INTERNET_DISCONNECTED/);
        expect(fetchMock.mock.calls.every(([url]) => url.startsWith(primaryBase))).toBe(true);
    });

    it('rejects unsafe manifest paths before writing outside the download directory', async () => {
        fetchMock.mockImplementation(async () => Response.json({ ...manifest, files: [{ path: '../escaped.dll', sha256: hash('bad') }] }));
        const { downloadTexthookEngines } = await import('./texthook_downloader.js');
        await expect(downloadTexthookEngines()).rejects.toThrow(/unsafe path/);
        expect(fs.existsSync(path.join(baseDir, 'escaped.dll'))).toBe(false);
        expect(fetchMock.mock.calls.every(([url]) => url.endsWith('.json'))).toBe(true);
    });

    it('keeps a verified download separate until activation and rechecks it after waiting', async () => {
        installLocal();
        const { prepareTexthookUpdate, activateTexthookUpdate, getTexthookRuntimeDir } = await import('./texthook_downloader.js');
        const oldDirectory = getTexthookRuntimeDir();
        const prepared = await prepareTexthookUpdate();
        expect(getTexthookRuntimeDir()).toBe(oldDirectory);
        fs.writeFileSync(path.join(prepared.directory, manifest.files[1].path), 'changed after verification');
        await expect(activateTexthookUpdate(prepared)).rejects.toThrow(/hash mismatch/);
        expect(getTexthookRuntimeDir()).toBe(oldDirectory);
        expect(await readInstalledFile(manifest.files[1].path)).toBe(fileContents(manifest.files[1].path));
    });

    it('preserves the old package and profiles if the final manifest switch fails', async () => {
        installLocal();
        const profilesPath = path.join(baseDir, 'texthook/profiles.json');
        fs.writeFileSync(profilesPath, '{"game": "saved hook"}');
        const manifestPath = path.join(baseDir, 'texthook/texthook_manifest.json');
        const originalManifest = fs.readFileSync(manifestPath, 'utf8');
        const { prepareTexthookUpdate, activateTexthookUpdate, getTexthookRuntimeDir } = await import('./texthook_downloader.js');
        const prepared = await prepareTexthookUpdate();
        const rename = fs.promises.rename;
        vi.spyOn(fs.promises, 'rename').mockImplementation(async (source, target) => {
            if (target === manifestPath) throw new Error('EPERM: manifest locked');
            return rename(source, target);
        });
        await expect(activateTexthookUpdate(prepared)).rejects.toThrow(/manifest locked/);
        expect(getTexthookRuntimeDir()).toBe(path.join(baseDir, 'texthook'));
        expect(fs.readFileSync(manifestPath, 'utf8')).toBe(originalManifest);
        expect(fs.readFileSync(profilesPath, 'utf8')).toBe('{"game": "saved hook"}');
    });

    it('switches the complete package and keeps the previous generation intact', async () => {
        const { downloadTexthookEngines, getTexthookRuntimeDir } = await import('./texthook_downloader.js');
        await downloadTexthookEngines();
        const oldDirectory = getTexthookRuntimeDir();
        await downloadTexthookEngines();
        expect(getTexthookRuntimeDir()).not.toBe(oldDirectory);
        for (const entry of manifest.files) {
            expect(fs.readFileSync(path.join(oldDirectory, entry.path), 'utf8')).toBe(fileContents(entry.path));
            expect(await readInstalledFile(entry.path)).toBe(fileContents(entry.path));
        }
    });

    it('never lets a remote manifest write over profiles or the package pointer', async () => {
        installLocal();
        fetchMock.mockImplementation(async () => Response.json({
            ...manifest, version: '3.0.0',
            files: [...manifest.files, { path: 'profiles.json', sha256: hash('overwrite') }],
        }));
        const { downloadTexthookEngines } = await import('./texthook_downloader.js');
        await expect(downloadTexthookEngines()).rejects.toThrow(/unsafe path/);
        expect(fetchMock.mock.calls.every(([url]) => url.endsWith('.json'))).toBe(true);
    });
});
