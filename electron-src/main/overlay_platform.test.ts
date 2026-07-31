import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { resolveLinuxOzonePlatform, resolveLinuxOzoneRelaunch } = require(
    path.resolve(process.cwd(), 'GSM_Overlay/overlay_platform.js')
) as {
    resolveLinuxOzonePlatform: (options: {
        platform: NodeJS.Platform;
        env?: NodeJS.ProcessEnv;
        argv?: string[];
        electronVersion?: string;
        ozonePlatform?: string;
        ozonePlatformHint?: string;
        forceX11OnWayland?: boolean;
    }) => { platform: string; reason: string; appendSwitch?: boolean };
    resolveLinuxOzoneRelaunch: (
        argv: string[],
        env: NodeJS.ProcessEnv,
        platform: NodeJS.Platform,
        appReady: boolean,
        inProcess: boolean
    ) => { relaunch: boolean; args: string[] };
};

describe('overlay ozone self-relaunch', () => {
    it('injects X11 once while preserving the electron-forge app path first', () => {
        expect(
            resolveLinuxOzoneRelaunch(
                ['/usr/bin/electron', '.', '--inspect=9229'],
                { XDG_SESSION_TYPE: 'wayland' },
                'linux',
                false,
                false
            )
        ).toEqual({
            relaunch: true,
            args: ['.', '--inspect=9229', '--ozone-platform=x11', '--gsm-ozone-relaunch'],
        });
    });

    it('respects explicit user Wayland intent', () => {
        expect(
            resolveLinuxOzoneRelaunch(
                ['electron', '.', '--ozone-platform=wayland'],
                { XDG_SESSION_TYPE: 'wayland' },
                'linux',
                false,
                false
            ).relaunch
        ).toBe(false);
    });

    it('does not relaunch again when the argv marker is present', () => {
        expect(
            resolveLinuxOzoneRelaunch(
                ['electron', '.', '--ozone-platform=x11', '--gsm-ozone-relaunch'],
                { XDG_SESSION_TYPE: 'wayland' },
                'linux',
                false,
                false
            ).relaunch
        ).toBe(false);
    });

    it('skips relaunch in in-process mode', () => {
        expect(
            resolveLinuxOzoneRelaunch(
                ['electron', '.'],
                { XDG_SESSION_TYPE: 'wayland' },
                'linux',
                false,
                true
            ).relaunch
        ).toBe(false);
    });

    it('skips relaunch outside a Wayland session', () => {
        expect(
            resolveLinuxOzoneRelaunch(
                ['electron', '.'],
                { XDG_SESSION_TYPE: 'x11' },
                'linux',
                false,
                false
            ).relaunch
        ).toBe(false);
    });
});

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

    it('honors an explicit X11 environment hint on Electron 38+', () => {
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
        ).toBe('x11');
    });

    it('honors an explicit Wayland environment hint before the legacy default', () => {
        expect(
            resolveLinuxOzonePlatform({
                platform: 'linux',
                env: {
                    ELECTRON_OZONE_PLATFORM_HINT: 'wayland',
                    XDG_SESSION_TYPE: 'x11',
                },
                argv: ['electron'],
                electronVersion: '37.0.0',
            }).platform
        ).toBe('wayland');
    });

    it('ignores unsupported environment hint values', () => {
        expect(
            resolveLinuxOzonePlatform({
                platform: 'linux',
                env: {
                    ELECTRON_OZONE_PLATFORM_HINT: 'auto',
                    XDG_SESSION_TYPE: 'wayland',
                },
                argv: ['electron'],
                electronVersion: '42.3.2',
                forceX11OnWayland: true,
            })
        ).toMatchObject({ platform: 'x11', appendSwitch: true });
    });

    it('uses argv, rather than Electron’s self-injected command-line default, to choose standalone XWayland', () => {
        // Electron 42 reports --ozone-platform=wayland through app.commandLine
        // on Wayland sessions even when it was not present in process.argv.
        expect(
            resolveLinuxOzonePlatform({
                platform: 'linux',
                env: { XDG_SESSION_TYPE: 'wayland' },
                argv: ['electron'],
                electronVersion: '42.3.2',
                forceX11OnWayland: true,
            })
        ).toMatchObject({ platform: 'x11', appendSwitch: true });
    });

    it('lets an explicit Wayland hint override the standalone XWayland default', () => {
        expect(
            resolveLinuxOzonePlatform({
                platform: 'linux',
                env: { XDG_SESSION_TYPE: 'wayland' },
                argv: ['electron', '--ozone-platform-hint=wayland'],
                electronVersion: '42.3.2',
                forceX11OnWayland: true,
            })
        ).toMatchObject({ platform: 'wayland', appendSwitch: false });
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
