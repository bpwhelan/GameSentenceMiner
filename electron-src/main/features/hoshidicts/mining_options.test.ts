import { afterEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
    busInfo: { port: 1234, token: 'a'.repeat(64) } as {
        port: number;
        token: string;
    } | null,
}));

vi.mock('../../gsm_config.js', () => ({
    getConfiguredSinglePort: () => 8123,
}));

vi.mock('../../runtime/bus_client.js', () => ({
    getBusConnectInfo: () => harness.busInfo,
}));

import { fetchHoshidictsMiningOptions } from './mining_options.js';

describe('Hoshidicts Anki mining options proxy', () => {
    afterEach(() => {
        harness.busInfo = { port: 1234, token: 'a'.repeat(64) };
        vi.unstubAllGlobals();
    });

    it('loads and normalizes options from the configured GSM backend', async () => {
        const fetchMock = vi.fn(async () => ({
            ok: true,
            json: async () => ({
                connected: true,
                gsmAnkiEnabled: true,
                decks: ['Mining', 42, 'Mining'],
                noteTypes: ['Kiku'],
                selectedNoteType: 'Kiku',
                fields: ['Expression', 'Glossary'],
                suggestedFields: {
                    expression: 'Expression',
                    definition: 'Glossary',
                },
                resolvedFields: {
                    expression: 'Expression',
                    definition: 'Glossary',
                    audio: 'WordAudio',
                },
                warnings: ['Deck list is temporarily unavailable.'],
                error: null,
            }),
        }));
        vi.stubGlobal('fetch', fetchMock);

        await expect(
            fetchHoshidictsMiningOptions('Kiku + Copy')
        ).resolves.toMatchObject({
            connected: true,
            gsmAnkiEnabled: true,
            decks: ['Mining'],
            selectedNoteType: 'Kiku',
            suggestedFields: {
                expression: 'Expression',
                definition: 'Glossary',
                audio: '',
            },
            resolvedFields: {
                expression: 'Expression',
                definition: 'Glossary',
                audio: 'WordAudio',
            },
            warnings: ['Deck list is temporarily unavailable.'],
        });
        expect(fetchMock).toHaveBeenCalledWith(
            'http://127.0.0.1:8123/api/hoshidicts/mining/options?model=Kiku+%2B+Copy',
            expect.objectContaining({
                headers: { Authorization: `Bearer ${'a'.repeat(64)}` },
                signal: expect.any(AbortSignal),
            })
        );
    });

    it('does not call the backend without a broker credential', async () => {
        harness.busInfo = null;
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);

        await expect(fetchHoshidictsMiningOptions()).resolves.toMatchObject({
            connected: false,
            error: expect.stringContaining('authentication'),
        });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('reports an unreachable backend as disconnected', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                throw new Error('connection refused');
            })
        );

        await expect(fetchHoshidictsMiningOptions()).resolves.toMatchObject({
            connected: false,
            gsmAnkiEnabled: false,
            decks: [],
            noteTypes: [],
            resolvedFields: {
                expression: '',
                reading: '',
                definition: '',
                sentence: '',
                frequency: '',
                pitch: '',
                audio: '',
            },
            warnings: [],
            error: expect.stringContaining('connection refused'),
        });
    });
});
