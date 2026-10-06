import { win32 } from 'node:path';

/** Resolve Windows utilities even when System32 is missing from the app's PATH. */
export function getWindowsSystemExecutable(filename: string): string {
    const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    return win32.join(systemRoot, 'System32', filename);
}
