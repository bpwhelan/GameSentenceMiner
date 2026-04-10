import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

const regexPatternsModulePath = path.resolve(
    process.cwd(),
    'GameSentenceMiner/web/static/js/regex-patterns.js'
);

async function loadRegexPatternsModule() {
    return import(pathToFileURL(regexPatternsModulePath).href);
}

describe('regex preset patterns module', () => {
    it('exports helpers used by the advanced search preset picker', async () => {
        const module = await loadRegexPatternsModule();

        expect(module.getPattern('everything')).toBe('.*');
        expect(module.getPattern('missing-pattern')).toBeNull();
        expect(module.getPatternOptions()).toContainEqual({
            value: 'empty_lines',
            label: 'Empty or whitespace-only lines',
        });
    });

    it('keeps preset pattern strings valid for RegExp construction', async () => {
        const module = await loadRegexPatternsModule();
        const patternKeys = Object.keys(module.PRESET_PATTERNS);

        expect(module.getPattern('empty_lines')).toBe('^\\s*$');
        expect(module.getPattern('numbers_only')).toBe('^\\d+$');

        for (const patternKey of patternKeys) {
            const pattern = module.getPattern(patternKey);
            expect(pattern).not.toBeNull();
            expect(() => new RegExp(pattern)).not.toThrow();
            expect(module.validateRegex(pattern)).toEqual({ valid: true, error: null });
        }
    });
});
