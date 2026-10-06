import { describe, expect, it } from 'vitest';

import {
    getDefaultStabilityOcr,
    withBasicOcrPlatformDefaults,
} from './ocr_defaults.js';

describe('OCR platform defaults', () => {
    it.each(['win32', 'darwin', 'linux'])('uses local ScreenAI on %s', (platform) => {
        expect(getDefaultStabilityOcr(platform)).toBe('screenai');
    });

    it('overrides stored engines in basic mode', () => {
        expect(
            withBasicOcrPlatformDefaults(
                { advancedMode: false, ocr1: 'oneocr', ocr2: 'bing' },
                'win32'
            )
        ).toEqual({
            advancedMode: false,
            ocr1: 'screenai',
            ocr2: 'screenai',
        });
    });

    it('preserves explicitly selected advanced engines', () => {
        const config = { advancedMode: true, ocr1: 'oneocr', ocr2: 'bing' };

        expect(withBasicOcrPlatformDefaults(config, 'win32')).toBe(config);
    });

    it.each(['win32', 'darwin', 'linux'])('requires explicit online opt-in on %s', (platform) => {
        const config = { advancedMode: false, ocr1: 'oneocr', ocr2: 'glens', useOnlineOcr: true };
        expect(withBasicOcrPlatformDefaults(config, platform)).toEqual({
            ...config, ocr1: 'screenai', ocr2: 'glens',
        });
        expect(withBasicOcrPlatformDefaults({ ...config, useOnlineOcr: false }, platform).ocr2).toBe('screenai');
    });
});
