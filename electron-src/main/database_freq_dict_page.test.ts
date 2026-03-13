// @vitest-environment jsdom

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

type JsonValue = Record<string, unknown>;

type TestOptions = {
    tokenisationStatus?: 'enabled' | 'disabled' | 'reject';
    freqDictResult?:
        | {
              ok: boolean;
              error?: string;
          }
        | 'reject';
};

type TestHarness = {
    anchorClick: ReturnType<typeof vi.fn>;
    createObjectURL: ReturnType<typeof vi.fn>;
    document: Document;
    errorSpy: ReturnType<typeof vi.fn>;
    fetchMock: ReturnType<typeof vi.fn>;
    getClickedAnchor: () => HTMLAnchorElement | null;
    revokeObjectURL: ReturnType<typeof vi.fn>;
    successSpy: ReturnType<typeof vi.fn>;
    window: Window;
};

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const databaseScriptPath = path.resolve(currentDir, '../../GameSentenceMiner/web/static/js/database.js');
const databaseScriptSource = fs.readFileSync(databaseScriptPath, 'utf8');

function buildDatabasePageHtml(): string {
    return `
        <!DOCTYPE html>
        <html lang="en">
        <body>
            <input id="yomitanGameCount" value="3">
            <select id="yomitanSpoilerLevel">
                <option value="0" selected>No Spoilers</option>
                <option value="1">Minor Spoilers</option>
                <option value="2">All Spoilers</option>
            </select>
            <div id="totalGamesCount">Loading...</div>
            <div id="totalSentencesCount">Loading...</div>
            <div id="totalCharactersCount">Loading...</div>
            <div id="linkedGamesCount">Loading...</div>
            <div id="unlinkedGamesCount">Loading...</div>
            <div id="freqDictTokenisationWarning" style="display: none;"></div>
            <button id="downloadFreqDictBtn" data-action="downloadFreqDict">
                Download Frequency Dictionary
            </button>
        </body>
        </html>
    `;
}

function createJsonResponse(body: JsonValue, ok = true) {
    return {
        ok,
        json: async () => body,
        blob: async () => {
            throw new Error('blob() should not be used for JSON responses');
        },
    };
}

function createZipResponse(window: Window) {
    return {
        ok: true,
        json: async () => {
            throw new Error('json() should not be used for ZIP responses');
        },
        blob: async () => new window.Blob(['zip-bytes'], { type: 'application/zip' }),
    };
}

async function flushAsyncWork(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
}

async function bootstrapDatabasePage(options: TestOptions = {}): Promise<TestHarness> {
    const dom = new JSDOM(buildDatabasePageHtml(), {
        pretendToBeVisual: true,
        runScripts: 'outside-only',
        url: 'http://127.0.0.1/tools',
    });
    const { window } = dom;

    let clickedAnchor: HTMLAnchorElement | null = null;
    const anchorClick = vi.fn(function (this: HTMLAnchorElement) {
        clickedAnchor = this;
    });
    Object.defineProperty(window.HTMLAnchorElement.prototype, 'click', {
        configurable: true,
        value: anchorClick,
    });

    const createObjectURL = vi.fn(() => 'blob:test-frequency-dict');
    const revokeObjectURL = vi.fn();
    window.URL.createObjectURL = createObjectURL;
    window.URL.revokeObjectURL = revokeObjectURL;

    const consoleStub = {
        ...console,
        error: vi.fn(),
        log: vi.fn(),
    };
    const successSpy = vi.fn();
    const errorSpy = vi.fn();

    const fetchMock = vi.fn(async (input: string) => {
        switch (input) {
            case '/api/tokenisation/status':
                if (options.tokenisationStatus === 'reject') {
                    throw new Error('tokenisation status unavailable');
                }
                return createJsonResponse({
                    enabled: options.tokenisationStatus !== 'disabled',
                });
            case '/api/games-list':
                return createJsonResponse({
                    games: [],
                });
            case '/api/games-management':
                return createJsonResponse({
                    summary: {
                        linked_games: 0,
                        unlinked_games: 0,
                    },
                });
            case '/api/yomitan-freq-dict':
                if (options.freqDictResult === 'reject') {
                    throw new Error('download failed');
                }
                if (options.freqDictResult && !options.freqDictResult.ok) {
                    return createJsonResponse(
                        {
                            error:
                                options.freqDictResult.error ??
                                'Failed to generate frequency dictionary',
                        },
                        false
                    );
                }
                return createZipResponse(window);
            default:
                throw new Error(`Unexpected fetch request in test: ${input}`);
        }
    });

    Object.assign(window, {
        console: consoleStub,
        fetch: fetchMock,
        formatReleaseDate: vi.fn(),
        loadGamesForDataManagement: vi.fn(),
        showDatabaseConfirmPopup: vi.fn(),
        showDatabaseErrorPopup: errorSpy,
        showDatabaseSuccessPopup: successSpy,
        switchTab: vi.fn(),
    });

    window.eval(databaseScriptSource);
    await flushAsyncWork();

    return {
        anchorClick,
        createObjectURL,
        document: window.document,
        errorSpy,
        fetchMock,
        getClickedAnchor: () => clickedAnchor,
        revokeObjectURL,
        successSpy,
        window,
    };
}

