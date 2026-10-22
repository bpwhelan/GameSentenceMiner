import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const SNAPSHOT_NAME = /^\d{4}-\d{2}-\d{2}T[\d-]+Z-[a-f\d-]{36}$/;

export interface ObsSettingsSnapshot {
    path: string;
    fileCount: number;
}

interface ObsSettingsSnapshotOptions {
    keepCount?: number;
    relatedFiles?: Array<{ sourcePath: string; snapshotPath: string }>;
}

async function collectSettingsFiles(directory: string, relative = ''): Promise<string[]> {
    let entries;
    try {
        entries = await fs.readdir(path.join(directory, relative), { withFileTypes: true });
    } catch (error: any) {
        if (error?.code === 'ENOENT') return [];
        throw error;
    }
    const files: string[] = [];
    for (const entry of entries) {
        const name = path.join(relative, entry.name);
        if (entry.isDirectory()) {
            files.push(...await collectSettingsFiles(directory, name));
        } else if (entry.isFile() && !entry.name.endsWith('.tmp')) {
            files.push(name);
        }
    }
    return files;
}

/** Keep scene collections and recording profiles outside the mutable OBS config. */
export async function createObsSettingsSnapshot(
    obsConfigDir: string,
    backupDir: string,
    reason: string,
    options: ObsSettingsSnapshotOptions = {},
): Promise<ObsSettingsSnapshot | null> {
    const keepCount = options.keepCount ?? 20;
    if (!Number.isInteger(keepCount) || keepCount < 1) {
        throw new Error('At least one OBS settings snapshot must be retained.');
    }
    const source = path.resolve(obsConfigDir);
    const destination = path.resolve(backupDir);
    if (source === destination || path.relative(source, destination).split(path.sep)[0] === 'basic') {
        throw new Error('OBS snapshots must be stored outside the recording profiles and scene collections.');
    }
    const files = await collectSettingsFiles(source, 'basic');
    for (const file of ['global.ini', 'user.ini']) {
        try {
            if ((await fs.lstat(path.join(source, file))).isFile()) files.push(file);
        } catch (error: any) {
            if (error?.code !== 'ENOENT') throw error;
        }
    }
    if (!files.length) return null;
    const sources = files.map(file => ({ sourcePath: path.join(source, file), snapshotPath: file }));
    for (const file of options.relatedFiles ?? []) {
        if (path.isAbsolute(file.snapshotPath) || file.snapshotPath.split(/[\\/]/).includes('..') ||
            file.snapshotPath === 'snapshot.json') {
            throw new Error('Related OBS settings must remain inside their snapshot.');
        }
        try {
            if ((await fs.lstat(file.sourcePath)).isFile()) {
                sources.push(file);
                files.push(file.snapshotPath);
            }
        } catch (error: any) {
            if (error?.code !== 'ENOENT') throw error;
        }
    }

    await fs.mkdir(destination, { recursive: true });
    const name = `${new Date().toISOString().replaceAll(':', '-').replace('.', '-')}-${randomUUID()}`;
    const temporary = path.join(destination, `.pending-${randomUUID()}`);
    const target = path.join(destination, name);
    await fs.mkdir(temporary);
    try {
        for (const file of sources) {
            const snapshotFile = path.join(temporary, file.snapshotPath);
            await fs.mkdir(path.dirname(snapshotFile), { recursive: true });
            await fs.copyFile(file.sourcePath, snapshotFile);
        }
        await fs.writeFile(path.join(temporary, 'snapshot.json'), JSON.stringify({
            version: 1,
            createdAt: new Date().toISOString(),
            reason,
            files,
        }, null, 2), 'utf-8');
        await fs.rename(temporary, target);
    } catch (error) {
        // This is a freshly created directory directly inside the resolved backup root.
        await fs.rm(temporary, { recursive: true, force: true });
        throw error;
    }

    const snapshots = (await fs.readdir(destination, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && SNAPSHOT_NAME.test(entry.name))
        .map(entry => entry.name)
        .sort()
        .reverse();
    for (const expired of snapshots.slice(keepCount)) {
        const expiredPath = path.resolve(destination, expired);
        if (path.dirname(expiredPath) !== destination) {
            throw new Error('Refusing to remove an OBS snapshot outside the backup folder.');
        }
        await fs.rm(expiredPath, { recursive: true, force: true });
    }
    return { path: target, fileCount: files.length };
}
