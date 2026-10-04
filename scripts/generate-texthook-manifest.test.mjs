import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import extract from 'extract-zip';
import { generateTexthookManifest } from './generate-texthook-manifest.mjs';

test('generates exactly one reproducible ZIP and one UTF-8 manifest containing only runtime files', async t => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'gsm-texthook-zip-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, 'source');
    const runtime = ['NOTICE.md', 'luna_builds/LunaHook32.dll', 'textractor_builds/_x64/TextractorCLI.exe'];
    for (const file of [...runtime, 'luna_builds/host.lib', 'textractor_builds/debug.pdb', 'profiles.json']) {
        const fullPath = path.join(source, file);
        mkdirSync(path.dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, `bytes of ${file}\r\n`);
    }
    const output = path.join(root, 'output');
    const options = { source, version: '1.0.2', outFile: path.join(output, 'texthook_manifest.json') };
    const manifest = await generateTexthookManifest(options);
    assert.deepEqual(readdirSync(output).sort(), ['texthook.zip', 'texthook_manifest.json']);
    assert.deepEqual(manifest.files.map(entry => entry.path), runtime);
    assert.equal(JSON.parse(readFileSync(options.outFile, 'utf8')).archive.sha256, manifest.archive.sha256);
    const zip = path.join(output, manifest.archive.path);
    assert.equal(createHash('sha256').update(readFileSync(zip)).digest('hex'), manifest.archive.sha256);
    const extracted = path.join(root, 'extracted');
    await extract(zip, { dir: extracted });
    assert.deepEqual(readdirSync(extracted, { recursive: true }).filter(file => /\.(md|dll|exe|lib|pdb|json)$/.test(file)).map(file => file.replaceAll('\\', '/')).sort(), runtime);
    for (const entry of manifest.files) {
        assert.equal(createHash('sha256').update(readFileSync(path.join(extracted, entry.path))).digest('hex'), entry.sha256);
    }
    assert.deepEqual(await generateTexthookManifest(options), manifest);
    await assert.rejects(generateTexthookManifest({ ...options, version: '../unsafe' }), /version/);
});
