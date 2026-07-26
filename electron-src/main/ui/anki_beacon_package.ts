import archiver from 'archiver';
import extract from 'extract-zip';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

const ANKI_BEACON_CONFIG_FILE = 'config.json';
const GSM_ANKI_EVENTS_PATH = '/anki/events';

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validatePort(port: number): void {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error(`Invalid GSM port: ${port}`);
    }
}

function isLocalGsmEventUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return (
            (url.hostname === '127.0.0.1' ||
                url.hostname === 'localhost' ||
                url.hostname === '[::1]') &&
            url.pathname === GSM_ANKI_EVENTS_PATH
        );
    } catch {
        return false;
    }
}

function withPort(value: string, port: number): string {
    const url = new URL(value);
    url.port = String(port);
    return url.toString();
}

export function configureAnkiBeaconConfig(config: unknown, gsmPort: number): JsonObject {
    validatePort(gsmPort);
    if (!isJsonObject(config) || !Array.isArray(config.operations)) {
        throw new Error('AnkiBeacon package has an unsupported config.json');
    }

    let foundNoteAddedOperation = false;
    const operations = config.operations.map((operation) => {
        if (!isJsonObject(operation) || operation.operation !== 'note_added') {
            return operation;
        }

        foundNoteAddedOperation = true;
        const currentUrls = Array.isArray(operation.urls) ? operation.urls : [];
        let updatedLocalUrl = false;
        const urls = currentUrls.map((value) => {
            if (typeof value !== 'string' || !isLocalGsmEventUrl(value)) {
                return value;
            }
            updatedLocalUrl = true;
            return withPort(value, gsmPort);
        });

        if (!updatedLocalUrl) {
            urls.push(`http://127.0.0.1:${gsmPort}${GSM_ANKI_EVENTS_PATH}`);
        }

        return {
            ...operation,
            urls,
        };
    });

    if (!foundNoteAddedOperation) {
        throw new Error('AnkiBeacon package does not define a note_added operation');
    }

    return {
        ...config,
        operations,
    };
}

async function createAddonArchive(sourceDir: string, outputPath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const output = fs.createWriteStream(outputPath);
        const archive = archiver('zip', { zlib: { level: 9 } });
        output.on('close', resolve);
        output.on('error', reject);
        archive.on('error', reject);
        archive.pipe(output);
        archive.directory(sourceDir, false);
        void archive.finalize().catch(reject);
    });
}

export async function writeConfiguredAnkiBeaconAddon(
    addonBytes: Buffer,
    outputPath: string,
    gsmPort: number,
): Promise<void> {
    validatePort(gsmPort);
    const workingDir = await fsp.mkdtemp(
        path.join(path.dirname(outputPath), 'anki-beacon-config-'),
    );
    const downloadedAddonPath = path.join(workingDir, 'download.ankiaddon');
    const extractedAddonDir = path.join(workingDir, 'addon');

    try {
        await fsp.writeFile(downloadedAddonPath, addonBytes);
        await extract(downloadedAddonPath, { dir: extractedAddonDir });

        const configPath = path.join(extractedAddonDir, ANKI_BEACON_CONFIG_FILE);
        const configText = (await fsp.readFile(configPath, 'utf8')).replace(/^\uFEFF/, '');
        const configured = configureAnkiBeaconConfig(JSON.parse(configText), gsmPort);
        await fsp.writeFile(configPath, `${JSON.stringify(configured, null, 2)}\n`, 'utf8');

        await createAddonArchive(extractedAddonDir, outputPath);
    } catch (error) {
        await fsp.rm(outputPath, { force: true }).catch(() => undefined);
        throw error;
    } finally {
        await fsp.rm(workingDir, { recursive: true, force: true });
    }
}
