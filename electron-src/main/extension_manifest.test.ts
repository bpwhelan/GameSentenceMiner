import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { parseExtensionManifest } = require(
    path.resolve(process.cwd(), 'GSM_Overlay/extension_manifest.js')
) as {
    parseExtensionManifest: (manifestText: string) => { version?: string };
};

describe('extension manifest parsing', () => {
    it('accepts manifests with a UTF-8 BOM', () => {
        expect(parseExtensionManifest('\uFEFF{"version":"1.2.3"}')).toEqual({ version: '1.2.3' });
    });
});
