export const NOTIFICATION_SOUNDS = [
    'soft-ping', 'bell', 'bubble', 'wood', 'glass', 'success', 'ascending', 'descending', 'double-tap', 'chime', 'pause-resume',
    'marimba', 'sparkle', 'low-knock',
] as const;
export type NotificationSound = typeof NOTIFICATION_SOUNDS[number];
export const NOTIFICATION_MODES = ['off', 'sound', 'banner', 'both'] as const;
export type NotificationMode = typeof NOTIFICATION_MODES[number];

export const NOTIFICATION_EVENTS = {
    AnkiCardUpdated: { feature: 'notify_on_update', category: 'confirmation' },
    AudioGenerated: { feature: 'notify_on_audio_generated', category: 'confirmation' },
    ScreenshotSaved: { feature: 'notify_on_screenshot_saved', category: 'confirmation' },
    GSMTextIntakePaused: { feature: 'notify_on_text_intake_state', category: 'pauseResume' },
    GSMTextIntakeResumed: { feature: 'notify_on_text_intake_state', category: 'pauseResume' },
    OCRPaused: { feature: null, category: 'pauseResume' },
    OCRResumed: { feature: null, category: 'pauseResume' },
    AnkiEnhancementFailed: { feature: 'notify_on_anki_enhancement_failed', category: 'cardError' },
    CheckOBS: { feature: 'notify_on_obs_warning', category: 'appAlert' },
    Error: { feature: 'notify_on_errors', category: 'appAlert' },
    GSMReady: { feature: null, category: 'confirmation' },
    PendingSessionReviews: { feature: null, category: 'appAlert' },
} as const;
export type NotificationEvent = keyof typeof NOTIFICATION_EVENTS;
export const NOTIFICATION_EVENT_IDS = Object.keys(NOTIFICATION_EVENTS) as NotificationEvent[];
export const NOTIFICATION_CATEGORIES = {
    confirmation: { mode: 'sound', sound: 'soft-ping', legacyEvents: ['AnkiCardUpdated', 'AudioGenerated', 'ScreenshotSaved', 'GSMReady'] },
    cardError: { mode: 'banner', sound: 'double-tap', legacyEvents: ['AnkiEnhancementFailed'] },
    pauseResume: { mode: 'sound', sound: 'pause-resume', legacyEvents: ['GSMTextIntakePaused', 'GSMTextIntakeResumed'] },
    appAlert: { mode: 'banner', sound: 'double-tap', legacyEvents: ['Error', 'CheckOBS', 'PendingSessionReviews'] },
} as const;
export type NotificationCategory = keyof typeof NOTIFICATION_CATEGORIES;
export const NOTIFICATION_CATEGORY_IDS = Object.keys(NOTIFICATION_CATEGORIES) as NotificationCategory[];
export interface NotificationEventPreference { mode: NotificationMode; sound: NotificationSound }
export interface NotificationPreferences {
    volume: number;
    categories: Record<NotificationCategory, NotificationEventPreference>;
}

