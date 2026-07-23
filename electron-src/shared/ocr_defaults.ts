export type OcrPlatform = 'win32' | 'darwin' | 'linux' | string;

export const WINDOWS_DEFAULT_STABILITY_OCR = 'meiki_text_detector';

export function getDefaultStabilityOcr(platform: OcrPlatform): string {
    if (platform === 'win32') {
        return WINDOWS_DEFAULT_STABILITY_OCR;
    }
    if (platform === 'darwin') {
        return 'alivetext';
    }
    if (platform === 'linux') {
        return 'meiki_text_detector';
    }
    return 'oneocr';
}

export function withBasicOcrPlatformDefaults<
    T extends { advancedMode?: boolean; ocr1: string; ocr2: string },
>(config: T, platform: OcrPlatform): T {
    if (config.advancedMode) {
        return config;
    }
    return {
        ...config,
        ocr1: getDefaultStabilityOcr(platform),
        ocr2: 'glens',
    };
}
