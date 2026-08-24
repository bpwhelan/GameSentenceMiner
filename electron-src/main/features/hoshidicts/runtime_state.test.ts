import { beforeEach, describe, expect, it } from 'vitest';

import {
    createDefaultHoshidictsPopupButtons,
    DEFAULT_HOSHIDICTS_CUSTOM_POPUP_CSS,
} from '../../../shared/features/hoshidicts.js';
import {
    configureHoshidictsRuntime,
    getAppliedHoshidictsReaderPreferences,
    getHoshidictsEnabledAtLaunch,
    isHoshidictsAudioRestartRequired,
    markHoshidictsAudioProfileApplied,
    markHoshidictsAudioProfileSyncFailed,
    markHoshidictsOverlayLaunched,
    markHoshidictsReaderPreferencesApplied,
    resetHoshidictsRuntimeState,
} from './runtime_state.js';
import { makeHoshidictsReaderPreferences } from './test_helpers.js';

let overlayRunning = true;

beforeEach(() => {
    overlayRunning = true;
    configureHoshidictsRuntime({ overlayRunning: () => overlayRunning });
    resetHoshidictsRuntimeState();
});

describe('Hoshidicts overlay runtime state', () => {
    // The launch environment carries no popup buttons and no custom CSS, so the
    // overlay starts with their defaults regardless of what is saved. Recording
    // the saved values instead would suppress the restart prompt forever if the
    // control channel never connected.
    it('records the launch default only for custom CSS, which the environment cannot carry', () => {
        const preferences = makeHoshidictsReaderPreferences({
            theme: 'girlypop',
            customPopupCss: ':scope { color: hotpink; }',
            popupButtons: {
                addToAnki: false,
                audio: false,
                customDefinition: false,
                viewInAnki: true,
                customLinks: [
                    { label: 'Jisho', url: 'https://jisho.org/search/%w' },
                ],
            },
        });

        markHoshidictsOverlayLaunched({ enabled: true, preferences });

        const applied = getAppliedHoshidictsReaderPreferences();
        expect(applied?.theme).toBe('girlypop');
        // Only customPopupCss is dropped, so the restart prompt is accurate at
        // launch instead of firing for every non-default popup-button choice.
        expect(applied?.customPopupCss).toBe(DEFAULT_HOSHIDICTS_CUSTOM_POPUP_CSS);
        expect(applied?.popupButtons).toEqual(preferences.popupButtons);
    });

    it('records the delivered values once the reader applies them', () => {
        const preferences = makeHoshidictsReaderPreferences({
            customPopupCss: ':scope { color: hotpink; }',
        });
        markHoshidictsOverlayLaunched({ enabled: true, preferences });

        expect(markHoshidictsReaderPreferencesApplied(preferences)).toBe(true);

        expect(getAppliedHoshidictsReaderPreferences()?.customPopupCss).toBe(
            ':scope { color: hotpink; }'
        );
    });

    it('hands back copies so callers cannot mutate the recorded state', () => {
        markHoshidictsOverlayLaunched({
            enabled: true,
            preferences: makeHoshidictsReaderPreferences(),
        });

        const applied = getAppliedHoshidictsReaderPreferences();
        applied!.popupButtons.addToAnki = false;
        applied!.definitionBlur.enabled = true;

        const reread = getAppliedHoshidictsReaderPreferences();
        expect(reread?.popupButtons.addToAnki).toBe(true);
        expect(reread?.definitionBlur.enabled).toBe(false);
    });

    it('forgets everything once the overlay stops', () => {
        markHoshidictsOverlayLaunched({
            enabled: true,
            preferences: makeHoshidictsReaderPreferences(),
        });
        markHoshidictsAudioProfileSyncFailed();
        expect(isHoshidictsAudioRestartRequired()).toBe(true);

        overlayRunning = false;

        expect(getHoshidictsEnabledAtLaunch()).toBeNull();
        expect(getAppliedHoshidictsReaderPreferences()).toBeNull();
        expect(isHoshidictsAudioRestartRequired()).toBe(false);
        expect(markHoshidictsReaderPreferencesApplied(
            makeHoshidictsReaderPreferences()
        )).toBe(false);
        expect(markHoshidictsAudioProfileApplied()).toBe(false);
        expect(markHoshidictsAudioProfileSyncFailed()).toBe(false);

        // Restarting must not resurrect the state the stopped overlay dropped.
        overlayRunning = true;
        expect(getAppliedHoshidictsReaderPreferences()).toBeNull();
        expect(getHoshidictsEnabledAtLaunch()).toBeNull();
    });

    it('clears the audio restart flag once the profile is delivered', () => {
        markHoshidictsOverlayLaunched({
            enabled: true,
            preferences: makeHoshidictsReaderPreferences(),
        });
        markHoshidictsAudioProfileSyncFailed();

        expect(markHoshidictsAudioProfileApplied()).toBe(true);
        expect(isHoshidictsAudioRestartRequired()).toBe(false);
    });
});
