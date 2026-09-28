import archiver from 'archiver';
import extract from 'extract-zip';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';

import { createLogRedactor } from './log_redaction.js';

const unzipGzip = promisify(gunzip);
const TEXT_LOG = /\.(?:log|txt|jsonl)(?:\.\d+)?$/i;
const COMPRESSED_LOG = /\.(?:log|txt|jsonl)(?:\.\d+)?\.(?:zip|gz)$/i;
const MAX_LOG_BYTES = 64 * 1024 * 1024;

export const LOG_ANONYMIZATION_NOTICE = [
    'GSM anonymized log export',
    '',
    'These copies were automatically redacted before being added to this ZIP.',
    'Redaction covers local usernames, home folders, computer names, email addresses,',
    'remote IP/MAC addresses, and common password, API key, token and cookie formats.',
    'Compressed log history is decompressed and redacted too. Original logs are unchanged.',
    'Loopback addresses, timestamps, error messages and diagnostic context are retained.',
    'Current logs are at the top level; rotated and imported logs are in history/.',
    'ocr.log contains persistent OCR diagnostics. ocr-debug.jsonl is present when advanced',
    'OCR debugging has recorded events. Empty logs and internal lock files are omitted.',
    '',
    'Automatic redaction may miss personal details in free text, game text or unusual formats.',
    'Review the exported logs before sharing them.',
    '',
].join('\n');

export async function listLogFiles(logsDirectory: string): Promise<string[]> {
    const files: string[] = [];
    const visit = async (relativeDirectory: string) => {
        const entries = await fs.promises.readdir(path.join(logsDirectory, relativeDirectory), { withFileTypes: true });
        for (const entry of entries) {
            // Never traverse links/junctions or internal working directories.
            if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
            const relativePath = path.join(relativeDirectory, entry.name);
            if (entry.isDirectory()) {
                await visit(relativePath);
            } else if (entry.isFile() && (TEXT_LOG.test(entry.name) || COMPRESSED_LOG.test(entry.name))) {
                try {
                    if ((await fs.promises.stat(path.join(logsDirectory, relativePath))).size > 0) files.push(relativePath);
                } catch (error: any) {
                    if (error.code !== 'ENOENT') throw error; // A live log may rotate during enumeration.
                }
            }
        }
    };
    await visit('');
    return files.sort();
}

async function readLog(filePath: string): Promise<string> {
    const stat = await fs.promises.lstat(filePath);
    if (!stat.isFile() || stat.size > MAX_LOG_BYTES) {
        throw new Error('A log is not a regular file or exceeds the 64 MiB export limit.');
    }
    const bytes = await fs.promises.readFile(filePath);
    const decoded = /\.gz$/i.test(filePath)
        ? await unzipGzip(bytes, { maxOutputLength: MAX_LOG_BYTES })
        : bytes;
    // UTF-16 or binary input must not silently bypass text redaction.
    const text = decoded[0] === 0xff && decoded[1] === 0xfe
        ? decoded.subarray(2).toString('utf16le')
        : new TextDecoder('utf-8', { fatal: true }).decode(decoded);
    if (text.includes('\0')) throw new Error('A log has an unsupported text encoding.');
    return text;
}

