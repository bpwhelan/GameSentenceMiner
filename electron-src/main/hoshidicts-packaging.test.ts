import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const requireModule = createRequire(import.meta.url);
const forgeConfig = requireModule('../../GSM_Overlay/forge.config.js');

describe('HoshiDicts Forge packaging', () => {
    it('keeps only runtime provenance from the native source tree in app.asar', () => {
        const ignore = forgeConfig.packagerConfig.ignore as (filePath: string) => boolean;

        expect(ignore('/hoshidicts_host')).toBe(false);
        expect(ignore('/hoshidicts_host/provenance.json')).toBe(false);
        expect(ignore('/hoshidicts_host/src/main.cpp')).toBe(true);
        expect(ignore('/hoshidicts_host/vendor/hoshidicts/LICENSE')).toBe(true);
        expect(ignore('/hoshidicts_host/bin/linux-x64/gsm_hoshidicts_host')).toBe(true);
    });

    it('adds the executable, manifest, provenance, notices, and licenses as resources', () => {
        const resources = (forgeConfig.packagerConfig.extraResource as string[]).map(
            (resource) => resource.replaceAll('\\', '/'),
        );
        const executable =
            process.platform === 'win32'
                ? 'gsm_hoshidicts_host.exe'
                : 'gsm_hoshidicts_host';

        expect(resources.some((resource) => resource.endsWith(`/${executable}`))).toBe(
            true,
        );
        expect(
            resources.some((resource) =>
                resource.endsWith('/hoshidicts-host-manifest.json'),
            ),
        ).toBe(true);
        expect(
            resources.some((resource) =>
                resource.endsWith('/hoshidicts-provenance.json'),
            ),
        ).toBe(true);
        expect(
            resources.some((resource) => resource.endsWith('/THIRD_PARTY_NOTICES.md')),
        ).toBe(true);
        expect(resources.some((resource) => resource.endsWith('/licenses'))).toBe(
            true,
        );
    });
});
