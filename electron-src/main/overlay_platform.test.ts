import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { resolveLinuxOzonePlatform } = require(
    path.resolve(process.cwd(), 'GSM_Overlay/overlay_platform.js')
) as {
    resolveLinuxOzonePlatform: (options: {
        platform: NodeJS.Platform;
        env?: NodeJS.ProcessEnv;
        argv?: string[];
        electronVersion?: string;
        ozonePlatform?: string;
        ozonePlatformHint?: string;
    }) => { platform: string; reason: string };
};

describe('overlay ozone platform detection', () => {
    it('honors an explicit X11 override inside a Wayland desktop session', () => {
        expect(
            resolveLinuxOzonePlatform({
                platform: 'linux',
                env: { XDG_SESSION_TYPE: 'wayland' },
                argv: ['electron', '--ozone-platform=x11'],
                electronVersion: '42.3.2',
            }).platform
        ).toBe('x11');
    });

    it.each([
        [['electron', '--ozone-platform=wayland'], {}, 'command-line platform'],
        [['electron', '--ozone-platform-hint', 'wayland'], {}, 'command-line hint'],
        [['electron'], { ELECTRON_OZONE_PLATFORM_HINT: 'wayland' }, 'environment hint'],
    ] as const)('detects native Wayland from the %s (%s)', (argv, env) => {
        expect(
            resolveLinuxOzonePlatform({
                platform: 'linux',
                env,
                argv: [...argv],
                electronVersion: '37.0.0',
            }).platform
        ).toBe('wayland');
    });

    it('accounts for Electron 38+ selecting Wayland from XDG_SESSION_TYPE by default', () => {
        expect(
            resolveLinuxOzonePlatform({
                platform: 'linux',
                env: { XDG_SESSION_TYPE: 'wayland' },
                argv: ['electron'],
                electronVersion: '42.3.2',
            }).platform
        ).toBe('wayland');
    });

    it('ignores the removed environment hint on Electron 38+', () => {
        expect(
            resolveLinuxOzonePlatform({
                platform: 'linux',
                env: {
                    ELECTRON_OZONE_PLATFORM_HINT: 'x11',
                    XDG_SESSION_TYPE: 'wayland',
                },
                argv: ['electron'],
                electronVersion: '42.3.2',
            }).platform
        ).toBe('wayland');
    });

    it('keeps the legacy X11 default for older Electron releases', () => {
        expect(
            resolveLinuxOzonePlatform({
                platform: 'linux',
                env: { XDG_SESSION_TYPE: 'wayland' },
                argv: ['electron'],
                electronVersion: '37.0.0',
            }).platform
        ).toBe('x11');
    });
});
