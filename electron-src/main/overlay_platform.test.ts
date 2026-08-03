import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
    isXWaylandOverlayEnvironment,
    resolveLinuxOzonePlatform,
    resolveLinuxOzoneRelaunch,
} = require(
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
    isXWaylandOverlayEnvironment: (options: {
        platform: NodeJS.Platform;
        env: NodeJS.ProcessEnv;
        ozonePlatform: string;
    }) => boolean;
};

describe('XWayland overlay capability gate', () => {
    const platforms = ['win32', 'darwin', 'linux'] as const;
    const sessions = ['wayland', 'x11'] as const;
    const ozonePlatforms = ['x11', 'wayland'] as const;
    const overrides = [undefined, '0', '1'] as const;

    it.each(
        platforms.flatMap((platform) =>
            sessions.flatMap((session) =>
                ozonePlatforms.flatMap((ozonePlatform) =>
                    overrides.map((override) => ({ platform, session, ozonePlatform, override }))
                )
            )
        )
    )('resolves $platform/$session/ozone-$ozonePlatform/override-$override', ({
        platform,
        session,
        ozonePlatform,
        override,
    }) => {
        const env: NodeJS.ProcessEnv = {
            XDG_SESSION_TYPE: session,
            XDG_CURRENT_DESKTOP: 'GNOME',
        };
        if (override !== undefined) env.GSM_OVERLAY_XWAYLAND_FEATURES = override;
        const detected = platform === 'linux' && session === 'wayland' && ozonePlatform === 'x11';
        const expected = override === '0' ? false : detected;

        expect(isXWaylandOverlayEnvironment({ platform, env, ozonePlatform })).toBe(expected);
    });

    it('treats WAYLAND_DISPLAY as a Wayland session signal', () => {
        expect(isXWaylandOverlayEnvironment({
            platform: 'linux',
            env: { WAYLAND_DISPLAY: 'wayland-0', XDG_CURRENT_DESKTOP: 'GNOME' },
            ozonePlatform: 'x11',
        })).toBe(true);
    });

    it.each(['KDE', 'sway', 'Hyprland', 'COSMIC'])(
        'does not enable GNOME overlay compatibility by default on %s Wayland',
        (desktop) => {
            expect(isXWaylandOverlayEnvironment({
                platform: 'linux',
                env: { XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: desktop },
                ozonePlatform: 'x11',
            })).toBe(false);
        }
    );

    it('allows another Wayland compositor to explicitly opt in', () => {
        expect(isXWaylandOverlayEnvironment({
            platform: 'linux',
            env: {
                XDG_SESSION_TYPE: 'wayland',
                XDG_CURRENT_DESKTOP: 'COSMIC',
                GSM_OVERLAY_XWAYLAND_FEATURES: '1',
            },
            ozonePlatform: 'x11',
        })).toBe(true);
    });

    it.each([
        [{ XDG_SESSION_TYPE: 'x11', XDG_CURRENT_DESKTOP: 'GNOME' }, 'x11'],
        [{ XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'GNOME' }, 'wayland'],
    ] as const)(
        'does not let opt-in bypass the required Wayland/X11 backend combination',
        (env, ozonePlatform) => {
            expect(isXWaylandOverlayEnvironment({
                platform: 'linux',
                env: { ...env, GSM_OVERLAY_XWAYLAND_FEATURES: '1' },
                ozonePlatform,
            })).toBe(false);
        }
    );
});

describe('overlay ozone self-relaunch', () => {
    it('injects X11 once while preserving the electron-forge app path first', () => {
        expect(
            resolveLinuxOzoneRelaunch(
                ['/usr/bin/electron', '.', '--inspect=9229'],
                { XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'GNOME' },
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
                { XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'GNOME' },
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
                { XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'GNOME' },
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
                { XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'GNOME' },
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

    it('does not relaunch when XWayland overlay features are forced off', () => {
        expect(
            resolveLinuxOzoneRelaunch(
                ['electron', '.'],
                {
                    XDG_SESSION_TYPE: 'wayland',
                    XDG_CURRENT_DESKTOP: 'GNOME',
                    GSM_OVERLAY_XWAYLAND_FEATURES: '0',
                },
                'linux',
                false,
                false
            ).relaunch
        ).toBe(false);
    });

    it('detects the native backend after force-off suppresses the standalone relaunch', () => {
        expect(resolveLinuxOzonePlatform({
            platform: 'linux',
            env: {
                XDG_SESSION_TYPE: 'wayland',
                XDG_CURRENT_DESKTOP: 'GNOME',
                GSM_OVERLAY_XWAYLAND_FEATURES: '0',
            },
            argv: ['electron'],
            electronVersion: '42.3.2',
            forceX11OnWayland: true,
        }).platform).toBe('wayland');
    });

    it.each(['KDE', 'sway', 'Hyprland', 'COSMIC'])(
        'does not relaunch %s Wayland under X11 by default',
        (desktop) => {
            expect(resolveLinuxOzoneRelaunch(
                ['electron', '.'],
                { XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: desktop },
                'linux',
                false,
                false
            ).relaunch).toBe(false);
        }
    );

    it('keeps a non-GNOME Wayland session on Electron’s native backend by default', () => {
        expect(resolveLinuxOzonePlatform({
            platform: 'linux',
            env: { XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'KDE' },
            argv: ['electron'],
            electronVersion: '42.3.2',
            forceX11OnWayland: true,
        })).toMatchObject({ platform: 'wayland' });
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

    it('does not mistake a removed environment hint for the Electron 38+ backend', () => {
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

    it('translates an Electron 38+ X11 environment preference into a relaunch switch', () => {
        expect(resolveLinuxOzoneRelaunch(
            ['electron', '.'],
            {
                ELECTRON_OZONE_PLATFORM_HINT: 'x11',
                XDG_SESSION_TYPE: 'wayland',
                XDG_CURRENT_DESKTOP: 'GNOME',
            },
            'linux',
            false,
            false
        )).toEqual({
            relaunch: true,
            args: ['.', '--ozone-platform=x11', '--gsm-ozone-relaunch'],
        });
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
                    XDG_CURRENT_DESKTOP: 'GNOME',
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
                env: { XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'GNOME' },
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
