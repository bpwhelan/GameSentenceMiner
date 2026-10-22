// @vitest-environment jsdom

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

type JsonResponseBody = Record<string, unknown>;

type HarnessOptions = {
    kizunaResponse?: {
        body: JsonResponseBody;
        status: number;
    };
    importResponse?: {
        body: JsonResponseBody;
        status: number;
    };
    summaryResponse?: JsonResponseBody;
};

type Harness = {
    document: Document;
    fetchMock: ReturnType<typeof vi.fn>;
    window: Window;
};

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const thirdPartyScriptPath = path.resolve(
    currentDir,
    '../../GameSentenceMiner/web/static/js/database-third-party-stats.js'
);
const thirdPartyScriptSource = fs.readFileSync(thirdPartyScriptPath, 'utf8');

function buildHtml(): string {
    return `
        <!DOCTYPE html>
        <html lang="en">
        <body>
            <div id="thirdPartyTotalEntries"></div>
            <div id="thirdPartyTotalChars"></div>
            <div id="thirdPartyTotalTime"></div>
            <div id="thirdPartySources"></div>

            <button data-action="openThirdPartyStatsModal">Manage External Stats</button>

            <div id="thirdPartyStatsModal">
                <button data-action="closeModal" data-modal="thirdPartyStatsModal">Close</button>
                <button data-tp-tab="manual"></button>
                <button data-tp-tab="mokuro"></button>
                <button data-tp-tab="kizuna"></button>
                <div id="tpTabManual" class="tab-content"></div>
                <div id="tpTabMokuro" class="tab-content"></div>
                <div id="tpTabKizuna" class="tab-content"></div>
            </div>

            <input id="tpManualDate">
            <input id="mokuroFileInput" type="file">
            <input id="mokuroClearPrevious" type="checkbox" checked>
            <div id="mokuroImportResult" style="display: none;"></div>
            <input id="kizunaFileInput" type="file">
            <input id="kizunaClearPrevious" type="checkbox">
            <button id="kizunaImportButton">Import Kizuna Data</button>
            <div id="kizunaImportResult" style="display: none;"></div>
        </body>
        </html>
    `;
}

function createJsonResponse(body: JsonResponseBody, status = 200) {
    return {
        status,
        json: async () => body,
    };
}

async function flushAsyncWork(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
}

async function bootstrapHarness(options: HarnessOptions = {}): Promise<Harness> {
    const dom = new JSDOM(buildHtml(), {
        pretendToBeVisual: true,
        runScripts: 'outside-only',
        url: 'http://127.0.0.1/tools',
    });
    const { window } = dom;

    const summaryResponse =
        options.summaryResponse ??
        ({
            total_entries: 4,
            total_characters: 1800,
            total_time_seconds: 5400,
            by_source: {
                mokuro: {
                    count: 4,
                    characters: 1800,
                    time_seconds: 5400,
                },
            },
        } satisfies JsonResponseBody);

    const importResponse =
        options.importResponse ??
        ({
            status: 200,
            body: {
                imported_count: 4,
                volumes_with_data: 2,
                total_characters: 1800,
                total_time_minutes: 90,
                cleared_count: 1,
                date_range: {
                    min: '2025-12-15',
                    max: '2025-12-29',
                },
                volumes: ['やがて君になる - 第01巻', 'フリージア - freesia_01'],
            },
        } satisfies { body: JsonResponseBody; status: number });

    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
        switch (input) {
            case '/api/third-party-stats/summary':
                return createJsonResponse(summaryResponse);
            case '/api/import-mokuro':
                return createJsonResponse(importResponse.body, importResponse.status);
            case '/api/import-kizuna': {
                const response = options.kizunaResponse ?? {
                    status: 200,
                    body: {
                        imported_count: 4,
                        games_count: 3,
                        skipped_count: 1,
                        total_characters: 46116,
                        total_lines: 2164,
                        total_time_seconds: 11762.5,
                        metadata_refresh_status: 'queued',
                        metadata_refresh_message: 'VNDB metadata refresh queued.',
                        games: ['<img src=x onerror=alert(1)>', '日本語'],
                    },
                };
                return createJsonResponse(response.body, response.status);
            }
            default:
                throw new Error(`Unexpected fetch request in test: ${input}`);
        }
    });

    Object.assign(window, {
        console: {
            ...console,
            error: vi.fn(),
            log: vi.fn(),
        },
        confirm: vi.fn(() => true),
        fetch: fetchMock,
    });

    window.eval(thirdPartyScriptSource);
    await flushAsyncWork();

    return {
        document: window.document,
        fetchMock,
        window,
    };
}

