// @vitest-environment jsdom

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

type JsonResponseBody = Record<string, unknown>;

type HarnessOptions = {
    importResponse?: {
        body: JsonResponseBody;
        status: number;
    };
};

type Harness = {
    document: Document;
    fetchMock: ReturnType<typeof vi.fn>;
    window: Window;
};

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const exstaticScriptPath = path.resolve(
    currentDir,
    '../../GameSentenceMiner/web/static/js/database-exstatic-import.js'
);
const exstaticScriptSource = fs.readFileSync(exstaticScriptPath, 'utf8');

function buildHtml(): string {
    return `
        <!DOCTYPE html>
        <html lang="en">
        <body>
            <input id="toolsExstaticFile" type="file" accept=".csv,text/csv">
            <div id="toolsExstaticProgress" style="display: none;">
                <div id="toolsExstaticProgressBar"></div>
                <span id="toolsExstaticProgressText">0%</span>
            </div>
            <div id="toolsExstaticStatus" style="display: none;"></div>
            <button id="toolsImportExstaticBtn" disabled>Import ExStatic Lines</button>
        </body>
        </html>
    `;
}

function createJsonResponse(body: JsonResponseBody, status = 200) {
    return {
        ok: status >= 200 && status < 300,
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

    const importResponse =
        options.importResponse ??
        ({
            status: 200,
            body: {
                imported_count: 42,
                games_count: 3,
                warning_count: 1,
            },
        } satisfies { body: JsonResponseBody; status: number });

    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
        switch (input) {
            case '/api/import-exstatic':
                expect(init?.method).toBe('POST');
                return createJsonResponse(importResponse.body, importResponse.status);
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
        fetch: fetchMock,
    });

    window.eval(exstaticScriptSource);
    await flushAsyncWork();

    return {
        document: window.document,
        fetchMock,
        window,
    };
}

function setSelectedFile(harness: Harness, name = 'exstatic-export.csv'): void {
    const input = harness.document.getElementById('toolsExstaticFile');
    if (!(input instanceof harness.window.HTMLInputElement)) {
        throw new Error('Expected ExStatic file input to exist');
    }

    const file = new harness.window.File(['uuid,given_identifier,name,line,time'], name, {
        type: 'text/csv',
    });
    Object.defineProperty(input, 'files', {
        configurable: true,
        value: [file],
    });
    input.dispatchEvent(new harness.window.Event('change', { bubbles: true }));
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('ExStatic importer UI', () => {
    it('enables import after file selection and posts the selected CSV from /tools', async () => {
        const harness = await bootstrapHarness();

        const button = harness.document.getElementById('toolsImportExstaticBtn');
        expect(button).toBeTruthy();
        expect((button as HTMLButtonElement).disabled).toBe(true);

        setSelectedFile(harness);
        expect((button as HTMLButtonElement).disabled).toBe(false);

        (button as HTMLButtonElement).click();
        await flushAsyncWork();

        const importCall = harness.fetchMock.mock.calls.find(
            ([url]) => url === '/api/import-exstatic'
        );
        expect(importCall).toBeTruthy();

        const init = importCall?.[1] as RequestInit | undefined;
        expect(init?.body).toBeInstanceOf(harness.window.FormData);

        const formData = init?.body as FormData;
        const uploadedFile = formData.get('file');
        expect(uploadedFile).toBeInstanceOf(harness.window.File);
        expect((uploadedFile as File).name).toBe('exstatic-export.csv');

        const status = harness.document.getElementById('toolsExstaticStatus');
        expect(status?.textContent).toContain('Imported 42 lines from 3 games.');
        expect(status?.textContent).toContain('Warnings: 1.');
        expect(status?.textContent).toContain('Refresh the page to see updated totals.');

        const progress = harness.document.getElementById('toolsExstaticProgress');
        expect(progress?.style.display).toBe('none');
    });

    it('shows the backend error and keeps the selected file available for retry', async () => {
        const harness = await bootstrapHarness({
            importResponse: {
                status: 400,
                body: {
                    error: 'File must be a CSV file',
                },
            },
        });

        setSelectedFile(harness);
        const button = harness.document.getElementById(
            'toolsImportExstaticBtn'
        ) as HTMLButtonElement;

        button.click();
        await flushAsyncWork();

        const status = harness.document.getElementById('toolsExstaticStatus');
        expect(status?.textContent).toContain('File must be a CSV file');
        expect(button.disabled).toBe(false);
    });
});
