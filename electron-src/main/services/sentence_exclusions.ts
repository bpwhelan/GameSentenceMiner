import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class SentenceExclusionStore {
    private pending: Promise<unknown> = Promise.resolve();
    constructor(private readonly file: string) {}

    async snapshot(): Promise<Record<string, string[]>> {
        let data;
        try { data = JSON.parse(await fs.readFile(this.file, 'utf8')); }
        catch (error: any) { if (error.code === 'ENOENT') return {}; throw error; }
        if (data?.version !== 1 || !data.games || typeof data.games !== 'object' || Array.isArray(data.games) ||
            !Object.values(data.games).every(value => Array.isArray(value) && value.every(text => typeof text === 'string'))) {
            throw new Error('Invalid sentence exclusions file');
        }
        return data.games;
    }

    async list(game: string): Promise<string[]> {
        const games = await this.snapshot();
        return Object.hasOwn(games, game) ? games[game] : [];
    }

    change(game: string, text: string, action: 'add' | 'remove'): Promise<Record<string, string[]>> {
        const result = this.pending.then(async () => {
            if (typeof game !== 'string' || !game.trim() || typeof text !== 'string' || !text.trim() ||
                !['add', 'remove'].includes(action)) throw new Error('Game and sentence are required');
            const sentence = text.replace(/\r\n?/g, '\n').trim();
            const games = await this.snapshot();
            const current = Object.hasOwn(games, game) ? games[game] : [];
            const sentences = action === 'add' ? [...new Set([...current, sentence])]
                : current.filter(item => item !== sentence);
            // Define an own property even for scene names such as "__proto__".
            Object.defineProperty(games, game, { value: sentences, enumerable: true, configurable: true, writable: true });
            if (!sentences.length) delete games[game];
            await fs.mkdir(path.dirname(this.file), { recursive: true });
            const temporary = `${this.file}.${randomUUID()}.tmp`;
            try {
                await fs.writeFile(temporary, JSON.stringify({ version: 1, games }, null, 2), 'utf8');
                await fs.rename(temporary, this.file);
            } finally { await fs.rm(temporary, { force: true }); }
            return games;
        });
        this.pending = result.catch(() => {});
        return result;
    }
}
