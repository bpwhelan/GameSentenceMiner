import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { crc32 } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import extract from './zip_extract.js';

interface FixtureEntry {
    name: string;
    content?: string;
    mode?: number;
}

// Write stored ZIP entries directly so fixtures retain malicious paths and
// duplicate names that archive creation libraries normally sanitize away.
function zipFixture(entries: FixtureEntry[]): Buffer {
    const local: Buffer[] = [];
    const central: Buffer[] = [];
    let offset = 0;
    for (const entry of entries) {
        const name = Buffer.from(entry.name);
        const content = Buffer.from(entry.content ?? '');
        const checksum = crc32(content);
        const header = Buffer.alloc(30);
        header.writeUInt32LE(0x04034b50);
        header.writeUInt16LE(20, 4);
        header.writeUInt32LE(checksum, 14);
        header.writeUInt32LE(content.length, 18);
        header.writeUInt32LE(content.length, 22);
        header.writeUInt16LE(name.length, 26);
        local.push(header, name, content);
        const record = Buffer.alloc(46);
        record.writeUInt32LE(0x02014b50);
        record.writeUInt16LE(0x0314, 4);
        record.writeUInt16LE(20, 6);
        record.writeUInt32LE(checksum, 16);
        record.writeUInt32LE(content.length, 20);
        record.writeUInt32LE(content.length, 24);
        record.writeUInt16LE(name.length, 28);
        record.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
        record.writeUInt32LE(offset, 42);
        central.push(record, name);
        offset += header.length + name.length + content.length;
    }
    const directory = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...local, directory, end]);
}

describe('ZIP extraction containment', () => {
    let temporary: string;
    let destination: string;
    let archive: string;

    beforeEach(async () => {
        temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'gsm-zip-test-'));
        destination = path.join(temporary, 'extracted');
        archive = path.join(temporary, 'archive.zip');
    });

    afterEach(async () => {
        await fs.rm(temporary, { recursive: true, force: true });
    });

    async function unpack(entries: FixtureEntry[], options = {}) {
        await fs.writeFile(archive, zipFixture(entries));
        return extract(archive, { dir: destination, ...options });
    }

    it('extracts nested files, directory entries, and executable permissions', async () => {
        const names: string[] = [];
        await unpack([
            { name: 'bin/', mode: 0o040755 },
            { name: 'bin/helper', content: 'helper', mode: 0o100755 },
            { name: 'settings.json', content: '{"enabled":true}' },
        ], { onEntry: (entry: { fileName: string }) => names.push(entry.fileName) });
        expect(await fs.readFile(path.join(destination, 'bin/helper'), 'utf8')).toBe('helper');
        expect(names).toEqual(['bin/', 'bin/helper', 'settings.json']);
        if (process.platform !== 'win32') {
            expect((await fs.stat(path.join(destination, 'bin/helper'))).mode & 0o777).toBe(0o755);
        }
    });

    it('rejects a symlink followed by a regular file with the same name', async () => {
        const outside = path.join(temporary, 'outside.txt');
        await fs.writeFile(outside, 'unchanged');
        await expect(unpack([
            { name: 'link', content: outside, mode: 0o120777 },
            { name: 'link', content: 'overwritten' },
        ])).rejects.toThrow(/unsupported ZIP entry|symbolic link/i);
        expect(await fs.readFile(outside, 'utf8')).toBe('unchanged');
    });

    it('rejects archive directory symlinks before extracting their children', async () => {
        await expect(unpack([
            { name: 'link', content: '..', mode: 0o120777 },
            { name: 'link/escaped.txt', content: 'escaped' },
        ])).rejects.toThrow(/unsupported ZIP entry|symbolic link/i);
        await expect(fs.access(path.join(temporary, 'escaped.txt'))).rejects.toThrow();
    });

    it('replaces a pre-existing hard link without changing the outside file', async () => {
        const outside = path.join(temporary, 'outside.txt');
        await fs.writeFile(outside, 'unchanged');
        await fs.mkdir(destination);
        await fs.link(outside, path.join(destination, 'file.txt'));
        await unpack([{ name: 'file.txt', content: 'replacement' }]);
        expect(await fs.readFile(outside, 'utf8')).toBe('unchanged');
        expect(await fs.readFile(path.join(destination, 'file.txt'), 'utf8')).toBe('replacement');
    });

    it('rejects a pre-existing directory junction or symlink', async () => {
        const outside = path.join(temporary, 'outside');
        await fs.mkdir(outside);
        await fs.mkdir(destination);
        await fs.symlink(outside, path.join(destination, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
        await expect(unpack([{ name: 'link/escaped.txt', content: 'escaped' }])).rejects.toThrow();
        await expect(fs.access(path.join(outside, 'escaped.txt'))).rejects.toThrow();
    });

    it.each(['../escaped.txt', '/escaped.txt', 'C:/escaped.txt', 'dir\\escaped.txt', 'file.txt:stream', 'NUL.txt'])('rejects unsafe entry %s', async (name) => {
        await expect(unpack([{ name, content: 'escaped' }])).rejects.toThrow();
    });

    it('propagates an entry validator failure before writing that entry', async () => {
        await expect(unpack([{ name: 'unexpected.txt', content: 'data' }], {
            onEntry: () => { throw new Error('unexpected entry'); },
        })).rejects.toThrow('unexpected entry');
        await expect(fs.access(path.join(destination, 'unexpected.txt'))).rejects.toThrow();
    });
});
