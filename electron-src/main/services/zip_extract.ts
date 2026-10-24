import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as yauzl from 'yauzl';
import type { Entry, ZipFile } from 'yauzl';

interface ExtractOptions {
    dir: string;
    onEntry?: (entry: Entry) => void;
}

async function lstatIfPresent(target: string) {
    try {
        return await fs.lstat(target);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return undefined;
    }
}

function entryParts(entry: Entry): string[] {
    const name = entry.fileName;
    const parts = name.replace(/\/$/, '').split('/');
    // Apply Windows restrictions on every platform so an archive cannot acquire
    // different path semantics when the same download is opened on Windows.
    if (path.isAbsolute(name) || parts.some(part =>
        !part || part === '.' || part === '..'
        || /[\\\x00-\x1f<>:"|?*]/.test(part) || /[. ]$/.test(part)
        || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
    )) {
        throw new Error(`Unsafe ZIP entry path: ${name}`);
    }
    return parts;
}

async function ensureDirectories(root: string, parts: string[]): Promise<string> {
    let current = root;
    for (const part of parts) {
        current = path.join(current, part);
        try {
            await fs.mkdir(current);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw new Error(`Unsafe ZIP destination directory: ${current}`);
        }
    }
    return current;
}

function nextEntry(zip: ZipFile): Promise<Entry | null> {
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            zip.off('entry', onEntry);
            zip.off('end', onEnd);
            zip.off('error', onError);
        };
        const onEntry = (entry: Entry) => { cleanup(); resolve(entry); };
        const onEnd = () => { cleanup(); resolve(null); };
        const onError = (error: Error) => { cleanup(); reject(error); };
        zip.once('entry', onEntry);
        zip.once('end', onEnd);
        zip.once('error', onError);
        try {
            zip.readEntry();
        } catch (error) {
            cleanup();
            reject(error);
        }
    });
}

async function extractEntry(zip: ZipFile, root: string, entry: Entry, options: ExtractOptions): Promise<void> {
    const parts = entryParts(entry);
    const mode = entry.externalFileAttributes >>> 16;
    const kind = mode & 0o170000;
    // ZIP downloads and GSM backups do not require symlinks or special files.
    // Reject them before opening any output, including duplicate-name attacks.
    if (kind !== 0 && kind !== 0o100000 && kind !== 0o040000) {
        throw new Error(`Unsupported ZIP entry (symbolic link or special file): ${entry.fileName}`);
    }
    options.onEntry?.(entry);
    const directory = entry.fileName.endsWith('/') || kind === 0o040000;
    const parent = await ensureDirectories(root, directory ? parts : parts.slice(0, -1));
    if (directory) return;

    const target = path.join(parent, parts[parts.length - 1]);
    const existing = await lstatIfPresent(target);
    if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
        throw new Error(`Unsafe ZIP destination file: ${target}`);
    }

    // Never truncate an existing inode: it could be hard-linked outside root.
    // An exclusive temporary file followed by rename also keeps old contents
    // intact if decompression or entry-size validation fails.
    const temporary = path.join(parent, `.gsm-extract-${randomUUID()}`);
    try {
        const input = await new Promise<NodeJS.ReadableStream>((resolve, reject) => {
            zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream!));
        });
        await pipeline(input, createWriteStream(temporary, { flags: 'wx', mode: (mode & 0o777) || 0o644 }));
        await fs.chmod(temporary, (mode & 0o777) || 0o644);
        const modified = entry.getLastModDate();
        if (Number.isFinite(modified.getTime())) await fs.utimes(temporary, modified, modified);
        await fs.rename(temporary, target);
    } finally {
        await fs.rm(temporary, { force: true });
    }
}

/** Extract ZIPs without allowing archive entries to follow or create links. */
export default async function extract(archive: string, options: ExtractOptions): Promise<void> {
    if (!path.isAbsolute(options.dir)) throw new Error('ZIP destination must be an absolute path.');
    await fs.mkdir(options.dir, { recursive: true });
    const root = await fs.realpath(options.dir);
    const zip = await new Promise<ZipFile>((resolve, reject) => {
        yauzl.open(archive, {
            lazyEntries: true,
            strictFileNames: true,
            validateEntrySizes: true,
        }, (error, value) => error ? reject(error) : resolve(value!));
    });
    // Keep an error listener while streaming an entry as well as while reading
    // the next central-directory record, so every parser error is propagated.
    let zipError: Error | undefined;
    const onError = (error: Error) => { zipError = error; };
    zip.on('error', onError);
    try {
        for (;;) {
            if (zipError) throw zipError;
            const entry = await nextEntry(zip);
            if (!entry) break;
            await extractEntry(zip, root, entry, options);
        }
        if (zipError) throw zipError;
    } finally {
        zip.close();
    }
}
