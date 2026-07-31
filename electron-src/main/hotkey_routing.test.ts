import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
    isEffectiveInputServerHotkeyRouting,
    isWaylandSession,
} = require(path.resolve(process.cwd(), 'GSM_Overlay/hotkey_routing.js')) as {
    isEffectiveInputServerHotkeyRouting: (
        storedSetting: unknown,
        options?: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv }
    ) => boolean;
    isWaylandSession: (options?: {
        platform?: NodeJS.Platform;
        env?: NodeJS.ProcessEnv;
    }) => boolean;
};

describe('hotkey routing', () => {
    it.each([
        [{ XDG_SESSION_TYPE: 'wayland' }, 'session type'],
        [{ XDG_SESSION_TYPE: 'Wayland' }, 'case-insensitive session type'],
        [{ WAYLAND_DISPLAY: 'wayland-0' }, 'Wayland display'],
    ])('detects Linux Wayland from the %s environment (%s)', (env) => {
        expect(isWaylandSession({ platform: 'linux', env })).toBe(true);
    });

    it.each(['win32', 'darwin'] as const)(
        'never treats %s as Wayland even when Wayland variables are present',
        (platform) => {
            expect(
                isWaylandSession({
                    platform,
                    env: { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0' },
                })
            ).toBe(false);
        }
    );

    it('does not treat an X11 Linux session as Wayland', () => {
        expect(
            isWaylandSession({
                platform: 'linux',
                env: { XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '' },
            })
        ).toBe(false);
    });

    it('forces input-server routing on Wayland without changing the stored value', () => {
        const settings = { routeAllHotkeysThroughInputServer: false };

        expect(
            isEffectiveInputServerHotkeyRouting(settings.routeAllHotkeysThroughInputServer, {
                platform: 'linux',
                env: { XDG_SESSION_TYPE: 'wayland' },
            })
        ).toBe(true);
        expect(settings.routeAllHotkeysThroughInputServer).toBe(false);
    });

    it.each([
        [true, 'linux', { XDG_SESSION_TYPE: 'x11' }, true],
        [false, 'linux', { XDG_SESSION_TYPE: 'x11' }, false],
        [true, 'win32', { XDG_SESSION_TYPE: 'wayland' }, true],
        [false, 'darwin', { WAYLAND_DISPLAY: 'wayland-0' }, false],
    ] as const)(
        'keeps stored=%s behavior on %s outside Wayland',
        (storedSetting, platform, env, expected) => {
            expect(
                isEffectiveInputServerHotkeyRouting(storedSetting, { platform, env })
            ).toBe(expected);
        }
    );
});
