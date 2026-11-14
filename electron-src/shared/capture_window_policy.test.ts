import { describe, expect, it } from 'vitest';
import { getGameInfoFromWindow, shouldFilterWindow } from './capture_window_policy.js';
describe('getGameInfoFromWindow', () => {
    it.each([
        'Lichii | v0.0.4 | MSVC 19.44 | ANONYMOUS;CODE (64-bit) | 1.0.0 | NVIDIA',
        'lichii | v0.0.4 | ANONYMOUS;CODE (32-bit) | 1.0.0 | NVIDIA',
        'Lichii | v0.0.4 | ANONYMOUS;CODE | 1.0.0 | NVIDIA',
    ])('extracts a stable game name and switcher pattern from %s', async (rawTitle) => {
        
        const result = getGameInfoFromWindow(rawTitle);
        const switcherPattern = new RegExp(result.switcherRegex, 'i');

        expect(result.sceneName).toBe('ANONYMOUS;CODE');
        expect(result.switcherRegex).not.toContain('v0.0.4');
        expect(rawTitle).toMatch(switcherPattern);
        expect(rawTitle.replace('v0.0.4', 'v0.0.5').replace('NVIDIA', 'AMD')).toMatch(switcherPattern);
        expect(rawTitle.replace('ANONYMOUS;CODE', 'Another Game')).not.toMatch(switcherPattern);
    });

    it('extracts game names from yuzu Early Access titles', async () => {
        
        const rawTitle =
            'yuzu Early Access 4175 | ANONYMOUS;CODE (64-bit) | 1.0.0 | NVIDIA';

        const result = getGameInfoFromWindow(rawTitle);
        const switcherPattern = new RegExp(result.switcherRegex, 'i');

        expect(result.sceneName).toBe('ANONYMOUS;CODE');
        expect(result.switcherRegex).not.toContain('4175');
        expect(rawTitle).toMatch(switcherPattern);
        expect(
            'yuzu Early Access 5000 | ANONYMOUS;CODE (64-bit) | 1.1.0 | AMD'
        ).toMatch(switcherPattern);
    });
});

describe('shouldFilterWindow', () => {
    it.each([
        ['Eden Configuration', 'Eden.exe'],
        ['yuzu Configuration', 'yuzu.exe'],
        ['Lichii Configuration', 'lichii.exe'],
        ['Lichii Configuration - Settings', 'LICHII.EXE'],
    ])('filters the %s dialog', async (title, executable) => {
        

        expect(
            shouldFilterWindow({
                itemName: title,
                itemValue: `${title}:Qt5152QWindowIcon:${executable}`,
            })
        ).toBe(true);
    });

    it.each(['Eden', 'Lichii'])('keeps a %s game window available', async (emulator) => {
        

        expect(
            shouldFilterWindow({
                itemName: `${emulator} | v0.0.4 | ANONYMOUS;CODE (64-bit)`,
                itemValue: `${emulator} | v0.0.4 | ANONYMOUS;CODE (64-bit):Qt5152QWindowIcon:${emulator}.exe`,
            })
        ).toBe(false);
    });
});

