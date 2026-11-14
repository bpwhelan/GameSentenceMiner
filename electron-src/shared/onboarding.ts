export const ONBOARDING_VERSION = 2;
export const ONBOARDING_STEPS = ['language', 'dictionary', 'game', 'capture', 'finish'] as const;
export type OnboardingStep = typeof ONBOARDING_STEPS[number];
export interface OnboardingProgress {
    version: number;
    step: OnboardingStep;
    status: 'active' | 'paused' | 'completed';
}

export function initialOnboardingProgress(existingInstallation: boolean): OnboardingProgress {
    return { version: ONBOARDING_VERSION, step: 'language', status: existingInstallation ? 'paused' : 'active' };
}

export function normalizeOnboardingProgress(value: unknown): OnboardingProgress {
    const input = value as Partial<OnboardingProgress> | null;
    if (!input || !ONBOARDING_STEPS.includes(input.step as OnboardingStep)
        || !['active', 'paused', 'completed'].includes(input.status ?? '')) {
        throw new Error('Invalid setup progress.');
    }
    return { version: ONBOARDING_VERSION, step: input.step!, status: input.status! };
}

export interface DictionarySetupStatus {
    reader: 'yomitan' | 'hachidori';
    recommended: { name: string; homepage: string } | null;
    installed: string[];
    busy: boolean;
    stage?: 'downloading' | 'importing' | 'complete' | 'failed';
    error?: string;
    restarting?: boolean;
}

export interface SudachiSetupStatus {
    state: 'setup_required' | 'installing' | 'installed' | 'ready' | 'error';
    dictionary?: 'small' | 'core' | 'full';
    error?: string;
}

export interface OnboardingSnapshot {
    progress: OnboardingProgress;
    targetLanguage: string;
    locale: string;
}

export type OnboardingHomeAction = { id: number; action: 'game' | 'capture' };
