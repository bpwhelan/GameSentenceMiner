import { describe, expect, it } from 'vitest';

import {
    getBackendUpdateDecision,
    requiresBackendStartupPreparation,
    selectLatestCompatibleVersion,
} from './backend_version.js';

describe('selectLatestCompatibleVersion', () => {
    it('selects the newest non-yanked post release in the bundled compatibility window', () => {
        expect(
            selectLatestCompatibleVersion('2026.7.4', {
                '2026.7.4': [{ yanked: false }],
                '2026.7.4.post1': [{ yanked: false }],
                '2026.7.4.post2': [{ yanked: true }],
                '2026.7.4.post3': [{ yanked: false }],
                '2026.7.5': [{ yanked: false }],
            })
        ).toBe('2026.7.4.post3');
    });
});

describe('getBackendUpdateDecision', () => {
    it('does nothing when the installed backend is already the selected version', () => {
        expect(
            getBackendUpdateDecision('2026.7.4', '2026.7.4', '2026.7.4')
        ).toEqual({ updateAvailable: false, latestVersion: '2026.7.4' });
    });

    it('upgrades when a newer compatible post release is selected', () => {
        expect(
            getBackendUpdateDecision('2026.7.4.post1', '2026.7.4', '2026.7.4.post2')
        ).toEqual({ updateAvailable: true, latestVersion: '2026.7.4.post2' });
    });

    it('repairs an incompatible installed backend even without a post release', () => {
        expect(
            getBackendUpdateDecision('2026.7.3', '2026.7.4', '2026.7.4')
        ).toEqual({ updateAvailable: true, latestVersion: '2026.7.4' });
    });
});

describe('requiresBackendStartupPreparation', () => {
    it('takes the fast launch path for an installed compatible backend', () => {
        expect(
            requiresBackendStartupPreparation('2026.7.4.post2', '2026.7.4', false)
        ).toBe(false);
    });

    it('prepares the environment when the backend is missing or incompatible', () => {
        expect(requiresBackendStartupPreparation(null, '2026.7.4', false)).toBe(true);
        expect(
            requiresBackendStartupPreparation('2026.7.3', '2026.7.4', false)
        ).toBe(true);
    });

    it('does not replace an installed prerelease backend during normal startup', () => {
        expect(
            requiresBackendStartupPreparation('2026.7.4-beta.1', '2026.7.4', true)
        ).toBe(false);
    });
});

describe('isBackendVersionCompatible', () => {
    it('treats the PEP 440 wheel version as compatible with the Electron beta version', async () => {
        const { isBackendVersionCompatible } = await import('./backend_version.js');

        expect(isBackendVersionCompatible('2026.8.13b1', '2026.8.13-beta.1')).toBe(true);
    });
});
