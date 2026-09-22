import archiver from 'archiver';
import extract from 'extract-zip';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAnonymizedLogsArchive, listLogFiles } from './log_archive.js';
import { createLogRedactor } from './log_redaction.js';

let directory: string;
let logsDirectory: string;
const redact = createLogRedactor({ usernames: ['alice'], homePaths: [], hostnames: ['alice-pc'] });

async function createZip(filePath: string, entries: Record<string, string>) {
    const archive = archiver('zip');
    const completion = pipeline(archive, fs.createWriteStream(filePath));
    for (const [name, content] of Object.entries(entries)) {
        archive.append(content, { name });
    }
    await archive.finalize();
    await completion;
}

beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-log-archive-test-'));
    logsDirectory = path.join(directory, 'logs');
    fs.mkdirSync(logsDirectory);
});

afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
});

describe('anonymized log archives', () => {
    it('redacts contents and filenames, including compressed rotations, without changing source logs', async () => {
        const sourceText = String.raw`C:\Users\alice\app.py:42 password="private-password" on alice-pc`;
        fs.writeFileSync(path.join(logsDirectory, 'alice.log'), sourceText);
        fs.writeFileSync(path.join(logsDirectory, 'alice.txt.1'), 'alice: OCR failed with code 10061');
        fs.writeFileSync(path.join(logsDirectory, 'main.log.gz'), gzipSync('username=private-user'));
        await createZip(path.join(logsDirectory, 'old.alice.log.zip'), {
            'nested/alice.log': 'api_key="old-private-key" alice on 192.168.2.4',
        });
        fs.writeFileSync(path.join(logsDirectory, 'ignored.log.png'), 'not a log');
        fs.mkdirSync(path.join(logsDirectory, 'directory.log'));

        const originals = fs.readdirSync(logsDirectory, { withFileTypes: true })
            .filter((entry) => entry.isFile())
            .map((entry) => [entry.name, fs.readFileSync(path.join(logsDirectory, entry.name))] as const);
        const output = path.join(directory, 'anonymized.zip');
        await createAnonymizedLogsArchive(logsDirectory, output, redact);
        const extracted = path.join(directory, 'extracted');
        await extract(output, { dir: extracted });
        const entries = fs.readdirSync(extracted, { recursive: true, withFileTypes: true })
            .filter((entry) => entry.isFile());
        const text = entries.map((entry) => {
            const name = path.relative(extracted, path.join(entry.parentPath, entry.name));
            return `${name}\n${fs.readFileSync(path.join(entry.parentPath, entry.name), 'utf8')}`;
        }).join('\n');

        expect(text).not.toMatch(/alice|private-password|private-user|old-private-key|192\.168|not a log/i);
        expect(text).toContain('OCR failed with code 10061');
        expect(text).toContain('app.py:42');
        expect(text).toContain('[REDACTED]');
        expect(text).toContain('ANONYMIZATION.txt');
        expect(text).toContain('before');
        expect(entries.every((entry) => !entry.name.endsWith('.zip') && !entry.name.endsWith('.gz'))).toBe(true);
        for (const [name, original] of originals) {
            expect(fs.readFileSync(path.join(logsDirectory, name))).toEqual(original);
        }
    });

    it('does not lose files when their anonymized names collide', async () => {
        fs.writeFileSync(path.join(logsDirectory, 'alice.log'), 'first diagnostic');
        const output = path.join(directory, 'collision.zip');
        fs.writeFileSync(path.join(logsDirectory, '[USER].log'), 'third diagnostic');
        await createAnonymizedLogsArchive(logsDirectory, output, redact);
        const extracted = path.join(directory, 'extracted');
        await extract(output, { dir: extracted });
        const text = fs.readdirSync(extracted).map((name) => fs.readFileSync(path.join(extracted, name), 'utf8')).join('\n');
        expect(text).toContain('first diagnostic');
        expect(text).toContain('third diagnostic');
    });

    it('does not publish an archive or overwrite a previous export if a source cannot be sanitized', async () => {
        fs.writeFileSync(path.join(logsDirectory, 'main.log'), 'password=private-password');
        fs.writeFileSync(path.join(logsDirectory, 'old.log.zip'), 'invalid zip');
        const output = path.join(directory, 'existing.zip');
        fs.writeFileSync(output, 'previous export');
        await expect(createAnonymizedLogsArchive(logsDirectory, output, redact)).rejects.toThrow();
        expect(fs.readFileSync(output, 'utf8')).toBe('previous export');
        expect(fs.readdirSync(directory).sort()).toEqual(['existing.zip', 'logs']);
    });

    it('only selects regular supported log files', async () => {
        for (const name of ['main.log', 'old.log.1', 'old.log.zip', 'old.txt.gz', 'other.LOG', 'ignored.log.png', 'config.json']) {
            fs.writeFileSync(path.join(logsDirectory, name), '');
        }
        fs.mkdirSync(path.join(logsDirectory, 'folder.log'));
        expect((await listLogFiles(logsDirectory)).sort()).toEqual(['other.LOG', 'main.log', 'old.log.1', 'old.log.zip', 'old.txt.gz'].sort());
    });

    it('never lets the export overwrite a source log archive', async () => {
        const source = path.join(logsDirectory, 'old.log.zip');
        await createZip(source, { 'old.log': 'password=private-password' });
        const original = fs.readFileSync(source);
        await expect(createAnonymizedLogsArchive(logsDirectory, source, redact)).rejects.toThrow(/source/i);
        expect(fs.readFileSync(source)).toEqual(original);
    });

    it('redacts UTF-16 Windows logs and fails safely on unsupported binary logs', async () => {
        const source = path.join(logsDirectory, 'main.log');
        fs.writeFileSync(source, Buffer.from('\ufeffpassword="private-password"', 'utf16le'));
        const output = path.join(directory, 'utf16.zip');
        await createAnonymizedLogsArchive(logsDirectory, output, redact);
        const extracted = path.join(directory, 'extracted');
        await extract(output, { dir: extracted });
        expect(fs.readFileSync(path.join(extracted, 'main.log'), 'utf8')).toBe('password="[REDACTED]"');

        fs.writeFileSync(source, Buffer.from([0x00, 0xff, 0x80, 0x00]));
        const failedOutput = path.join(directory, 'binary.zip');
        await expect(createAnonymizedLogsArchive(logsDirectory, failedOutput, redact)).rejects.toThrow();
        expect(fs.existsSync(failedOutput)).toBe(false);
        expect(fs.readdirSync(directory).some((name) => name.startsWith('.gsm-log-export-'))).toBe(false);
    });
});
