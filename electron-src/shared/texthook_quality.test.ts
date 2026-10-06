import { describe, expect, it } from 'vitest';
import { assessHookQuality, createHookRanker, rankHookCandidates, rememberHookSample } from './texthook_quality.js';

function hook(id: string, text: string, samples = [text]) {
    return { id, function: `Hook #${id}`, preview: text, samples };
}

describe('hook candidate quality', () => {
    it('ranks target-language dialogue above other readable text and paths', () => {
        const hooks = [
            hook('path', 'C:\\Games\\日本語\\data\\scene.ks'),
            hook('english', 'Welcome back to the village.'),
            hook('name', '山田太郎'),
            hook('japanese', '「今日は一緒に帰ろう。」'),
        ];
        expect(rankHookCandidates(hooks, 'ja-JP', null).map(({ hook }) => hook.id))
            .toEqual(['japanese', 'name', 'english', 'path']);
        expect(hooks[0].id).toBe('path');
    });

    it.each([
        ['zh-Hant', '我們一起回家吧。', 'これは日本語です。'],
        ['ko', '오늘 같이 집에 가자.', '日本語の文章です。'],
        ['en', 'Let us go home together.', '今日は一緒に帰ろう。'],
        ['uk', 'Сьогодні ми підемо додому разом.', '今日は一緒に帰ろう。'],
        ['ru', 'Давай пойдём домой вместе.', '今日は一緒に帰ろう。'],
        ['es', 'Volvamos a casa juntos.', '今日は一緒に帰ろう。'],
        ['ar', 'لنعد إلى المنزل معا', '今日は一緒に帰ろう。'],
        ['th', 'กลับบ้านด้วยกันเถอะ', '今日は一緒に帰ろう。'],
    ])('uses the configured %s writing system', (language, preferred, other) => {
        expect(rankHookCandidates([hook('other', other), hook('target', preferred)], language, null)
            .map(({ hook }) => hook.id)).toEqual(['target', 'other']);
        expect(assessHookQuality(hook('other', other), language).likelyNoise).toBe(false);
    });

    it.each([
        'C:\\Program Files\\Game\\日本語\\data.bin',
        '\\\\server\\share\\game.dat',
        '/home/player/game/assets/menu.png',
        'assets/ui/title.dds',
        'https://example.com/assets/config.json',
        'romfs:/data/scenario/scene.ks',
        '0x00007FFDEADBEEF0',
        'a32b556a-75c9-4abd-9426-f6705e37981c',
        '\ufffd\ufffd\ufffd\ufffd\u0001\u0002',
        '\ue000\ue001\ue002\ue003\ue004\ue005',
        'ã“ã‚“ã«ã¡ã¯',
        '%$#@}{|%$#@}{|',
        '(unmanaged:qwindows.dll)(unmanaged:qwindows.dll)(unmanaged:qwindows.dll)',
        'playtime.binplaytime.binC:/Users/player/AppData/Roaming/yuzu/nand/system/Contents/data.bin',
    ])('soft hides obvious noise: %s', (text) => {
        expect(assessHookQuality(hook('noise', text), 'ja').likelyNoise).toBe(true);
    });

    it.each([
        '……', '！', 'あ', 'Alice', '123', 'はい/いいえ',
        '「セーブは C:\\Games\\save.dat にあるよ。」',
        'Open the file at C:\\Games\\save.dat to continue.',
        '𠮷野さん、おはよう。', 'Hello 👋', 'Cafe\u0301',
        'ああああああああああああああああああああああああああああ！',
        'Hello\nworld\t!',
    ])('keeps short, unusual, or mixed dialogue available: %s', (text) => {
        expect(assessHookQuality(hook('dialogue', text), 'ja').likelyNoise).toBe(false);
    });

    it('never hides a hook with readable dialogue among noisy samples or lines', () => {
        const path = 'C:\\Game\\data.bin';
        const dialogue = '今日はいい天気ですね。';
        expect(assessHookQuality(hook('mixed', path, [dialogue, path]), 'ja').likelyNoise).toBe(false);
        expect(assessHookQuality(hook('mixed', `${path}\n${dialogue}`), 'ja').likelyNoise).toBe(false);
        expect(assessHookQuality(hook('recovering', dialogue, [path, path, path]), 'ja').likelyNoise).toBe(false);
    });

    it('downgrades repeated diagnostics and technical identifiers without hiding ambiguous text', () => {
        for (const text of ['Given lParam is not UiaRootObjectId'.repeat(8), 'PlayTimeReport']) {
            const result = assessHookQuality(hook('diagnostic', text), 'en');
            expect(result.score).toBeLessThan(2);
            expect(result.likelyNoise).toBe(false);
        }
    });

    it('does not count a truncated preview as another sample', () => {
        const text = '今日は一緒に帰りましょう。'.repeat(10);
        const path = 'C:\\Game\\data.bin';
        expect(assessHookQuality(hook('same', `${text.slice(0, 80)}…`, [path, text]), 'ja'))
            .toEqual(assessHookQuality(hook('same', '', [path, text]), 'ja'));
    });

    it('pins the selected hook and preserves discovery order within a quality tier', () => {
        const hooks = [hook('noise', '\ufffd'.repeat(20)), hook('a', 'おはよう。'), hook('b', 'こんにちは。')];
        expect(rankHookCandidates(hooks, 'ja', 'noise').map(({ hook }) => hook.id)).toEqual(['noise', 'a', 'b']);
        expect(rankHookCandidates(hooks, 'ja', null).map(({ hook }) => hook.id)).toEqual(['a', 'b', 'noise']);
    });

    it('falls back to readability for unknown languages and leaves empty hooks unclassified', () => {
        expect(assessHookQuality(hook('empty', '', []), 'ja').hasText).toBe(false);
        const quality = assessHookQuality(hook('text', 'こんにちは。'), 'unknown');
        expect(quality.reason).toBe('readable');
        expect(quality.likelyNoise).toBe(false);
    });

    it('keeps a bounded recent history so startup noise ages out', () => {
        let samples = ['C:\\Game\\data.bin'];
        for (let index = 0; index < 7; index += 1) {
            samples = rememberHookSample(samples, `こんにちは。${index}`);
        }
        expect(samples).toHaveLength(5);
        expect(samples[0]).toBe('こんにちは。2');
        expect(assessHookQuality(hook('recovered', '', samples), 'ja').reason).toBe('targetLanguage');
        expect(rememberHookSample(samples, samples[4])).toEqual(samples);
        expect(rememberHookSample([], 'x'.repeat(100_000))[0].length).toBeLessThanOrEqual(2000);
        expect(rememberHookSample(samples, '   ')).toEqual(samples);
    });

    it('reuses unchanged classifications and invalidates them for new samples or language', () => {
        const rank = createHookRanker();
        const entry = hook('1', 'C:\\Game\\data.bin');
        const first = rank([entry], 'ja', null)[0].quality;
        expect(rank([{ ...entry, samples: [...entry.samples] }], 'ja', '1')[0].quality).toBe(first);
        entry.samples.push('こんにちは。');
        const recovered = rank([entry], 'ja', null)[0].quality;
        expect(recovered).not.toBe(first);
        expect(recovered.likelyNoise).toBe(false);
        const dialogue = hook('1', 'こんにちは。');
        expect(rank([dialogue], 'ja', null)[0].quality.reason).toBe('targetLanguage');
        expect(rank([dialogue], 'en', null)[0].quality.reason).toBe('readable');
        rank([], 'en', null);
        expect(rank([hook('1', '\ufffd'.repeat(10))], 'en', null)[0].quality.likelyNoise).toBe(true);
    });
});
