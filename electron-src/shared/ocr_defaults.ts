export type OcrPlatform = 'win32' | 'darwin' | 'linux' | string;

export const DEFAULT_LOCAL_OCR = 'screenai';
export const DEFAULT_ADVANCED_MAIN_OCR = 'glens';

const RETIRED_OCR_ENGINES = new Set([
    'mlkitocr', 'local_llm_ocr', 'gemini', 'ocrspace', 'azure', 'easyocr', 'rapidocr',
    'groq', 'paddleocr', 'paddle_text_detector', 'opencv_east_text_detector', 'mangaocr', 'mangaocrs',
]);

export function replaceRetiredOcrEngine(engine: string): string {
    return typeof engine === 'string' && RETIRED_OCR_ENGINES.has(engine.trim().toLowerCase())
        ? DEFAULT_LOCAL_OCR : engine;
}

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
        const ocr1 = replaceRetiredOcrEngine(config.ocr1);
        const ocr2 = replaceRetiredOcrEngine(config.ocr2);
        return ocr1 === config.ocr1 && ocr2 === config.ocr2 ? config : { ...config, ocr1, ocr2 };
    }
    return {
        ...config,
        ocr1: getDefaultStabilityOcr(platform),
        ocr2: getBasicMainOcr(config.useOnlineOcr),
    };
}