async function clickFrequencyDownloadButton(harness: TestHarness): Promise<void> {
    const button = harness.document.getElementById('downloadFreqDictBtn');
    if (!(button instanceof harness.window.HTMLButtonElement)) {
        throw new Error('Expected frequency dictionary download button to exist');
    }

    button.click();
    await flushAsyncWork();
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('database page frequency dictionary behavior', () => {
    it('keeps the warning hidden and button enabled when tokenisation is enabled', async () => {
        const harness = await bootstrapDatabasePage({
            tokenisationStatus: 'enabled',
        });

        const warning = harness.document.getElementById('freqDictTokenisationWarning');
        const button = harness.document.getElementById('downloadFreqDictBtn');

        expect(warning).not.toBeNull();
        expect(warning?.style.display).toBe('none');
        expect(button).toBeInstanceOf(harness.window.HTMLButtonElement);
        expect((button as HTMLButtonElement).disabled).toBe(false);
    });

    it('shows the warning and disables the button when tokenisation is disabled', async () => {
        const harness = await bootstrapDatabasePage({
            tokenisationStatus: 'disabled',
        });

        const warning = harness.document.getElementById('freqDictTokenisationWarning');
        const button = harness.document.getElementById('downloadFreqDictBtn');

        expect(warning?.style.display).toBe('block');
        expect(button).toBeInstanceOf(harness.window.HTMLButtonElement);
        expect((button as HTMLButtonElement).disabled).toBe(true);
    });

    it('keeps the button usable when the tokenisation status check fails', async () => {
        const harness = await bootstrapDatabasePage({
            tokenisationStatus: 'reject',
        });

        const warning = harness.document.getElementById('freqDictTokenisationWarning');
        const button = harness.document.getElementById('downloadFreqDictBtn');

        expect(warning?.style.display).toBe('none');
        expect(button).toBeInstanceOf(harness.window.HTMLButtonElement);
        expect((button as HTMLButtonElement).disabled).toBe(false);

        await clickFrequencyDownloadButton(harness);

        expect(harness.fetchMock).toHaveBeenCalledWith('/api/yomitan-freq-dict');
        expect(harness.anchorClick).toHaveBeenCalledTimes(1);
        expect(harness.successSpy).toHaveBeenCalledWith(
            'Frequency dictionary downloaded! Import it into Yomitan.'
        );
    });

    it('downloads the frequency dictionary zip and reports success', async () => {
        const harness = await bootstrapDatabasePage({
            tokenisationStatus: 'enabled',
        });

        await clickFrequencyDownloadButton(harness);

        expect(harness.fetchMock).toHaveBeenCalledWith('/api/yomitan-freq-dict');
        expect(harness.createObjectURL).toHaveBeenCalledTimes(1);
        expect(harness.anchorClick).toHaveBeenCalledTimes(1);
        expect(harness.getClickedAnchor()?.download).toBe('gsm_frequency.zip');
        expect(harness.getClickedAnchor()?.href).toBe('blob:test-frequency-dict');
        expect(harness.revokeObjectURL).toHaveBeenCalledWith('blob:test-frequency-dict');
        expect(harness.successSpy).toHaveBeenCalledWith(
            'Frequency dictionary downloaded! Import it into Yomitan.'
        );
        expect(harness.errorSpy).not.toHaveBeenCalled();
    });

    it('surfaces API errors without attempting a download', async () => {
        const harness = await bootstrapDatabasePage({
            freqDictResult: {
                error: 'No frequency data available. Play some games with tokenisation enabled.',
                ok: false,
            },
            tokenisationStatus: 'enabled',
        });

        await clickFrequencyDownloadButton(harness);

        expect(harness.fetchMock).toHaveBeenCalledWith('/api/yomitan-freq-dict');
        expect(harness.errorSpy).toHaveBeenCalledWith(
            'No frequency data available. Play some games with tokenisation enabled.'
        );
        expect(harness.createObjectURL).not.toHaveBeenCalled();
        expect(harness.anchorClick).not.toHaveBeenCalled();
        expect(harness.successSpy).not.toHaveBeenCalled();
    });

    it('shows a generic error message when the download request fails', async () => {
        const harness = await bootstrapDatabasePage({
            freqDictResult: 'reject',
            tokenisationStatus: 'enabled',
        });

        await clickFrequencyDownloadButton(harness);

        expect(harness.fetchMock).toHaveBeenCalledWith('/api/yomitan-freq-dict');
        expect(harness.errorSpy).toHaveBeenCalledWith(
            'Failed to download frequency dictionary. Please try again.'
        );
        expect(harness.createObjectURL).not.toHaveBeenCalled();
        expect(harness.anchorClick).not.toHaveBeenCalled();
        expect(harness.successSpy).not.toHaveBeenCalled();
    });
});
