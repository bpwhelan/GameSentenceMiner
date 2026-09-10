const DEFAULT_TEXT_HOOK_MAX_BUFFER_SIZE = 3000;
export const MAX_TEXT_HOOK_MAX_BUFFER_SIZE = 100_000;
export const HARD_TEXT_HOOK_REJECTION_LIMIT = 10_000;
export const MAX_JAPANESE_QUOTE_PAIRS = 10;

let runtimeMaxBufferSize = DEFAULT_TEXT_HOOK_MAX_BUFFER_SIZE;

export function normalizeTextHookMaxBufferSize(value: unknown): number {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_TEXT_HOOK_MAX_BUFFER_SIZE;
    return Math.min(MAX_TEXT_HOOK_MAX_BUFFER_SIZE, Math.round(parsed));
}

export function setRuntimeTextHookMaxBufferSize(value: unknown): number {
    runtimeMaxBufferSize = normalizeTextHookMaxBufferSize(value);
    return runtimeMaxBufferSize;
}

function hasExcessiveJapaneseQuotePairs(text: string): boolean {
    let openingQuotes = 0;
    let closingQuotes = 0;
    for (const character of text) {
        if (character === '「') openingQuotes += 1;
        if (character === '」') closingQuotes += 1;
        if (openingQuotes > MAX_JAPANESE_QUOTE_PAIRS && closingQuotes > MAX_JAPANESE_QUOTE_PAIRS) {
            return true;
        }
    }
    return false;
}

export function sanitizeTextHookText(
    text: string,
    maxBufferSize: number = runtimeMaxBufferSize,
): { text: string; truncated: boolean } | null {
    if (text.length > HARD_TEXT_HOOK_REJECTION_LIMIT) return null;
    if (hasExcessiveJapaneseQuotePairs(text)) return null;
    const limit = normalizeTextHookMaxBufferSize(maxBufferSize);
    return {
        text: text.slice(0, limit),
        truncated: text.length > limit,
    };
}

export const DEFAULT_MAX_BUFFER_SIZE = DEFAULT_TEXT_HOOK_MAX_BUFFER_SIZE;
