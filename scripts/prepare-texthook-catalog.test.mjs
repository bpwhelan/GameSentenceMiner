import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateTexthookManifest } from './generate-texthook-manifest.mjs';
import { prepareTexthookCatalog } from './prepare-texthook-catalog.mjs';

test('v2 catalogs retain older releases and use immutable ZIPs without advertising latest as recommended', async t => {
    const root = mkdtempSync(path.join(tmpdir(), 'gsm-catalog-'));
    t.after(() => {
        assert.equal(path.dirname(root), path.resolve(tmpdir()));
        assert(path.basename(root).startsWith('gsm-catalog-'));
        rmSync(root, { recursive: true, force: true });
    });
    const packages = [];
    for (const version of ['1.0.3', '1.0.4']) {
        const directory = path.join(root, version);
        for (const folder of ['luna_builds', 'textractor_builds']) mkdirSync(path.join(directory, folder), { recursive: true });
        writeFileSync(path.join(directory, 'NOTICE.md'), `notice ${version}`);
        await generateTexthookManifest({ source: directory, version, outFile: path.join(directory, 'texthook_manifest.json') });
        packages.push(directory);
    }
    const output = path.join(root, 'output');
    const catalog = prepareTexthookCatalog({ packages, output, recommendedVersion: '1.0.3' });
    assert.equal(catalog.schemaVersion, 2);
    assert.equal(catalog.recommendedVersion, '1.0.3');
    assert.deepEqual(catalog.releases.map(release => release.version), ['1.0.4', '1.0.3']);
    for (const release of catalog.releases) assert.equal(release.archive.path, `versions/${release.version}/texthook.zip`);
    assert.deepEqual(readFileSync(path.join(output, catalog.releases[0].archive.path)), readFileSync(path.join(packages[1], 'texthook.zip')));
    assert.throws(() => prepareTexthookCatalog({ packages, output: path.join(root, 'bad'), recommendedVersion: '9.0.0' }), /missing/);
    const file = path.join(packages[1], 'texthook_manifest.json');
    const changed = JSON.parse(readFileSync(file));
    changed.notes = 'changed existing release';
    writeFileSync(file, JSON.stringify(changed));
    assert.throws(() => prepareTexthookCatalog({ packages: [packages[1]], output: path.join(root, 'changed'),
        recommendedVersion: '1.0.3', catalog: path.join(output, 'texthook_manifest_v2.json') }), /existing version/);
});
