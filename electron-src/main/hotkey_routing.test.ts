import { createRequire } from 'node:module';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
    isEffectiveInputServerHotkeyRouting,
    isWaylandSession,
} = require(path.resolve(process.cwd(), 'GSM_Overlay/hotkey_routing.js')) as {
    isEffectiveInputServerHotkeyRouting: (
        storedSetting: boolean,
        options: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv }
    ) => boolean;
    isWaylandSession: (options: {
        platform: NodeJS.Platform;
        env: NodeJS.ProcessEnv;
    }) => boolean;
};

describe('overlay hotkey routing', () => {
    it('routes KDE Wayland hotkeys through the portal-backed input service', () => {
        const options = {
            platform: 'linux' as const,
            env: {
                XDG_SESSION_TYPE: 'wayland',
                XDG_CURRENT_DESKTOP: 'KDE',
                WAYLAND_DISPLAY: 'wayland-0',
            },
        };

        expect(isWaylandSession(options)).toBe(true);
        expect(isEffectiveInputServerHotkeyRouting(false, options)).toBe(true);
    });

    it('keeps Electron routing on X11 unless the user explicitly opts in', () => {
        const options = {
            platform: 'linux' as const,
            env: { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' },
        };

        expect(isWaylandSession(options)).toBe(false);
        expect(isEffectiveInputServerHotkeyRouting(false, options)).toBe(false);
        expect(isEffectiveInputServerHotkeyRouting(true, options)).toBe(true);
    });

    it('does not infer Wayland from environment variables on another platform', () => {
        expect(
            isWaylandSession({
                platform: 'win32',
                env: { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0' },
            })
        ).toBe(false);
    });
});
