import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

type SearchBootstrapState = {
    query: string;
    useTokenised: boolean;
};

type SearchBootstrapHooks = {
    readSearchBootstrapState: (search: string) => SearchBootstrapState;
    applySearchBootstrapState: (
        app: {
            searchInput: { value: string };
            useTokenised: boolean;
            wordSearchToggle: { checked: boolean } | null;
            updateLastSeenSortOptions: (active: boolean) => void;
        },
        bootstrapState: SearchBootstrapState,
        tokenisationEnabled: boolean
    ) => void;
};

function loadSearchBootstrapHooks(): SearchBootstrapHooks {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const searchScriptPath = path.resolve(
        currentDir,
        '../../GameSentenceMiner/web/static/js/search.js'
    );
    const source = fs.readFileSync(searchScriptPath, 'utf8');
    const context = {
        console,
        URLSearchParams,
        document: {
            addEventListener: () => {},
        },
        window: {
            location: {
                search: '',
            },
        },
        setTimeout,
        clearTimeout,
        __GSM_SEARCH_TEST_HOOKS__: {},
    } as Record<string, unknown>;
    context.globalThis = context;

    vm.createContext(context);
    vm.runInContext(source, context, { filename: searchScriptPath });

    return context.__GSM_SEARCH_TEST_HOOKS__ as SearchBootstrapHooks;
}

describe('search page bootstrap helpers', () => {
    it('reads q and use_tokenised from the URL', () => {
        const hooks = loadSearchBootstrapHooks();

        expect(hooks.readSearchBootstrapState('?q=%E6%9C%AC&use_tokenised=true')).toEqual({
            query: '本',
            useTokenised: true,
        });
    });

    it('defaults useTokenised to false when the param is missing or false', () => {
        const hooks = loadSearchBootstrapHooks();

        expect(hooks.readSearchBootstrapState('?q=%E9%A3%9F%E3%81%B9%E3%82%8B')).toEqual({
            query: '食べる',
            useTokenised: false,
        });
        expect(hooks.readSearchBootstrapState('?q=%E9%A3%9F%E3%81%B9%E3%82%8B&use_tokenised=false')).toEqual({
            query: '食べる',
            useTokenised: false,
        });
    });

    it('enables tokenised mode before the initial search when requested and available', () => {
        const hooks = loadSearchBootstrapHooks();
        const updateCalls: boolean[] = [];
        const app = {
            searchInput: { value: '' },
            useTokenised: false,
            wordSearchToggle: { checked: false },
            updateLastSeenSortOptions: (active: boolean) => {
                updateCalls.push(active);
            },
        };

        hooks.applySearchBootstrapState(app, { query: '見る', useTokenised: true }, true);

        expect(app.searchInput.value).toBe('見る');
        expect(app.useTokenised).toBe(true);
        expect(app.wordSearchToggle?.checked).toBe(true);
        expect(updateCalls).toEqual([true]);
    });

    it('keeps tokenised mode off when tokenisation is unavailable', () => {
        const hooks = loadSearchBootstrapHooks();
        const updateCalls: boolean[] = [];
        const app = {
            searchInput: { value: '' },
            useTokenised: false,
            wordSearchToggle: { checked: false },
            updateLastSeenSortOptions: (active: boolean) => {
                updateCalls.push(active);
            },
        };

        hooks.applySearchBootstrapState(app, { query: '見る', useTokenised: true }, false);

        expect(app.searchInput.value).toBe('見る');
        expect(app.useTokenised).toBe(false);
        expect(app.wordSearchToggle?.checked).toBe(false);
        expect(updateCalls).toEqual([]);
    });
});
