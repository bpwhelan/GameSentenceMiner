// Stage a reviewable R2 payload from the fork's two GSM LunaHook CI artifacts.
// This command does not install files, modify the checkout, or publish anything.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { generateTexthookManifest } from './generate-texthook-manifest.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

function safePath(value) {
    if (typeof value !== 'string' || !/^[\w.-]+(?:\/[\w.-]+)*$/.test(value)
        || value.split('/').some(part => part === '.' || part === '..' || part.endsWith('.'))) {
        throw new Error(`Unsafe manifest path: ${value}`);
    }
    return value;
}

function checkMachine(file, bits) {
    const bytes = readFileSync(file);
    const offset = bytes.length >= 64 && bytes.readUInt16LE(0) === 0x5a4d ? bytes.readUInt32LE(0x3c) : -1;
    if (offset < 0 || offset + 6 > bytes.length || bytes.readUInt32LE(offset) !== 0x4550
        || bytes.readUInt16LE(offset + 4) !== (bits === 32 ? 0x14c : 0x8664)) {
        throw new Error(`Wrong or invalid ${bits}-bit PE architecture: ${file}`);
    }
}

export async function prepareLunaHookUpdate({ repo = repoRoot, artifacts, output, version }) {
    if (!artifacts || !output) throw new Error('Supply artifacts and output directories.');
    if (typeof version !== 'string' || !/^[\w][\w.-]*$/.test(version)) throw new Error('Supply an explicit manifest version.');
    const outputDirectory = path.resolve(output);
    if (existsSync(outputDirectory)) throw new Error(`Output already exists: ${outputDirectory}`);
    const baseline = readJson(path.join(repo, 'texthook_manifest.json'));
    if (baseline.version === version) throw new Error('The update version must be different from the current manifest version.');
    const sources = new Map();
    const names = new Set();
    for (const entry of baseline.files) {
        const relative = safePath(entry.path);
        if (names.has(relative.toLowerCase())) throw new Error(`Duplicate manifest path: ${relative}`);
        names.add(relative.toLowerCase());
        if (!relative.startsWith('luna_builds/')) {
            sources.set(relative, path.join(repo, 'electron-src/assets/texthook', relative));
        }
    }
    for (const arch of ['_x86', '_x64']) {
        for (const name of ['LoaderDll.dll', 'LocaleEmulator.dll', 'texthook.dll', 'TextractorCLI.exe']) {
            const relative = `textractor_builds/${arch}/${name}`;
            if (!sources.has(relative)) throw new Error(`Missing baseline runtime path: ${relative}`);
        }
    }
    if (!sources.has('NOTICE.md')) throw new Error('Missing baseline NOTICE.md.');
    const provenance = [];
    for (const bits of [32, 64]) {
        const directory = path.join(artifacts, `gsm-lunahook-${bits}`);
        const metadata = readJson(path.join(directory, `provenance-${bits}.json`));
        if (metadata.sourceRepository !== 'bpwhelan/LunaTranslator'
            || metadata.arch !== (bits === 32 ? 'Win32' : 'x64')
            || !/^\d+(?:\.\d+){3}$/.test(metadata.version)
            || ['sourceRevision', 'minhook', 'uchardet'].some(key => !/^[a-f0-9]{40}$/.test(metadata[key]))) {
            throw new Error(`Invalid ${bits}-bit source provenance.`);
        }
        for (const key of ['sourceRepository', 'sourceRevision', 'version', 'minhook', 'uchardet']) {
            if (provenance.length && metadata[key] !== provenance[0][key]) {
                throw new Error(`Mixed build provenance: ${key} differs between architectures.`);
            }
        }
        provenance.push(metadata);
        for (const name of [`LunaHook${bits}.dll`, `LunaHost${bits}.dll`, `LunaHostCLI${bits}.exe`]) {
            const file = path.join(directory, 'luna_builds', name);
            checkMachine(file, bits);
            sources.set(`luna_builds/${name}`, file);
        }
    }
    // The managed Unity font helper is architecture-neutral; take the x64 job's copy.
    sources.set('luna_builds/LunaTmpFontLoader.dll', path.join(artifacts, 'gsm-lunahook-64/luna_builds/LunaTmpFontLoader.dll'));
    const entries = [...sources].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([relative, source]) => ({ path: relative, sha256: sha256(readFileSync(source)) }));
    const texthookDirectory = path.join(outputDirectory, 'texthook');
    for (const entry of entries) {
        const destination = path.join(texthookDirectory, entry.path);
        mkdirSync(path.dirname(destination), { recursive: true });
        copyFileSync(sources.get(entry.path), destination);
        if (sha256(readFileSync(destination)) !== entry.sha256) throw new Error(`Copy verification failed: ${entry.path}`);
    }
    const manifestPath = path.join(texthookDirectory, 'texthook_manifest.json');
    const manifest = await generateTexthookManifest({ source: texthookDirectory, version, outFile: manifestPath });
    writeFileSync(path.join(outputDirectory, 'provenance.json'), `${JSON.stringify({
        manifestVersion: version,
        previousManifestVersion: baseline.version,
        generatedAt: new Date().toISOString(),
        builds: provenance,
        archive: manifest.archive,
        files: entries,
    }, null, 2)}\n`);
    return { outputDirectory, texthookDirectory, manifestPath, files: entries.length, sourceRevision: provenance[0].sourceRevision };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const { values } = parseArgs({ options: {
        artifacts: { type: 'string' }, output: { type: 'string' }, version: { type: 'string' },
    } });
    console.log(JSON.stringify(await prepareLunaHookUpdate(values), null, 2));
}
