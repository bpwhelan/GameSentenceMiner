import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron-log/main.js', async () => ({ default: (await import('electron-log/node.js')).default }));

import { initializeDesktopLogging, recordProcessOutput, rotateLogFile } from './logging.js';

const folders: string[] = [];
afterEach(() => {
    for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

describe('persistent desktop logging', () => {
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