function setSelectedFile(harness: Harness, name = 'volume-data.json'): void {
    const input = harness.document.getElementById('mokuroFileInput');
    if (!(input instanceof harness.window.HTMLInputElement)) {
        throw new Error('Expected Mokuro file input to exist');
    }

    const file = new harness.window.File(['{}'], name, {
        type: 'application/json',
    });
    Object.defineProperty(input, 'files', {
        configurable: true,
        value: [file],
    });
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('third-party stats importer UI', () => {
    it('opens the Kizuna import tab', async () => {
        const harness = await bootstrapHarness();
        (harness.document.querySelector('[data-tp-tab="kizuna"]') as HTMLButtonElement).click();
        expect(harness.document.getElementById('tpTabKizuna')?.classList.contains('active')).toBe(true);
    });

    it('requires a Kizuna CSV file before submitting', async () => {
        const harness = await bootstrapHarness();
        await (harness.window as Window & { importKizunaData: () => Promise<void> }).importKizunaData();
        expect(harness.document.getElementById('kizunaImportResult')?.textContent).toContain('Please select a Kizuna CSV file.');
        expect(harness.fetchMock.mock.calls.some(([url]) => url === '/api/import-kizuna')).toBe(false);
    });

    it('imports Kizuna once, displays totals and metadata status, and escapes game names', async () => {
        const harness = await bootstrapHarness();
        const input = harness.document.getElementById('kizunaFileInput') as HTMLInputElement;
        Object.defineProperty(input, 'files', {
            value: [new harness.window.File(['vndb_id,name,date,duration_seconds,chars,lines'], 'kizuna.csv')],
        });
        const importFn = (harness.window as Window & { importKizunaData: () => Promise<void> }).importKizunaData;
        const pending = importFn();
        expect((harness.document.getElementById('kizunaImportButton') as HTMLButtonElement).disabled).toBe(true);
        await importFn();
        await pending;
        const calls = harness.fetchMock.mock.calls.filter(([url]) => url === '/api/import-kizuna');
        expect(calls).toHaveLength(1);
        const form = calls[0][1].body as FormData;
        expect((form.get('file') as File).name).toBe('kizuna.csv');
        expect(form.get('clear_previous')).toBe('false');
        const result = harness.document.getElementById('kizunaImportResult');
        expect(result?.textContent).toContain('Sessions imported:4');
        expect(result?.textContent).toContain('Games:3');
        expect(result?.textContent).toContain('Total characters:46,116');
        expect(result?.textContent).toContain('Total lines:2,164');
        expect(result?.textContent).toContain('Duplicate sessions skipped:1');
        expect(result?.textContent).toContain('VNDB metadata refresh queued.');
        expect(result?.querySelector('img')).toBeNull();
        expect(harness.fetchMock.mock.calls.filter(([url]) => url === '/api/third-party-stats/summary')).toHaveLength(2);
        expect((harness.document.getElementById('kizunaImportButton') as HTMLButtonElement).disabled).toBe(false);
    });

    it('shows failed imports and allows trying again', async () => {
        const harness = await bootstrapHarness({ kizunaResponse: { status: 400, body: { error: 'Row 3: invalid date' } } });
        const input = harness.document.getElementById('kizunaFileInput') as HTMLInputElement;
        Object.defineProperty(input, 'files', { value: [new harness.window.File(['bad'], 'kizuna.csv')] });
        await (harness.window as Window & { importKizunaData: () => Promise<void> }).importKizunaData();
        expect(harness.document.getElementById('kizunaImportResult')?.textContent).toContain('Row 3: invalid date');
        expect(harness.document.getElementById('kizunaImportResult')?.className).toContain('error');
        expect((harness.document.getElementById('kizunaImportButton') as HTMLButtonElement).disabled).toBe(false);
    });

    it('loads the third-party summary on bootstrap using the API count field', async () => {
        const harness = await bootstrapHarness();

        expect(harness.document.getElementById('thirdPartyTotalEntries')?.textContent).toBe('4');
        expect(harness.document.getElementById('thirdPartyTotalChars')?.textContent).toBe('1,800');
        expect(harness.document.getElementById('thirdPartyTotalTime')?.textContent).toBe('1h 30m');
        expect(harness.document.getElementById('thirdPartySources')?.textContent).toContain(
            'mokuro (4)'
        );
    });

    it('shows a validation error when importing Mokuro data without selecting a file', async () => {
        const harness = await bootstrapHarness();
        const importFn = (harness.window as Window & { importMokuroData: () => void })
            .importMokuroData;

        importFn();
        await flushAsyncWork();

        const resultDiv = harness.document.getElementById('mokuroImportResult');
        expect(resultDiv?.textContent).toContain('Please select a volume-data.json file.');
        expect(resultDiv?.className).toContain('error');
        expect(
            harness.fetchMock.mock.calls.filter(([url]) => url === '/api/import-mokuro')
        ).toHaveLength(0);
    });

    it('submits the selected Mokuro file, renders the success summary, and refreshes totals', async () => {
        const harness = await bootstrapHarness();
        setSelectedFile(harness);

        const importFn = (harness.window as Window & { importMokuroData: () => void })
            .importMokuroData;
        importFn();
        await flushAsyncWork();

        const importCall = harness.fetchMock.mock.calls.find(
            ([url]) => url === '/api/import-mokuro'
        );
        expect(importCall).toBeTruthy();

        const init = importCall?.[1] as RequestInit | undefined;
        expect(init?.method).toBe('POST');
        expect(init?.body).toBeInstanceOf(harness.window.FormData);

        const formData = init?.body as FormData;
        const uploadedFile = formData.get('file');
        expect(uploadedFile).toBeInstanceOf(harness.window.File);
        expect((uploadedFile as File).name).toBe('volume-data.json');
        expect(formData.get('clear_previous')).toBe('true');

        const resultDiv = harness.document.getElementById('mokuroImportResult');
        expect(resultDiv?.innerHTML).toContain('Import Successful');
        expect(resultDiv?.textContent).toContain('Daily entries created:4');
        expect(resultDiv?.textContent).toContain('Volumes with data:2');
        expect(resultDiv?.textContent).toContain('Total characters:1,800');
        expect(resultDiv?.textContent).toContain('Total time:90 min');
        expect(resultDiv?.textContent).toContain('Date range:2025-12-15 to 2025-12-29');
        expect(resultDiv?.textContent).toContain('Previous entries cleared:1');
        expect(resultDiv?.textContent).toContain('やがて君になる - 第01巻');
        expect(resultDiv?.textContent).toContain('フリージア - freesia_01');

        expect(
            harness.fetchMock.mock.calls.filter(([url]) => url === '/api/third-party-stats/summary')
        ).toHaveLength(2);
        expect(harness.document.getElementById('thirdPartyTotalEntries')?.textContent).toBe('4');
    });
});
