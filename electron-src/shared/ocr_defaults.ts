export type OcrPlatform = 'win32' | 'darwin' | 'linux' | string;

export const DEFAULT_LOCAL_OCR = 'screenai';

export function getDefaultStabilityOcr(_platform: OcrPlatform): string {
    return DEFAULT_LOCAL_OCR;
}

export function getBasicMainOcr(useOnlineOcr = false): string {
    return useOnlineOcr === true ? 'glens' : DEFAULT_LOCAL_OCR;
}

export function withBasicOcrPlatformDefaults<
    T extends { advancedMode?: boolean; useOnlineOcr?: boolean; ocr1: string; ocr2: string },
>(config: T, platform: OcrPlatform): T {
    if (config.advancedMode) {
        return config;
    }
    return {
        ...config,
        ocr1: getDefaultStabilityOcr(platform),
        ocr2: getBasicMainOcr(config.useOnlineOcr),
    };
}
