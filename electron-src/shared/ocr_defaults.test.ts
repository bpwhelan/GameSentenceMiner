import { describe, expect, it } from 'vitest';

import {
    getDefaultStabilityOcr,
    withBasicOcrPlatformDefaults,
} from './ocr_defaults.js';

describe('OCR platform defaults', () => {
    it('uses Meiki Text Detector as the Windows stability OCR default', () => {
        expect(getDefaultStabilityOcr('win32')).toBe('meiki_text_detector');
    });

    it('preserves the existing macOS and Linux defaults', () => {
        expect(getDefaultStabilityOcr('darwin')).toBe('alivetext');
        expect(getDefaultStabilityOcr('linux')).toBe('meiki_text_detector');
    });

    it('overrides stored engines in basic mode', () => {
        expect(
            withBasicOcrPlatformDefaults(
                { advancedMode: false, ocr1: 'oneocr', ocr2: 'bing' },
                'win32'
            )
        ).toEqual({
            advancedMode: false,
            ocr1: 'meiki_text_detector',
            ocr2: 'glens',
        });
    });

    it('preserves explicitly selected advanced engines', () => {
        const config = { advancedMode: true, ocr1: 'oneocr', ocr2: 'bing' };

        expect(withBasicOcrPlatformDefaults(config, 'win32')).toBe(config);
    });
});
