import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import extract from 'extract-zip';
import { prepareLunaHookUpdate } from './prepare-lunahook-update.mjs';

function fixture(t) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'gsm-lunahook-package-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const repo = path.join(root, 'gsm');
    const artifacts = path.join(root, 'artifacts');
    const output = path.join(root, 'candidate');
    const write = (filename, data) => {
        mkdirSync(path.dirname(filename), { recursive: true });
        writeFileSync(filename, data);
    };
    const files = ['NOTICE.md'];
    for (const arch of ['_x86', '_x64']) {
        for (const name of ['LoaderDll.dll', 'LocaleEmulator.dll', 'texthook.dll', 'TextractorCLI.exe']) {
            files.push(`textractor_builds/${arch}/${name}`);
        }
    }
    for (const name of files) write(path.join(repo, 'electron-src/assets/texthook', name), `original ${name}\r\n`);
    write(path.join(repo, 'texthook_manifest.json'), JSON.stringify({ version: '1.0.0', files: files.map(path => ({ path })) }));
    for (const bits of [32, 64]) {
        const dir = path.join(artifacts, `gsm-lunahook-${bits}`);
        write(path.join(dir, `provenance-${bits}.json`), JSON.stringify({
            sourceRepository: 'bpwhelan/LunaTranslator', sourceRevision: 'a'.repeat(40),
            version: '10.17.1.12', arch: bits === 32 ? 'Win32' : 'x64',
            minhook: 'b'.repeat(40), uchardet: 'c'.repeat(40),
        }));
        for (const name of [`LunaHook${bits}.dll`, `LunaHost${bits}.dll`, `LunaHostCLI${bits}.exe`]) {
            const pe = Buffer.alloc(256);
            pe.write('MZ'); pe.writeUInt32LE(128, 0x3c);
            pe.write('PE\0\0', 128); pe.writeUInt16LE(bits === 32 ? 0x14c : 0x8664, 132);
            write(path.join(dir, 'luna_builds', name), pe);
        }
        write(path.join(dir, 'luna_builds/LunaTmpFontLoader.dll'), 'shared font helper');
    }
    return { repo, artifacts, output, version: '1.0.1', root };
}

test('stages both architectures and a verified ZIP, preserving Textractor bytes', async (t) => {
    const options = fixture(t);
    const result = await prepareLunaHookUpdate(options);
    const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8'));
    assert.equal(manifest.version, '1.0.1');
    assert.equal(manifest.files.length, 16);
    assert.equal(manifest.archive.path, 'texthook.zip');
    const archivePath = path.join(result.texthookDirectory, manifest.archive.path);
    assert.equal(manifest.archive.sha256, createHash('sha256').update(readFileSync(archivePath)).digest('hex'));
    const unpacked = path.join(options.root, 'unpacked');
    await extract(archivePath, { dir: unpacked });
    for (const entry of manifest.files) {
        const bytes = readFileSync(path.join(result.texthookDirectory, entry.path));
        assert.equal(entry.sha256, createHash('sha256').update(bytes).digest('hex'));
        assert.deepEqual(readFileSync(path.join(unpacked, entry.path)), bytes);
        if (!entry.path.startsWith('luna_builds/')) {
            assert.deepEqual(bytes, readFileSync(path.join(options.repo, 'electron-src/assets/texthook', entry.path)));
        }
    }
    assert.equal(JSON.parse(readFileSync(path.join(options.repo, 'texthook_manifest.json'))).version, '1.0.0');
    assert(!existsSync(path.join(options.repo, 'electron-src/assets/texthook/luna_builds')));
});

test('rejects mixed source revisions before creating a package', async (t) => {
    const options = fixture(t);
    const file = path.join(options.artifacts, 'gsm-lunahook-64/provenance-64.json');
    const metadata = JSON.parse(readFileSync(file));
    metadata.sourceRevision = 'd'.repeat(40);
    writeFileSync(file, JSON.stringify(metadata));
    await assert.rejects(async () => prepareLunaHookUpdate(options), /sourceRevision/);
    assert(!existsSync(options.output));
});

test('rejects an x86 binary mislabeled as x64', async (t) => {
    const options = fixture(t);
    const file = path.join(options.artifacts, 'gsm-lunahook-64/luna_builds/LunaHostCLI64.exe');
    const bytes = readFileSync(file); bytes.writeUInt16LE(0x14c, 132); writeFileSync(file, bytes);
    await assert.rejects(async () => prepareLunaHookUpdate(options), /architecture/);
    assert(!existsSync(options.output));
});

test('rejects unsafe baseline paths and refuses to overwrite an existing candidate', async (t) => {
    const options = fixture(t);
    writeFileSync(path.join(options.repo, 'texthook_manifest.json'), JSON.stringify({ version: '1.0.0', files: [{ path: '../private.txt' }] }));
    await assert.rejects(async () => prepareLunaHookUpdate(options), /path/);
    mkdirSync(options.output);
    await assert.rejects(async () => prepareLunaHookUpdate(options), /already exists/);
});

test('requires a changed version so GSM can discover the update', async (t) => {
    const options = fixture(t);
    await assert.rejects(async () => prepareLunaHookUpdate({ ...options, version: '1.0.0' }), /different/);
});
