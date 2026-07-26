import archiver from 'archiver';
import extract from 'extract-zip';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
    configureAnkiBeaconConfig,
    writeConfiguredAnkiBeaconAddon,
} from './anki_beacon_package.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-anki-beacon-test-'));
    tempDirs.push(dir);
    return dir;
}

async function createAddonArchive(outputPath: string, config: unknown): Promise<void> {
    const sourceDir = path.join(makeTempDir(), 'source');
    await fsp.mkdir(sourceDir, { recursive: true });
    await fsp.writeFile(
        path.join(sourceDir, 'config.json'),
        `${JSON.stringify(config, null, 2)}\n`,
        'utf8',
    );
    await fsp.writeFile(path.join(sourceDir, '__init__.py'), '# test add-on\n', 'utf8');

    await new Promise<void>((resolve, reject) => {
        const output = fs.createWriteStream(outputPath);
        const archive = archiver('zip');
        output.on('close', resolve);
        output.on('error', reject);
        archive.on('error', reject);
        archive.pipe(output);
        archive.directory(sourceDir, false);
        void archive.finalize().catch(reject);
    });
}

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe('AnkiBeacon package configuration', () => {
    it('updates the local GSM endpoint and preserves unrelated webhooks', () => {
        const config = {
            defaults: { timeout_seconds: 5 },
            operations: [
                {
                    operation: 'note_added',
                    enabled: true,
                    urls: [
                        'http://127.0.0.1:7275/anki/events',
                        'https://example.com/anki/events',
                    ],
                    payload_mode: 'note_id',
                },
            ],
        };

        expect(configureAnkiBeaconConfig(config, 6001)).toEqual({
            defaults: { timeout_seconds: 5 },
            operations: [
                {
                    operation: 'note_added',
                    enabled: true,
                    urls: [
                        'http://127.0.0.1:6001/anki/events',
                        'https://example.com/anki/events',
                    ],
                    payload_mode: 'note_id',
                },
            ],
        });
        expect(config.operations[0].urls[0]).toBe('http://127.0.0.1:7275/anki/events');
    });

    it('rewrites config.json inside an installable add-on archive', async () => {
        const dir = makeTempDir();
        const sourcePath = path.join(dir, 'source.ankiaddon');
        const outputPath = path.join(dir, 'configured.ankiaddon');
        const extractDir = path.join(dir, 'extracted');
        const config = {
            defaults: { timeout_seconds: 5 },
            operations: [
                {
                    operation: 'note_added',
                    enabled: true,
                    urls: ['http://127.0.0.1:7275/anki/events'],
                    payload_mode: 'note_id',
                },
            ],
        };
        await createAddonArchive(sourcePath, config);

        await writeConfiguredAnkiBeaconAddon(
            await fsp.readFile(sourcePath),
            outputPath,
            6001,
        );
        await extract(outputPath, { dir: extractDir });

        const packagedConfig = JSON.parse(
            await fsp.readFile(path.join(extractDir, 'config.json'), 'utf8'),
        );
        expect(packagedConfig.operations[0].urls).toEqual([
            'http://127.0.0.1:6001/anki/events',
        ]);
        await expect(fsp.readFile(path.join(extractDir, '__init__.py'), 'utf8')).resolves.toBe(
            '# test add-on\n',
        );
    });
});
