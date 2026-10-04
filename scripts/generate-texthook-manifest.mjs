// Generate the two public objects: texthook.zip and texthook_manifest.json.
import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import archiver from 'archiver';
import semver from 'semver';

const defaultSource = fileURLToPath(new URL('../electron-src/assets/texthook', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export async function generateTexthookManifest({ source = defaultSource, version, outFile = 'texthook_manifest.json' }) {
    if (!semver.valid(version)) throw new Error('Supply an explicit semantic manifest version.');
    const paths = ['NOTICE.md'];
    function collect(relative) {
        for (const entry of readdirSync(path.join(source, relative), { withFileTypes: true })) {
            const name = `${relative}/${entry.name}`;
            if (entry.isDirectory()) collect(name);
            else if (entry.isFile() && /\.(dll|exe)$/i.test(entry.name)) paths.push(name);
        }
    }
    collect('luna_builds');
    collect('textractor_builds');
    paths.sort();
    // Hash and archive the same bytes, with fixed timestamps for reproducible ZIPs.
    const contents = paths.map(name => ({ path: name, bytes: readFileSync(path.join(source, name)) }));
    const manifestPath = path.resolve(outFile);
    const archivePath = path.join(path.dirname(manifestPath), 'texthook.zip');
    mkdirSync(path.dirname(manifestPath), { recursive: true });
    await new Promise((resolve, reject) => {
        const output = createWriteStream(archivePath);
        const archive = archiver('zip', { zlib: { level: 9 } });
        output.on('close', resolve);
        output.on('error', reject);
        archive.on('error', reject);
        archive.pipe(output);
        for (const entry of contents) {
            archive.append(entry.bytes, { name: entry.path, date: new Date('2000-01-01T00:00:00Z'), mode: 0o644 });
        }
        archive.finalize().catch(reject);
    });
    const manifest = {
        version,
        archive: { path: 'texthook.zip', sha256: sha256(readFileSync(archivePath)) },
        files: contents.map(entry => ({ path: entry.path, sha256: sha256(entry.bytes) })),
    };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const { values } = parseArgs({ options: {
        source: { type: 'string' }, version: { type: 'string' }, 'out-file': { type: 'string' },
    } });
    const manifest = await generateTexthookManifest({ source: values.source, version: values.version, outFile: values['out-file'] });
    console.log(`Generated texthook.zip and ${values['out-file'] ?? 'texthook_manifest.json'}: v${manifest.version}, ${manifest.files.length} runtime files.`);
}
