import { describe, expect, it } from 'vitest';

import {
    findWindowSceneSwitcherCandidates,
    getForegroundWindowContextKey,
    matchWindowSceneRule,
    validateWindowTitlePattern,
    type ForegroundWindowSnapshot,
    type WindowSceneSwitcherRule,
} from './window_scene_switcher.js';

const FOREGROUND: ForegroundWindowSnapshot = {
    hwnd: '100',
    pid: 42,
    title: 'yuzu Early Access 5000 | ANONYMOUS;CODE (64-bit)',
    executableName: 'yuzu.exe',
    capturedAt: 1,
    sequence: 1,
};

function rule(overrides: Partial<WindowSceneSwitcherRule> = {}): WindowSceneSwitcherRule {
    return {
        sceneUuid: 'scene-1',
        sceneName: 'ANONYMOUS;CODE',
        titlePattern: 'ANONYMOUS;CODE',
        executableName: 'yuzu.exe',
        enabled: true,
        source: 'manual',
        ...overrides,
    };
}

describe('window scene switcher matching', () => {
    it('matches title patterns case-insensitively with a verified executable', () => {
        expect(matchWindowSceneRule(rule(), FOREGROUND)).toEqual({
            matched: true,
            executableVerified: true,
        });
    });

    it('does not match a readable but different executable', () => {
        expect(matchWindowSceneRule(rule({ executableName: 'other.exe' }), FOREGROUND)).toEqual({
            matched: false,
            executableVerified: true,
        });
    });

    it('falls back to the title when Windows cannot read the executable', () => {
        const withoutExecutable = { ...FOREGROUND, executableName: '', executablePath: '' };
        expect(matchWindowSceneRule(rule(), withoutExecutable)).toEqual({
            matched: true,
            executableVerified: false,
        });
    });

    it('keeps a foreground context stable when executable metadata becomes available', () => {
        expect(
            getForegroundWindowContextKey({
                ...FOREGROUND,
                executableName: '',
                executablePath: '',
            })
        ).toBe(getForegroundWindowContextKey(FOREGROUND));
    });

    it('deduplicates multiple matching rules for the same scene', () => {
        const candidates = findWindowSceneSwitcherCandidates(
            [rule(), rule({ titlePattern: 'yuzu.*', executableName: undefined })],
            FOREGROUND
        );
        expect(candidates).toHaveLength(1);
        expect(candidates[0]?.sceneUuid).toBe('scene-1');
    });

    it('rejects invalid regular expressions', () => {
        expect(validateWindowTitlePattern('[')).toContain('Unterminated');
    });
});
