import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
    configureLinuxDesktopIdentity,
    LINUX_DESKTOP_NAME,
    resolveLinuxDesktopIdentity,
} from './linux_desktop_identity.js';

describe('Linux desktop identity', () => {
    it('prefers the stable packaged desktop entry when it is installed', () => {
        const stablePath = `/home/test/.local/share/applications/${LINUX_DESKTOP_NAME}`;

        expect(
            resolveLinuxDesktopIdentity({
                platform: 'linux',
                env: { HOME: '/home/test' },
                executablePath: '/downloads/GameSentenceMiner-2026.8.3.AppImage',
                argv0: '/downloads/GameSentenceMiner-2026.8.3.AppImage',
                fileExists: (candidate) => candidate === stablePath,
            })
        ).toEqual({
            appId: 'com.beangate.gamesentenceminer',
            desktopName: LINUX_DESKTOP_NAME,
        });
    });

    it('uses an installed AppImage desktop entry when the stable entry is absent', () => {
        const versionedName = 'GameSentenceMiner-2026.8.3-beta.1.AppImage.desktop';
        const versionedPath = path.join('/home/test/.local/share/applications', versionedName);

        expect(
            resolveLinuxDesktopIdentity({
                platform: 'linux',
                env: { HOME: '/home/test' },
                executablePath: '/downloads/GameSentenceMiner-2026.8.3-beta.1.AppImage',
                argv0: '/downloads/GameSentenceMiner-2026.8.3-beta.1.AppImage',
                fileExists: (candidate) => candidate === versionedPath,
            })
        ).toEqual({
            appId: 'GameSentenceMiner-2026.8.3-beta.1.AppImage',
            desktopName: versionedName,
        });
    });

    it('does not configure a desktop identity on other platforms', () => {
        expect(
            resolveLinuxDesktopIdentity({
                platform: 'win32',
                env: {},
                executablePath: 'C:\\GSM\\GameSentenceMiner.exe',
                argv0: 'C:\\GSM\\GameSentenceMiner.exe',
                fileExists: () => false,
            })
        ).toBeNull();
    });

    it('falls back to CHROME_DESKTOP when Electron lacks setDesktopName', () => {
        const env: NodeJS.ProcessEnv = { HOME: '/home/test' };

        expect(
            configureLinuxDesktopIdentity({}, {
                platform: 'linux',
                env,
                fileExists: () => false,
            })
        ).toEqual({
            appId: 'com.beangate.gamesentenceminer',
            desktopName: LINUX_DESKTOP_NAME,
        });
        expect(env.CHROME_DESKTOP).toBe(LINUX_DESKTOP_NAME);
        expect(env.GSM_INPUT_SERVER_APP_ID).toBe('com.beangate.gamesentenceminer');
    });
});
