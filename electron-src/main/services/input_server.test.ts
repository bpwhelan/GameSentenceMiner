import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
    app: { isPackaged: false },
}));

import {
    DEFAULT_INPUT_SERVER_PORT,
    buildInputServerEnvironment,
    getInputServerExecutableCandidates,
    selectNewestInputServerExecutable,
    shouldSuppressInputServerLine,
} from './input_server.js';

describe('input server lifecycle helpers', () => {
    it('prefers source builds in development', () => {
        expect(
            getInputServerExecutableCandidates({
                isDev: true,
                resourcesDir: 'C:\\repo',
                overlayResourcesDir: 'C:\\overlay\\resources',
                platform: 'win32',
            })
        ).toEqual([
            'C:\\repo\\GSM_Overlay\\input_server\\target\\debug\\gsm_overlay_server.exe',
            'C:\\repo\\GSM_Overlay\\input_server\\target\\release\\gsm_overlay_server.exe',
            'C:\\repo\\GSM_Overlay\\input_server\\bin\\gsm_overlay_server.exe',
        ]);
    });

    it('uses the staged overlay resource in packaged builds', () => {
        expect(
            getInputServerExecutableCandidates({
                isDev: false,
                resourcesDir: 'C:\\app\\resources',
                overlayResourcesDir: 'C:\\app\\resources\\GSM_Overlay\\resources',
                platform: 'win32',
            })
        ).toEqual([
            'C:\\app\\resources\\GSM_Overlay\\resources\\gsm_overlay_server.exe',
        ]);
    });

    it('exports one stable endpoint for Electron children', () => {
        expect(buildInputServerEnvironment(DEFAULT_INPUT_SERVER_PORT)).toEqual({
            GSM_INPUT_SERVER_MANAGED: '1',
            GSM_INPUT_SERVER_PORT: '7276',
            GSM_INPUT_SERVER_URL: 'ws://127.0.0.1:7276',
        });
    });

    it('uses the newest available development build', () => {
        const modifiedTimes: Record<string, number> = {
            'debug.exe': 10,
            'release.exe': 30,
            'bin.exe': 20,
        };

        expect(
            selectNewestInputServerExecutable(
                ['debug.exe', 'release.exe', 'bin.exe'],
                (candidate) => modifiedTimes[candidate]
            )
        ).toBe('release.exe');
    });

    it.each([
        '2026-07-18T05:30:51.562859Z  INFO client connected: 127.0.0.1:52021',
        '2026-07-18T05:30:51.563376Z  INFO client disconnected: 127.0.0.1:52021',
    ])('suppresses routine client connection chatter: %s', (line) => {
        expect(shouldSuppressInputServerLine(line)).toBe(true);
    });

    it.each([
        '2026-07-18T05:30:51.562859Z  WARN client disconnected unexpectedly: 127.0.0.1:52021',
        '2026-07-18T05:30:51.562859Z  INFO listening on 127.0.0.1:7276',
        'client connected: 127.0.0.1:52021',
    ])('preserves other input server output: %s', (line) => {
        expect(shouldSuppressInputServerLine(line)).toBe(false);
    });
});
