import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ensureWineFridaServer } from './wine_frida.js';

const tempRoots: string[] = [];
const originalX86Override = process.env.GSM_FRIDA_SERVER_X86_PATH;
const originalX64Override = process.env.GSM_FRIDA_SERVER_X64_PATH;

function makeTempFile(name: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-wine-frida-'));
    tempRoots.push(root);
    const filePath = path.join(root, name);
    fs.writeFileSync(filePath, 'test server');
    return filePath;
}

afterEach(() => {
    if (originalX86Override === undefined) delete process.env.GSM_FRIDA_SERVER_X86_PATH;
    else process.env.GSM_FRIDA_SERVER_X86_PATH = originalX86Override;
    if (originalX64Override === undefined) delete process.env.GSM_FRIDA_SERVER_X64_PATH;
    else process.env.GSM_FRIDA_SERVER_X64_PATH = originalX64Override;
    for (const root of tempRoots.splice(0)) {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

describe('ensureWineFridaServer', () => {
    it('uses an explicit architecture-specific server override', async () => {
        const serverPath = makeTempFile('custom-frida-server.exe');
        process.env.GSM_FRIDA_SERVER_X64_PATH = serverPath;

        await expect(ensureWineFridaServer('x64')).resolves.toBe(serverPath);
    });

    it('reports an invalid override instead of silently downloading another server', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-wine-frida-'));
        tempRoots.push(root);
        const missingPath = path.join(root, 'missing-frida-server.exe');
        process.env.GSM_FRIDA_SERVER_X86_PATH = missingPath;

        await expect(ensureWineFridaServer('x86')).rejects.toThrow(
            `GSM_FRIDA_SERVER_X86_PATH does not point to a readable file: ${missingPath}`,
        );
    });
});