/** Publish only a completely sanitized archive, keeping any previous export on failure. */
export async function createAnonymizedLogsArchive(
    logsDirectory: string,
    outputPath: string,
    redact: (text: string) => string = createLogRedactor(),
): Promise<void> {
    const files = await listLogFiles(logsDirectory);
    if (!files.length) throw new Error('No log files found in the logs directory.');
    const sourceDirectory = await fs.promises.realpath(logsDirectory);
    const destination = path.join(await fs.promises.realpath(path.dirname(outputPath)), path.basename(outputPath));
    const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
    if (files.some((file) => normalize(path.join(sourceDirectory, file)) === normalize(destination))) {
        throw new Error('Choose an export location that does not overwrite a source log.');
    }

    const staging = await fs.promises.mkdtemp(path.join(path.dirname(outputPath), '.gsm-log-export-'));
    const archive = archiver('zip', { zlib: { level: 9 } });
    let completion: Promise<void> | undefined;
    try {
        const temporaryArchive = path.join(staging, 'anonymized.zip');
        completion = pipeline(archive, fs.createWriteStream(temporaryArchive));
        // A write failure can happen while sources are still being read.
        void completion.catch(() => {});
        const names = new Set<string>(['anonymization.txt', 'export_notes.txt']);
        const skipped: string[] = [];
        const appendLog = async (filePath: string, sourceName: string) => {
            let content: string;
            try {
                content = redact(await readLog(filePath));
            } catch (error: any) {
                if (error.code !== 'ENOENT') throw error;
                skipped.push(sourceName);
                return;
            }
            // Retain the useful folder layout and redact every path component.
            const baseName = sourceName.split(/[/\\]/).map((segment) => {
                const safe = redact(segment).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
                return !safe || safe === '.' || safe === '..' ? '_' : safe;
            }).join('/');
            let name = baseName;
            let suffix = 2;
            while (names.has(name.toLowerCase())) name = path.posix.join(path.posix.dirname(baseName), `${suffix++}-${path.posix.basename(baseName)}`);
            names.add(name.toLowerCase());
            archive.append(content, { name });
        };

        archive.append(LOG_ANONYMIZATION_NOTICE, { name: 'ANONYMIZATION.txt' });
        for (const file of files) {
            const source = path.join(logsDirectory, file);
            if (!/\.zip$/i.test(file)) {
                await appendLog(source, file.replace(/\.gz$/i, ''));
                continue;
            }

            // Loguru stores rotations as ZIPs. Never copy those ZIPs verbatim.
            // Extract into a private working directory and remove it even on failure.
            const extracted = await fs.promises.mkdtemp(path.join(staging, 'rotation-'));
            try {
                const stat = await fs.promises.lstat(source);
                if (!stat.isFile() || stat.size > MAX_LOG_BYTES) {
                    throw new Error('A compressed log is not a regular file or exceeds the 64 MiB export limit.');
                }
                let totalBytes = 0;
                await extract(source, {
                    dir: extracted,
                    onEntry: (entry) => {
                        totalBytes += entry.uncompressedSize;
                        const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
                        if ((mode !== 0 && mode !== 0o100000 && mode !== 0o040000)
                            || totalBytes > MAX_LOG_BYTES
                            || (!entry.fileName.endsWith('/') && !TEXT_LOG.test(entry.fileName))) {
                            throw new Error('A compressed log contains unsupported entries or exceeds the 64 MiB export limit.');
                        }
                    },
                });
                const entries = await fs.promises.readdir(extracted, { recursive: true, withFileTypes: true });
                for (const entry of entries) {
                    if (!entry.isFile()) continue;
                    const extractedPath = path.join(entry.parentPath, entry.name);
                    await appendLog(extractedPath, path.join(path.dirname(file), path.relative(extracted, extractedPath)));
                }
            } catch (error: any) {
                if (error.code !== 'ENOENT' || fs.existsSync(source)) throw error;
                skipped.push(file);
            } finally {
                await fs.promises.rm(extracted, { recursive: true, force: true });
            }
        }
        if (skipped.length) {
            archive.append(redact(`These logs rotated or were removed while the export was being read:\n${skipped.join('\n')}\n`), {
                name: 'EXPORT_NOTES.txt',
            });
        }
        await archive.finalize();
        await completion;
        await fs.promises.rename(temporaryArchive, outputPath);
    } catch (error) {
        archive.abort();
        archive.destroy();
        await completion?.catch(() => {});
        throw error;
    } finally {
        await fs.promises.rm(staging, { recursive: true, force: true });
    }
}
