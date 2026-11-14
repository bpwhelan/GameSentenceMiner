import { describe, expect, it } from 'vitest';
import { initialOnboardingProgress, normalizeOnboardingProgress } from './onboarding.js';

describe('onboarding migration', () => {
  it('offers first-run setup to new profiles without interrupting existing installations', () => {
    expect(initialOnboardingProgress(false).status).toBe('active');
    expect(initialOnboardingProgress(true).status).toBe('paused');
  });
  it('preserves a resumable step and rejects invalid states', () => {
    expect(normalizeOnboardingProgress({ step: 'capture', status: 'paused' })).toEqual({ version: 2, step: 'capture', status: 'paused' });
    expect(() => normalizeOnboardingProgress({ step: 'unknown', status: 'completed' })).toThrow();
    expect(() => normalizeOnboardingProgress(null)).toThrow();
  });
});