function asObject(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function isNotificationSound(value: unknown): value is NotificationSound {
    return NOTIFICATION_SOUNDS.includes(value as NotificationSound);
}

export function normalizeNotificationVolume(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 15;
}

export function normalizeNotificationPreferences(value: unknown): NotificationPreferences {
    const input = asObject(value);
    const categories = asObject(input.categories);
    const legacyEvents = asObject(input.events);
    return {
        volume: normalizeNotificationVolume(input.volume),
        categories: Object.fromEntries(NOTIFICATION_CATEGORY_IDS.map((category) => {
            const defaults = NOTIFICATION_CATEGORIES[category];
            // Preserve the primary choice when collapsing the previous per-event controls.
            const legacy = defaults.legacyEvents.map((event) => legacyEvents[event]).find((value) => Object.keys(asObject(value)).length > 0);
            const preference = asObject(categories[category] ?? legacy);
            return [category, {
                mode: NOTIFICATION_MODES.includes(preference.mode as NotificationMode) ? preference.mode : defaults.mode,
                sound: isNotificationSound(preference.sound) && (preference.sound !== 'pause-resume' || category === 'pauseResume')
                    ? preference.sound : defaults.sound,
            }];
        })) as NotificationPreferences['categories'],
    };
}

export function resolveNotificationDelivery(
    event: NotificationEvent, preferences: NotificationPreferences,
): { banner: boolean; sound: NotificationSound | null } {
    const { mode, sound } = preferences.categories[NOTIFICATION_EVENTS[event].category];
    const resolvedSound = sound === 'pause-resume' ? (event.endsWith('Paused') ? 'descending' : 'ascending') : sound;
    return {
        banner: mode === 'banner' || mode === 'both',
        sound: preferences.volume > 0 && (mode === 'sound' || mode === 'both') ? resolvedSound : null,
    };
}

/** Only used once; old switches must never override subsequent desktop choices. */
export function migrateLegacyNotificationPreferences(value: unknown, legacyFeatures: Record<string, unknown>): NotificationPreferences {
    const preferences = normalizeNotificationPreferences(value);
    for (const event of NOTIFICATION_EVENT_IDS) {
        const { feature, category } = NOTIFICATION_EVENTS[event];
        if (feature && legacyFeatures[feature] === false) preferences.categories[category].mode = 'off';
    }
    if (asObject(legacyFeatures.review_after_session).notify_on_startup === false) preferences.categories.appAlert.mode = 'off';
    return preferences;
}

export interface NotificationTone { frequency: number; duration: number; delay?: number; endFrequency?: number; harmonic?: number }
export const NOTIFICATION_TONES: Record<NotificationSound, NotificationTone[]> = {
    'soft-ping': [{ frequency: 880, duration: 0.24 }],
    bell: [{ frequency: 660, duration: 0.48, harmonic: 2.76 }],
    bubble: [{ frequency: 420, endFrequency: 960, duration: 0.15 }],
    wood: [{ frequency: 360, duration: 0.07, harmonic: 1.48 }],
    glass: [{ frequency: 1320, duration: 0.32, harmonic: 2.01 }],
    success: [{ frequency: 660, duration: 0.16 }, { frequency: 880, duration: 0.26, delay: 0.12 }],
    ascending: [{ frequency: 523.25, duration: 0.15 }, { frequency: 783.99, duration: 0.22, delay: 0.1 }],
    descending: [{ frequency: 783.99, duration: 0.15 }, { frequency: 523.25, duration: 0.22, delay: 0.1 }],
    'double-tap': [{ frequency: 520, duration: 0.08 }, { frequency: 520, duration: 0.08, delay: 0.13 }],
    chime: [{ frequency: 523.25, duration: 0.32 }, { frequency: 659.25, duration: 0.32, delay: 0.1 }, { frequency: 783.99, duration: 0.42, delay: 0.2 }],
    marimba: [{ frequency: 392, duration: 0.14, harmonic: 4 }, { frequency: 523.25, duration: 0.23, delay: 0.08, harmonic: 4 }],
    sparkle: [{ frequency: 1046.5, duration: 0.11 }, { frequency: 1318.51, duration: 0.13, delay: 0.06 }, { frequency: 1567.98, duration: 0.24, delay: 0.12 }],
    'low-knock': [{ frequency: 340, endFrequency: 180, duration: 0.13, harmonic: 2.3 }],
    'pause-resume': [
        { frequency: 783.99, duration: 0.15 }, { frequency: 523.25, duration: 0.22, delay: 0.1 },
        { frequency: 523.25, duration: 0.15, delay: 0.5 }, { frequency: 783.99, duration: 0.22, delay: 0.6 },
    ],
};

/** Self contained so the hidden Electron audio page can use the same synthesis code. */
export function synthesizeNotificationSound(context: AudioContext, tones: NotificationTone[], volume: number): void {
    const start = context.currentTime + 0.01;
    for (const tone of tones) {
        for (const [ratio, level] of [[1, 1], ...(tone.harmonic ? [[tone.harmonic, 0.18]] : [])]) {
            const oscillator = context.createOscillator();
            const gain = context.createGain();
            const at = start + (tone.delay ?? 0);
            oscillator.type = 'sine';
            oscillator.frequency.setValueAtTime(tone.frequency * ratio, at);
            if (tone.endFrequency) oscillator.frequency.exponentialRampToValueAtTime(tone.endFrequency * ratio, at + tone.duration);
            // Short attack and decay avoid clicks; full volume is deliberately gentle.
            gain.gain.setValueAtTime(0, at);
            gain.gain.linearRampToValueAtTime((volume / 100) * 0.24 * level, at + 0.008);
            gain.gain.exponentialRampToValueAtTime(0.0001, at + tone.duration);
            gain.gain.linearRampToValueAtTime(0, at + tone.duration + 0.01);
            oscillator.connect(gain);
            gain.connect(context.destination);
            oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
            oscillator.start(at);
            oscillator.stop(at + tone.duration + 0.02);
        }
    }
}
