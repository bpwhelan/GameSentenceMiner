// Assemble immutable downloads and a v2 catalog. Legacy public objects are never used as destinations.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import semver from 'semver';

const readJson = file => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');

function validateRelease(release) {
    if (!release || semver.valid(release.version) !== release.version || !Array.isArray(release.files) || !release.files.length
        || !/^[a-f\d]{64}$/.test(release.archive?.sha256)
        || !['texthook.zip', `versions/${release.version}/texthook.zip`].includes(release.archive.path)) {
        throw new Error('Invalid engine release metadata.');
    }
    const seen = new Set();
    for (const entry of release.files) {
        if (!/^(NOTICE\.md|(?:luna_builds|textractor_builds)\/[\w.-]+(?:\/[\w.-]+)*)$/.test(entry.path)
            || entry.path.split('/').some(part => part === '.' || part === '..' || part.endsWith('.'))
            || seen.has(entry.path.toLowerCase()) || !/^[a-f\d]{64}$/.test(entry.sha256)) {
            throw new Error('Unsafe or duplicate engine file.');
        }
        seen.add(entry.path.toLowerCase());
    }
    return { ...release, archive: { ...release.archive, path: `versions/${release.version}/texthook.zip` } };
}

export function prepareTexthookCatalog({ packages, output, recommendedVersion, catalog: catalogPath }) {
    if (!packages?.length || !output || semver.valid(recommendedVersion) !== recommendedVersion) {
        throw new Error('Supply packages, output and a recommended semantic version.');
    }
    if (existsSync(output)) throw new Error('Use a fresh catalog output directory.');
    const previous = catalogPath ? readJson(catalogPath) : { schemaVersion: 2, releases: [] };
    if (previous.schemaVersion !== 2 || !Array.isArray(previous.releases)) throw new Error('Invalid previous catalog.');
    const releases = new Map();
    for (const value of previous.releases) {
        const release = validateRelease(value);
        if (releases.has(release.version)) throw new Error('Duplicate catalog version.');
        releases.set(release.version, release);
    }
    const copies = [];
    for (const directory of packages) {
        const original = readJson(path.join(directory, 'texthook_manifest.json'));
        const release = validateRelease(original);
        const archive = path.join(directory, original.archive.path);
        if (hash(archive) !== release.archive.sha256) throw new Error('Archive hash mismatch.');
        const existing = releases.get(release.version);
        if (existing && JSON.stringify(existing) !== JSON.stringify(release)) throw new Error('Cannot change an existing version.');
        releases.set(release.version, release);
        copies.push([archive, release.archive.path]);
    }
    if (!releases.has(recommendedVersion)) throw new Error('Recommended version is missing from the catalog.');
    const catalog = { schemaVersion: 2, recommendedVersion,
        releases: [...releases.values()].sort((a, b) => semver.rcompare(a.version, b.version)) };
    for (const [source, relative] of copies) {
        const destination = path.join(output, relative);
        mkdirSync(path.dirname(destination), { recursive: true });
        copyFileSync(source, destination);
    }
    writeFileSync(path.join(output, 'texthook_manifest_v2.json'), `${JSON.stringify(catalog, null, 2)}\n`);
    return catalog;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const { values } = parseArgs({ options: {
        package: { type: 'string', multiple: true }, output: { type: 'string' },
        recommended: { type: 'string' }, catalog: { type: 'string' },
    } });
    const catalog = prepareTexthookCatalog({ packages: values.package, output: values.output,
        recommendedVersion: values.recommended, catalog: values.catalog });
    console.log(`Prepared v2 catalog: ${catalog.releases.length} versions; recommended ${catalog.recommendedVersion}.`);
}
