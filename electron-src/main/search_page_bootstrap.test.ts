import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

type SearchBootstrapState = {
    query: string;
    useTokenized: boolean;
    fromDate: string;
    toDate: string;
};

type SearchBootstrapHooks = {
    readSearchBootstrapState: (search: string) => SearchBootstrapState;
    applySearchBootstrapState: (
        app: {
            searchInput: { value: string };
            fromDateFilter: { value: string } | null;
            toDateFilter: { value: string } | null;
            useTokenized: boolean;
            wordSearchToggle: { checked: boolean } | null;
            updateLastSeenSortOptions: (active: boolean) => void;
        },
        bootstrapState: SearchBootstrapState,
        tokenizationEnabled: boolean
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
    it('reads q and use_tokenized from the URL', () => {
        const hooks = loadSearchBootstrapHooks();

        expect(hooks.readSearchBootstrapState('?q=%E6%9C%AC&use_tokenized=true')).toEqual({
            query: '本',
            useTokenized: true,
            fromDate: '',
            toDate: '',
        });
    });

    it('defaults useTokenized to false when the param is missing or false', () => {
        const hooks = loadSearchBootstrapHooks();

        expect(hooks.readSearchBootstrapState('?q=%E9%A3%9F%E3%81%B9%E3%82%8B')).toEqual({
            query: '食べる',
            useTokenized: false,
            fromDate: '',
            toDate: '',
        });
        expect(hooks.readSearchBootstrapState('?q=%E9%A3%9F%E3%81%B9%E3%82%8B&use_tokenized=false')).toEqual({
            query: '食べる',
            useTokenized: false,
            fromDate: '',
            toDate: '',
        });
    });

    it('reads a heatmap day from the URL and applies both date filters', () => {
        const hooks = loadSearchBootstrapHooks();
        const bootstrapState = hooks.readSearchBootstrapState(
            '?from_date=2024-06-01&to_date=2024-06-01'
        );
        const app = {
            searchInput: { value: '' },
            fromDateFilter: { value: '' },
            toDateFilter: { value: '' },
            useTokenized: false,
            wordSearchToggle: null,
            updateLastSeenSortOptions: () => {},
        };

        hooks.applySearchBootstrapState(app, bootstrapState, false);

        expect(bootstrapState).toEqual({
            query: '',
            useTokenized: false,
            fromDate: '2024-06-01',
            toDate: '2024-06-01',
        });
        expect(app.fromDateFilter.value).toBe('2024-06-01');
        expect(app.toDateFilter.value).toBe('2024-06-01');
    });

    it('enables tokenized mode before the initial search when requested and available', () => {
        const hooks = loadSearchBootstrapHooks();
        const updateCalls: boolean[] = [];
        const app = {
            searchInput: { value: '' },
            fromDateFilter: null,
            toDateFilter: null,
            useTokenized: false,
            wordSearchToggle: { checked: false },
            updateLastSeenSortOptions: (active: boolean) => {
                updateCalls.push(active);
            },
        };

        hooks.applySearchBootstrapState(
            app,
            { query: '見る', useTokenized: true, fromDate: '', toDate: '' },
            true
        );

        expect(app.searchInput.value).toBe('見る');
        expect(app.useTokenized).toBe(true);
        expect(app.wordSearchToggle?.checked).toBe(true);
        expect(updateCalls).toEqual([true]);
    });

    it('keeps tokenized mode off when tokenization is unavailable', () => {
        const hooks = loadSearchBootstrapHooks();
        const updateCalls: boolean[] = [];
        const app = {
            searchInput: { value: '' },
            fromDateFilter: null,
            toDateFilter: null,
            useTokenized: false,
            wordSearchToggle: { checked: false },
            updateLastSeenSortOptions: (active: boolean) => {
                updateCalls.push(active);
            },
        };

        hooks.applySearchBootstrapState(
            app,
            { query: '見る', useTokenized: true, fromDate: '', toDate: '' },
            false
        );

        expect(app.searchInput.value).toBe('見る');
        expect(app.useTokenized).toBe(false);
        expect(app.wordSearchToggle?.checked).toBe(false);
        expect(updateCalls).toEqual([]);
    });
});
