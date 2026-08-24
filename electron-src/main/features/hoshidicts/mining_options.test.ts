import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../gsm_config.js', () => ({
    getConfiguredSinglePort: () => 8123,
}));

import { fetchHoshidictsMiningOptions } from './mining_options.js';

describe('Hoshidicts Anki mining options proxy', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('passes the GSM backend payload through to the renderer', async () => {
        const payload = {
            connected: true,
            gsmAnkiEnabled: true,
            decks: ['Mining'],
            noteTypes: ['Kiku'],
            selectedNoteType: 'Kiku',
            fields: ['Expression', 'Glossary'],
            suggestedFields: {
                expression: 'Expression',
                reading: '',
                definition: 'Glossary',
                sentence: '',
                frequency: '',
                pitch: '',
                audio: '',
            },
            resolvedFields: {
                expression: 'Expression',
                reading: '',
                definition: 'Glossary',
                sentence: '',
                frequency: '',
                pitch: '',
                audio: 'WordAudio',
            },
            suggestedFieldTemplates: {
                Expression: '{expression}',
                Glossary: '{definition}',
                Notes: '',
            },
            resolvedFieldTemplates: {
                Expression: {
                    value: '{expression}',
                    overwriteMode: 'overwrite',
                },
                Notes: { value: 'x', overwriteMode: 'skip' },
            },
            warnings: ['Deck list is temporarily unavailable.'],
            error: null,
        };
        const fetchMock = vi.fn(async () => ({
            ok: true,
            json: async () => payload,
        }));
        vi.stubGlobal('fetch', fetchMock);

        await expect(
            fetchHoshidictsMiningOptions('Kiku + Copy')
        ).resolves.toEqual(payload);
        expect(fetchMock).toHaveBeenCalledWith(
            'http://127.0.0.1:8123/api/hoshidicts/mining/options?model=Kiku+%2B+Copy',
            {
                signal: expect.any(AbortSignal),
            }
        );
    });

    it('renders a non-array list as empty instead of throwing', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: true,
                json: async () => ({
                    connected: true,
                    decks: null,
                    noteTypes: undefined,
                    fields: 'Expression',
                    warnings: null,
                }),
            }))
        );

        await expect(fetchHoshidictsMiningOptions()).resolves.toMatchObject({
            connected: true,
            decks: [],
            noteTypes: [],
            fields: [],
            warnings: [],
        });
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
            suggestedFieldTemplates: {},
            resolvedFieldTemplates: {},
            warnings: [],
            error: expect.stringContaining('connection refused'),
        });
    });

    it('preserves an explicit Automatic note-type selection', async () => {
        const fetchMock = vi.fn(async () => ({
            ok: true,
            json: async () => ({
                connected: true,
                selectedNoteType: 'Configured Card',
            }),
        }));
        vi.stubGlobal('fetch', fetchMock);

        await fetchHoshidictsMiningOptions('');

        expect(fetchMock).toHaveBeenCalledWith(
            'http://127.0.0.1:8123/api/hoshidicts/mining/options?model=',
            { signal: expect.any(AbortSignal) }
        );
    });
});
