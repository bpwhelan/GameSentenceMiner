import { describe, expect, it } from 'vitest';
import { migrateLegacyNotificationPreferences, normalizeNotificationPreferences, resolveNotificationDelivery } from './notifications.js';

describe('notification preferences', () => {
    it('defaults routine confirmations to quiet sounds and warnings to banners', () => {
        const preferences = normalizeNotificationPreferences(null);
        expect(preferences.volume).toBe(15);
        expect(resolveNotificationDelivery('AnkiCardUpdated', preferences)).toMatchObject({ banner: false, sound: 'soft-ping' });
        expect(resolveNotificationDelivery('GSMTextIntakePaused', preferences)).toMatchObject({ banner: false, sound: 'descending' });
        expect(resolveNotificationDelivery('GSMTextIntakeResumed', preferences)).toMatchObject({ banner: false, sound: 'ascending' });
        expect(resolveNotificationDelivery('Error', preferences)).toMatchObject({ banner: true, sound: null });
    });

    it.each(['AnkiCardUpdated', 'AudioGenerated', 'ScreenshotSaved', 'AnkiEnhancementFailed', 'Error', 'CheckOBS', 'GSMTextIntakePaused', 'GSMTextIntakeResumed'] as const)(
        'migrates the old disabled switch for %s into its desktop group', (event) => {
            const features = { notify_on_update: false, notify_on_audio_generated: false, notify_on_screenshot_saved: false,
                notify_on_anki_enhancement_failed: false, notify_on_errors: false, notify_on_obs_warning: false, notify_on_text_intake_state: false };
            const preferences = migrateLegacyNotificationPreferences({ events: { [event]: { mode: 'both', sound: 'chime' } } }, features);
            expect(resolveNotificationDelivery(event, preferences)).toEqual({ banner: false, sound: null });
        },
    );

    it('supports off, banner, sound and both without treating volume zero as a banner request', () => {
        for (const [mode, banner, sound] of [['off', false, null], ['banner', true, null], ['sound', false, 'chime'], ['both', true, 'chime']] as const) {
            const preferences = normalizeNotificationPreferences({ events: { AnkiCardUpdated: { mode, sound: 'chime' } } });
            expect(resolveNotificationDelivery('AnkiCardUpdated', preferences)).toEqual({ banner, sound });
        }
        const muted = normalizeNotificationPreferences({ volume: 0 });
        expect(resolveNotificationDelivery('AnkiCardUpdated', muted)).toEqual({ banner: false, sound: null });
    });

    it('normalizes untrusted settings and fills partial categories', () => {
        const preferences = normalizeNotificationPreferences({ volume: 400, categories: {
            confirmation: { mode: 'sound', sound: '</script>' }, pauseResume: { mode: 'invalid', sound: 'bubble' }, appAlert: null,
        } });
        expect(preferences.volume).toBe(100);
        expect(preferences.categories.confirmation).toEqual({ mode: 'sound', sound: 'soft-ping' });
        expect(preferences.categories.pauseResume).toEqual({ mode: 'sound', sound: 'bubble' });
        expect(normalizeNotificationPreferences({ volume: NaN }).volume).toBe(15);
    });

    it('migrates per-event choices into four categories without coupling card errors to success or app alerts', () => {
        const preferences = normalizeNotificationPreferences({ volume: 8, events: {
            AnkiCardUpdated: { mode: 'off', sound: 'bell' }, AnkiEnhancementFailed: { mode: 'both', sound: 'double-tap' },
            GSMTextIntakeResumed: { mode: 'sound', sound: 'ascending' }, Error: { mode: 'off', sound: 'glass' },
        } });
        expect(Object.keys(preferences.categories)).toHaveLength(4);
        expect(preferences.volume).toBe(8);
        expect(resolveNotificationDelivery('AnkiCardUpdated', preferences)).toEqual({ banner: false, sound: null });
        expect(resolveNotificationDelivery('AudioGenerated', preferences)).toEqual({ banner: false, sound: null });
        expect(resolveNotificationDelivery('AnkiEnhancementFailed', preferences)).toEqual({ banner: true, sound: 'double-tap' });
        expect(resolveNotificationDelivery('CheckOBS', preferences)).toEqual({ banner: false, sound: null });
        expect(resolveNotificationDelivery('GSMTextIntakePaused', preferences)).toEqual(resolveNotificationDelivery('GSMTextIntakeResumed', preferences));
    });

    it('gives new category choices precedence over the old per-event choices', () => {
        const preferences = normalizeNotificationPreferences({ categories: { cardError: { mode: 'off' } }, events: { AnkiEnhancementFailed: { mode: 'both' } } });
        expect(resolveNotificationDelivery('AnkiEnhancementFailed', preferences)).toEqual({ banner: false, sound: null });
    });

    it('migrates the old review reminder switch into app alerts and preserves other sound choices', () => {
        const preferences = migrateLegacyNotificationPreferences({ volume: 7, categories: { confirmation: { mode: 'both', sound: 'chime' } } },
            { review_after_session: { notify_on_startup: false } });
        expect(preferences.categories.confirmation).toEqual({ mode: 'both', sound: 'chime' });
        expect(preferences.volume).toBe(7);
        expect(resolveNotificationDelivery('PendingSessionReviews', preferences)).toEqual({ banner: false, sound: null });
    });

    it('uses falling and rising tones for the paired pause/resume choice, including OCR', () => {
        const preferences = normalizeNotificationPreferences({ categories: { pauseResume: { mode: 'sound', sound: 'pause-resume' } } });
        for (const event of ['GSMTextIntakePaused', 'OCRPaused'] as const) {
            expect(resolveNotificationDelivery(event, preferences)).toEqual({ banner: false, sound: 'descending' });
        }
        for (const event of ['GSMTextIntakeResumed', 'OCRResumed'] as const) {
            expect(resolveNotificationDelivery(event, preferences)).toEqual({ banner: false, sound: 'ascending' });
        }
    });
});
