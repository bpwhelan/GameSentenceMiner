/** Presentation hints only: never discard text or select a hook based on these heuristics. */
export interface HookCandidate {
    id: string;
    function: string;
    preview: string;
    samples: string[];
}

export type HookQualityReason =
    | 'targetLanguage' | 'possibleLanguage' | 'readable' | 'mixed'
    | 'paths' | 'garbled' | 'repetitive' | 'symbols' | 'noText';

export interface HookQuality {
    score: number;
    reason: HookQualityReason;
    likelyNoise: boolean;
    hasText: boolean;
}

const MAX_SAMPLES = 5;
const MAX_SAMPLE_LENGTH = 2000;
const LETTER = /\p{L}/u;
const HAN = /\p{Script=Han}/u;
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HANGUL = /\p{Script=Hangul}/u;
const BROKEN_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ufffd\p{Co}\p{Cs}]/u;

// This is script compatibility, not language identification. In particular, do
// not try to distinguish languages sharing Latin/Cyrillic or reject rare kanji.
const SCRIPT_GROUPS = [
    ['Latin', 'en eng es spa fr fra de deu it ita pt por nl af sq az eu bs ca cs cy da et fi ga gl hr hu id is la lt lv ms mt no nb nn pl ro sk sl sv sw tl tr vi'],
    ['Cyrillic', 'ru rus uk ukr be bg mk sr kk ky mn tg'],
    ['Arabic', 'ar ara fa fas ur ps'],
    ['Greek', 'el ell'], ['Hebrew', 'he heb yi'], ['Thai', 'th tha'],
    ['Lao', 'lo'], ['Devanagari', 'hi hin mr ne sa'], ['Bengali', 'bn as'],
    ['Tamil', 'ta'], ['Telugu', 'te'], ['Kannada', 'kn'], ['Malayalam', 'ml'],
    ['Gujarati', 'gu'], ['Gurmukhi', 'pa'], ['Sinhala', 'si'], ['Khmer', 'km'],
    ['Myanmar', 'my'], ['Georgian', 'ka'], ['Armenian', 'hy'], ['Ethiopic', 'am ti'],
] as const;
const languageScripts = new Map<string, RegExp>();
const namedScripts = new Map<string, RegExp>();
for (const [script, languages] of SCRIPT_GROUPS) {
    const pattern = new RegExp(`\\p{Script=${script}}`, 'u');
    for (const language of languages.split(' ')) languageScripts.set(language, pattern);
    namedScripts.set(script.toLowerCase(), pattern);
}
// BCP-47 script overrides (for example Serbian written with Latin letters).
const scriptAliases: Record<string, string> = {
    latn: 'latin', cyrl: 'cyrillic', arab: 'arabic', deva: 'devanagari',
};

export function rememberHookSample(samples: readonly string[], text: string): string[] {
    const sample = text.slice(0, MAX_SAMPLE_LENGTH);
    if (!sample.trim()) return [...samples];
    return [...samples.filter((previous) => previous !== sample), sample].slice(-MAX_SAMPLES);
}

function quality(score: number, reason: HookQualityReason, likelyNoise = false): HookQuality {
    return { score, reason, likelyNoise, hasText: score >= 0 };
}

