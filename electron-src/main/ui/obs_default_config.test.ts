import { describe, expect, it } from 'vitest';

import {
    buildObsReplayBufferProfileIni,
    repairObsReplayBufferProfileIni,
} from './obs_default_config.js';

describe('buildObsReplayBufferProfileIni', () => {
    it('writes Windows paths without OBS INI escape sequences', () => {
        const ini = buildObsReplayBufferProfileIni(
            'C:\\Users\\nyanspruk\\Videos\\GSM'
        );

        expect(ini).toContain('FilePath=C:/Users/nyanspruk/Videos/GSM\n');
        expect(ini).not.toContain('\\n');
    });
});

describe('repairObsReplayBufferProfileIni', () => {
    const defaultPath = String.raw`C:\Users\nyanspruk/Videos/GSM`;

    it.each([
        ['the original seed', String.raw`C:\Users\nyanspruk/Videos/GSM`],
        ['an OBS-resaved seed', String.raw`C:\\Users\nyanspruk/Videos/GSM`],
    ])('repairs %s containing an OBS newline escape', (_label, storedPath) => {
        const ini = `[SimpleOutput]\nFilePath=${storedPath}\nRecRB=true\n`;

        expect(repairObsReplayBufferProfileIni(ini, defaultPath)).toBe(
            '[SimpleOutput]\nFilePath=C:/Users/nyanspruk/Videos/GSM\nRecRB=true\n'
        );
    });

    it('preserves a custom recording path', () => {
        const ini = String.raw`[SimpleOutput]
FilePath=D:\\Recordings
RecRB=true
`;

        expect(repairObsReplayBufferProfileIni(ini, defaultPath)).toBe(ini);
    });
});
