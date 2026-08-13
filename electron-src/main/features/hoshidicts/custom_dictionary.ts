import archiver from 'archiver';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import {
    isHoshidictsCustomEntryWithinLimits,
    parseHoshidictsCustomDictionary,
    type HoshidictsCustomDictionaryEntry,
    type HoshidictsCustomDictionaryParseResult,
} from '../../../shared/features/hoshidicts.js';

export interface ParsedCustomDictionary extends HoshidictsCustomDictionaryParseResult {
    semanticRevision: string;
}

const CUSTOM_TERM_BANK_CHUNK_SIZE = 1_000;

function hash(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function customDictionarySourceRevision(text: string, exists: boolean): string {
    return hash(`${exists ? 'present' : 'missing'}\0${text}`);
}

export function parseCustomDictionary(text: string): ParsedCustomDictionary {
    const parsed = parseHoshidictsCustomDictionary(text);
    return {
        ...parsed,
        semanticRevision: hash(JSON.stringify(parsed.entries)),
    };
}

export function serializeCustomDictionaryEntry(
    entry: HoshidictsCustomDictionaryEntry
): string {
    const term = entry.term.trim();
    const reading = entry.reading.trim();
    const definition = entry.definition.trim();
    if (term.length === 0 || reading.length === 0 || definition.length === 0) {
        throw new Error('Custom dictionary term, reading, and definition are required.');
    }
    if (!isHoshidictsCustomEntryWithinLimits({ term, reading, definition })) {
        throw new Error('Custom dictionary entry exceeds its UTF-8 size limit.');
    }
    if (term.includes('\0') || reading.includes('\0') || definition.includes('\0')) {
        throw new Error('Custom dictionary entries cannot contain null characters.');
    }
    if (term.startsWith('#')) {
        throw new Error('Custom dictionary terms cannot begin with #.');
    }
    if (
        term.includes(',') ||
        reading.includes(',') ||
        /[\r\n]/u.test(term) ||
        /[\r\n]/u.test(reading)
    ) {
        throw new Error('Custom dictionary terms and readings cannot contain commas or new lines.');
    }
    const escapedDefinition = definition
        .replace(/\\/gu, '\\\\')
        .replace(/\r\n?|\n/gu, '\\n');
    return `${term}, ${reading}, ${escapedDefinition}`;
}

export async function writeCustomDictionaryArchive(
    outputPath: string,
    title: string,
    revision: string,
    entries: readonly HoshidictsCustomDictionaryEntry[]
): Promise<void> {
    if (entries.length === 0) {
        throw new Error('Cannot compile a custom dictionary without valid entries.');
    }
    await fsp.mkdir(path.dirname(outputPath), { recursive: true });
    try {
        await new Promise<void>((resolve, reject) => {
            const output = fs.createWriteStream(outputPath, { flags: 'wx' });
            const archive = archiver('zip', { zlib: { level: 9 } });
            output.once('close', resolve);
            output.once('error', reject);
            archive.once('error', reject);
            archive.pipe(output);
            archive.append(
                JSON.stringify({
                    title,
                    revision,
                    format: 3,
                    sequenced: true,
                    author: 'GameSentenceMiner',
                    description: 'Personal dictionary entries managed by GameSentenceMiner.',
                    sourceLanguage: 'ja',
                }),
                { name: 'index.json' }
            );

            for (
                let offset = 0, bankNumber = 1;
                offset < entries.length;
                offset += CUSTOM_TERM_BANK_CHUNK_SIZE, bankNumber += 1
            ) {
                const bank = entries
                    .slice(offset, offset + CUSTOM_TERM_BANK_CHUNK_SIZE)
                    .map((entry, entryIndex) => [
                        entry.term,
                        entry.reading,
                        '',
                        '',
                        0,
                        [entry.definition],
                        offset + entryIndex + 1,
                        '',
                    ]);
                archive.append(JSON.stringify(bank), {
                    name: `term_bank_${bankNumber}.json`,
                });
            }
            void archive.finalize().catch(reject);
        });
    } catch (error) {
        await fsp.rm(outputPath, { force: true }).catch(() => undefined);
        throw error;
    }
}