function looksTechnical(text: string): boolean {
    if (/^(?:[a-z]:[\\/]|\\\\|(?:https?|ftp|file|res|romfs):\/\/?|\/(?:[^/\s]+\/)|\.{1,2}[\\/])/iu.test(text)) return true;
    if (/^(?:\(unmanaged:[^()\r\n]+\.(?:dll|exe)\))+$/iu.test(text)) return true;
    // Some emulator APIs concatenate filenames and full paths without separators.
    const drivePath = text.search(/[a-z]:[\\/]/iu);
    if (drivePath > 0 && /^[\w.-]+\.(?:bin|dat|dll|exe)$/iu.test(text.slice(0, drivePath))) return true;
    if (/^(?:[^\s\\/:*?"<>|]+[\\/])*[^\s\\/:*?"<>|]+\.(?:exe|dll|bin|dat|pak|png|jpe?g|dds|bmp|ogg|wav|mp3|mp4|ttf|otf|json|xml|ini|log|ks|nsp|xci|assetbundle)$/iu.test(text)) return true;
    if (/^(?:0x[\da-f]{6,}|[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/iu.test(text)) return true;
    if (/^\[(?:debug|trace|info|warn(?:ing)?|error)\]/iu.test(text)) return true;
    if (text.length >= 16 && /^[\da-f]+$/iu.test(text) && /\d/u.test(text)) return true;
    return text.length >= 16 && /^[a-z][a-z\d]*_(?:[a-z\d]+_)*[a-z\d]+$/iu.test(text);
}

function languageScore(letters: string[], targetLanguage: string): number {
    if (letters.length < 3) return 0;
    const parts = targetLanguage.toLowerCase().replace(/_/gu, '-').split('-');
    const language = parts[0];
    const hanCount = letters.filter((char) => HAN.test(char)).length;
    const kanaCount = letters.filter((char) => KANA.test(char)).length;
    const hangulCount = letters.filter((char) => HANGUL.test(char)).length;
    if (language === 'ja' || language === 'jpn') {
        if ((hanCount + kanaCount) / letters.length < 0.6) return 0;
        return kanaCount > 0 ? 4 : 3;
    }
    if (['zh', 'zho', 'cmn', 'yue', 'wuu', 'nan', 'hak'].includes(language)) {
        return hanCount / letters.length >= 0.6 && kanaCount === 0 && hangulCount === 0 ? 4 : 0;
    }
    if (language === 'ko' || language === 'kor') {
        return hangulCount / letters.length >= 0.4 ? 4 : 0;
    }
    const scriptOverride = parts.find((part) => scriptAliases[part]);
    const script = scriptOverride
        ? namedScripts.get(scriptAliases[scriptOverride])
        : languageScripts.get(language);
    return script && letters.filter((char) => script.test(char)).length / letters.length >= 0.6 ? 4 : 0;
}

function assessLine(raw: string, targetLanguage: string): HookQuality {
    const text = raw.trim();
    if (!text) return quality(-1, 'noText');
    if (looksTechnical(text)) return quality(0, 'paths', true);

    const characters = Array.from(text).filter((char) => !/\s/u.test(char));
    const letters = characters.filter((char) => LETTER.test(char));
    const broken = characters.filter((char) => BROKEN_CHARACTER.test(char)).length;
    // Multiple replacement/control/private-use characters are stronger evidence
    // than a character outside the preferred language's writing system.
    if (broken >= 2 && broken / characters.length >= 0.2) return quality(0, 'garbled', true);
    const mojibake = text.match(/(?:Ã[\u0080-\u00bf]|Â[\u0080-\u00bf]|ã[\u0080-\u00bf\u2000-\u203f]{1,2}|â[\u0080-\u00bf\u2000-\u203f]{1,2}|ðŸ)/gu);
    if (mojibake && mojibake.length >= 3 && mojibake.join('').length / text.length > 0.4) {
        return quality(0, 'garbled', true);
    }
    if (broken > 0) return quality(1, 'garbled');

    // Repeated dialogue can be legitimate (screams, stutters, sound effects), so
    // lower its rank without hiding it. Short punctuation/names also stay visible.
    if (characters.length >= 24 && (/(.{1,6})\1{5,}/u.test(text) || /^(.{6,100})\1{2,}/u.test(text))) {
        return quality(1, 'repetitive');
    }
    // CamelCase telemetry identifiers can resemble names; demote, but do not hide.
    if (text.length >= 12 && /^(?:[A-Z][a-z\d]+){3,}$/u.test(text)) return quality(1, 'paths');
    if (letters.length === 0) {
        const symbols = characters.filter((char) => !/[\p{N}\p{M}]/u.test(char)).length;
        return quality(1, 'symbols', characters.length >= 12 && symbols / characters.length > 0.7);
    }
    if (characters.length >= 12 && letters.length / characters.length < 0.25) {
        return quality(0, 'symbols', true);
    }
    const match = languageScore(letters, targetLanguage);
    return quality(match || 2, match === 4 ? 'targetLanguage' : match === 3 ? 'possibleLanguage' : 'readable');
}

export function assessHookQuality(hook: Pick<HookCandidate, 'preview' | 'samples'>, targetLanguage: string): HookQuality {
    let samples = hook.samples.slice(-MAX_SAMPLES).map((text) => text.slice(0, MAX_SAMPLE_LENGTH));
    const preview = hook.preview.slice(0, MAX_SAMPLE_LENGTH).trim();
    const previewPrefix = preview.endsWith('…') ? preview.slice(0, -1) : preview;
    if (preview && !samples.some((sample) => sample.trim().startsWith(previewPrefix))) {
        samples = [...samples, preview].slice(-MAX_SAMPLES);
    }
    const results = samples.flatMap((sample) => sample.split(/\r?\n/u))
        .map((line) => assessLine(line, targetLanguage)).filter((result) => result.hasText);
    if (!results.length) return quality(-1, 'noText');
    const readable = results.filter((result) => result.score >= 2);
    if (readable.length) {
        const best = readable.reduce((a, b) => a.score >= b.score ? a : b);
        // One genuine dialogue sample is enough to rescue a hook. Mixed streams
        // remain available below consistently readable ones until noise ages out.
        return results.some((result) => result.likelyNoise) ? quality(1, 'mixed') : best;
    }
    const uncertain = results.find((result) => !result.likelyNoise);
    return uncertain ?? results[results.length - 1];
}

export function rankHookCandidates<T extends HookCandidate>(hooks: readonly T[], targetLanguage: string, selectedHookId: string | null) {
    return createHookRanker()(hooks, targetLanguage, selectedHookId);
}

/** Keep classification work proportional to changed hooks, even for large emulator lists. */
export function createHookRanker() {
    const cache = new Map<string, { preview: string; samples: string[]; quality: HookQuality }>();
    let cachedLanguage = '';
    return <T extends HookCandidate>(hooks: readonly T[], targetLanguage: string, selectedHookId: string | null) => {
        if (cachedLanguage !== targetLanguage) {
            cache.clear();
            cachedLanguage = targetLanguage;
        }
        const ids = new Set(hooks.map((hook) => hook.id));
        for (const id of cache.keys()) {
            if (!ids.has(id)) cache.delete(id);
        }
        return hooks.map((hook, index) => {
            const previous = cache.get(hook.id);
            const unchanged = previous && previous.preview === hook.preview
                && previous.samples.length === hook.samples.length
                && previous.samples.every((sample, sampleIndex) => sample === hook.samples[sampleIndex]);
            const result = unchanged ? previous.quality : assessHookQuality(hook, targetLanguage);
            if (!unchanged) cache.set(hook.id, { preview: hook.preview, samples: [...hook.samples], quality: result });
            return { hook, index, quality: result };
        }).sort((a, b) =>
            Number(b.hook.id === selectedHookId) - Number(a.hook.id === selectedHookId)
            || b.quality.score - a.quality.score
            || a.index - b.index);
    };
}
