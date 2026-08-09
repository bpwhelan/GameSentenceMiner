import { finished } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';

import {
    createJsonScalarLimitTransform,
    YOMITAN_JSON_SCALAR_LIMIT_ERROR,
} from './json_scalar_limit.js';

async function guardJson(chunks: readonly Buffer[], maxScalarBytes: number): Promise<Buffer[]> {
    const guard = createJsonScalarLimitTransform(maxScalarBytes);
    const output: Buffer[] = [];
    guard.on('data', (chunk: Buffer) => output.push(chunk));
    const completion = finished(guard);

    for (const chunk of chunks) {
        guard.write(chunk);
    }
    guard.end();

    await completion;
    return output;
}

function singleByteChunks(value: string): Buffer[] {
    return [...Buffer.from(value)].map((byte) => Buffer.of(byte));
}

describe('Yomitan JSON scalar limit transform', () => {
    it('passes the original chunks through without changing or combining them', async () => {
        const chunks = [Buffer.from('{"key":'), Buffer.from('"value"}')];

        const output = await guardJson(chunks, 5);

        expect(output).toHaveLength(chunks.length);
        expect(output[0]).toBe(chunks[0]);
        expect(output[1]).toBe(chunks[1]);
        expect(Buffer.concat(output)).toEqual(Buffer.concat(chunks));
    });

    it.each([
        [String.raw`"\n"`, 1],
        [String.raw`"\""`, 1],
        [String.raw`"\\"`, 1],
        [String.raw`"\/"`, 1],
        [String.raw`"\u007f"`, 1],
        [String.raw`"\u0080"`, 2],
        [String.raw`"\u07ff"`, 2],
        [String.raw`"\u0800"`, 3],
        [String.raw`"\ud83d\ude00"`, 4],
        [String.raw`"\ud800"`, 3],
        [String.raw`"\udc00"`, 3],
        [String.raw`"\ud800A"`, 4],
        [String.raw`"\ud800\n"`, 4],
        [String.raw`"\ud800\ud801\udc00"`, 7],
    ])('counts the decoded bytes in %s as %i', async (json, decodedBytes) => {
        await expect(guardJson(singleByteChunks(json), decodedBytes)).resolves.toBeDefined();
        await expect(guardJson(singleByteChunks(json), decodedBytes - 1)).rejects.toThrow(
            YOMITAN_JSON_SCALAR_LIMIT_ERROR,
        );
    });

    it('counts raw UTF-8 bytes exactly when a character crosses chunk boundaries', async () => {
        const json = '"A€𐍈"';

        await expect(guardJson(singleByteChunks(json), 8)).resolves.toBeDefined();
        await expect(guardJson(singleByteChunks(json), 7)).rejects.toThrow(
            YOMITAN_JSON_SCALAR_LIMIT_ERROR,
        );
    });

    it('applies the same decoded limit to object keys', async () => {
        await expect(guardJson(singleByteChunks(String.raw`{"\u20ac":true}`), 2)).rejects.toThrow(
            YOMITAN_JSON_SCALAR_LIMIT_ERROR,
        );
    });

    it('resets the byte count for each string and ignores JSON syntax and literals', async () => {
        await expect(
            guardJson(singleByteChunks('{"a":"b","c":[true,false,null,{},[],"d"]}'), 1),
        ).resolves.toBeDefined();
    });

    it('counts the raw bytes of a number across chunks', async () => {
        const json = '[-1.25e+10]';
        const numberBytes = Buffer.byteLength('-1.25e+10');

        await expect(guardJson(singleByteChunks(json), numberBytes)).resolves.toBeDefined();
        await expect(guardJson(singleByteChunks(json), numberBytes - 1)).rejects.toThrow(
            YOMITAN_JSON_SCALAR_LIMIT_ERROR,
        );
    });

    it('allows empty strings at a zero-byte limit and rejects any non-empty scalar', async () => {
        await expect(guardJson(singleByteChunks('["",{}]'), 0)).resolves.toBeDefined();
        await expect(guardJson(singleByteChunks('[0]'), 0)).rejects.toThrow(
            YOMITAN_JSON_SCALAR_LIMIT_ERROR,
        );
    });
});
