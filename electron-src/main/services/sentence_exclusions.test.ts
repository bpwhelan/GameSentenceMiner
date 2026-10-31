import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SentenceExclusionStore } from './sentence_exclusions.js';

describe('per-game sentence exclusions', () => {
    let directory: string;
    let file: string;
    let store: SentenceExclusionStore;
    beforeEach(async () => {
        directory = await mkdtemp(path.join(os.tmpdir(), 'gsm-sentences-'));
        file = path.join(directory, 'sentence_exclusions.json');
        store = new SentenceExclusionStore(file);
    });
    afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

    it('persists exact multiline entries separately from settings profiles and other games', async () => {
        await store.change('Game A', '  Menu\r\ntext  ', 'add');
        await store.change('Game B', 'Other text', 'add');
        expect(await new SentenceExclusionStore(file).list('Game A')).toEqual(['Menu\ntext']);
        expect(await store.list('Game B')).toEqual(['Other text']);
        await store.change('Game A', 'Menu\ntext', 'remove');
        expect(await store.list('Game A')).toEqual([]);
        expect(await store.list('Game B')).toEqual(['Other text']);
    });

    it('serializes concurrent additions and ignores duplicate entries', async () => {
        await Promise.all(['first', 'second', 'first'].map(text => store.change('Game', text, 'add')));
        expect(await store.list('Game')).toEqual(['first', 'second']);
    });

    it('rejects empty games and sentences and preserves a corrupt file', async () => {
        await expect(store.change('', 'text', 'add')).rejects.toThrow();
        await expect(store.change('Game', '  ', 'add')).rejects.toThrow();
        await writeFile(file, '{broken');
        await expect(store.change('Game', 'text', 'add')).rejects.toThrow();
        expect(await readFile(file, 'utf8')).toBe('{broken');
    });

    it('handles scene names that are object property names safely', async () => {
        await store.change('__proto__', 'text', 'add');
        expect(await store.list('__proto__')).toEqual(['text']);
        expect(await store.list('constructor')).toEqual([]);
    });
});
