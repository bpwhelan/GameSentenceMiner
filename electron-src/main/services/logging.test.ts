import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import extract from 'extract-zip';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron-log/main.js', async () => ({ default: (await import('electron-log/node.js')).default }));

import { initializeDesktopLogging, recordProcessOutput, rotateLogFile, captureRendererDiagnostics } from './logging.js';
import { InstallSessionManager } from './install_session.js';
import { createAnonymizedLogsArchive } from './log_archive.js';

const folders: string[] = [];
afterEach(() => {
    for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

describe('persistent desktop logging', () => {
    it('appends renderer diagnostics and startup context in a custom data folder without echoing back to the renderer', () => {
        const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-logging-'));
        folders.push(folder);
        const originalConsole = { ...console };
        try {
            initializeDesktopLogging(folder);
            console.error(new Error('Previous session failure'));
            initializeDesktopLogging(folder);
            const contents = Object.assign(new EventEmitter(), { id: 7 });
            captureRendererDiagnostics(contents as unknown as WebContents);
            captureRendererDiagnostics(contents as unknown as WebContents);
            expect(contents.listenerCount('console-message')).toBe(1);
            const consoleError = vi.spyOn(console, 'error');
            contents.emit('console-message', { level: 'error', message: 'Renderer setup failed', sourceId: 'app.js', lineNumber: 42 });
            contents.emit('preload-error', {}, 'preload.js', new Error('Preload unavailable'));
            contents.emit('did-fail-load', {}, -6, 'FILE_NOT_FOUND', 'file:///index.html', true);
            contents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'file:///previous.html', true);
            expect(consoleError).not.toHaveBeenCalled();
            const output = fs.readFileSync(path.join(folder, 'logs', 'desktop.log'), 'utf8');
            expect(output).toContain('Previous session failure');
            expect(output).toContain(process.versions.node);
            expect(output).toContain('Renderer setup failed');
            expect(output).toContain('app.js:42');
            expect(output).toContain('Preload unavailable');
            expect(output).toContain('FILE_NOT_FOUND');
            expect(output).not.toContain('ERR_ABORTED');
        } finally {
            vi.restoreAllMocks();
            Object.assign(console, originalConsole);
        }
    });

    it('includes installation diagnostics and their history in anonymized exports', async () => {
        const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-logging-'));
        folders.push(folder);
        const originalConsole = { ...console };
        try {
            initializeDesktopLogging(folder);
            const session = new InstallSessionManager();
            session.startSession('repair');
            session.updateStage({ stageId: 'lock_sync', status: 'failed', error: 'Dependency download failed' });
            session.finishActive('failed');
            recordProcessOutput('setup:1234', 'stderr', 'HTTP 403 token=private-token');
            rotateLogFile(path.join(folder, 'logs', 'desktop.log'));
            console.info('Next session after failed update');
            const archive = path.join(folder, 'export.zip');
            await createAnonymizedLogsArchive(path.join(folder, 'logs'), archive);
            const extracted = path.join(folder, 'exported');
            await extract(archive, { dir: extracted });
            expect(fs.readFileSync(path.join(extracted, 'desktop.log'), 'utf8')).toContain('Next session');
            expect(fs.readFileSync(path.join(extracted, 'history', 'desktop.log.1'), 'utf8')).toContain('Dependency download failed');
            const output = fs.readFileSync(path.join(extracted, 'process-output.log'), 'utf8');
            expect(output).toContain('HTTP 403');
            expect(output).toContain('[REDACTED]');
            expect(output).not.toContain('private-token');
        } finally {
            Object.assign(console, originalConsole);
        }
    });

    it('bounds rotations in the history folder', () => {
        const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-logging-'));
        folders.push(folder);
        const file = path.join(folder, 'desktop.log');
        for (let index = 0; index < 8; index++) {
            fs.writeFileSync(file, `session ${index}`);
            rotateLogFile(file, 2);
        }
        expect(fs.readdirSync(path.join(folder, 'history')).sort()).toEqual(['desktop.log.1', 'desktop.log.2']);
        expect(fs.readFileSync(path.join(folder, 'history', 'desktop.log.2'), 'utf8')).toBe('session 6');
    });

    it('captures desktop console and early child failures without ANSI escape codes', () => {
        const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-logging-'));
        folders.push(folder);
        const originalConsole = { ...console };
        try {
            initializeDesktopLogging(folder);
            console.warn('desktop diagnostic');
            recordProcessOutput('ocr', 'stderr', '\x1b[31mImportError: missing engine\x1b[0m\n');
            recordProcessOutput('ocr', 'lifecycle', 'crashed');
        } finally {
            Object.assign(console, originalConsole);
        }
        expect(fs.readFileSync(path.join(folder, 'logs', 'desktop.log'), 'utf8')).toContain('desktop diagnostic');
        const output = fs.readFileSync(path.join(folder, 'logs', 'process-output.log'), 'utf8');
        expect(output).toContain('[ocr stderr] ImportError: missing engine');
        expect(output).toContain('[ocr lifecycle] crashed');
        expect(output).not.toContain('\x1b');
    });
});
