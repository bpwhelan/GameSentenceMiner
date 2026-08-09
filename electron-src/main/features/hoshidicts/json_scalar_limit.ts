import { Transform, type TransformCallback } from 'node:stream';

export const MAX_YOMITAN_JSON_SCALAR_BYTES = 32 * 1024 * 1024;
export const YOMITAN_JSON_SCALAR_LIMIT_ERROR =
    'A value in the Yomitan backup exceeds the supported 32 MiB limit.';

type ScannerMode = 'outside' | 'string' | 'escape' | 'unicode' | 'number';

const DOUBLE_QUOTE = 0x22;
const PLUS_SIGN = 0x2b;
const MINUS_SIGN = 0x2d;
const FULL_STOP = 0x2e;
const DIGIT_ZERO = 0x30;
const DIGIT_NINE = 0x39;
const UPPERCASE_A = 0x41;
const UPPERCASE_E = 0x45;
const UPPERCASE_F = 0x46;
const BACKSLASH = 0x5c;
const LOWERCASE_A = 0x61;
const LOWERCASE_E = 0x65;
const LOWERCASE_F = 0x66;
const LOWERCASE_U = 0x75;

function isDigit(byte: number): boolean {
    return byte >= DIGIT_ZERO && byte <= DIGIT_NINE;
}

function isNumberByte(byte: number): boolean {
    return (
        isDigit(byte) ||
        byte === MINUS_SIGN ||
        byte === PLUS_SIGN ||
        byte === FULL_STOP ||
        byte === LOWERCASE_E ||
        byte === UPPERCASE_E
    );
}

function hexValue(byte: number): number {
    if (isDigit(byte)) {
        return byte - DIGIT_ZERO;
    }
    if (byte >= LOWERCASE_A && byte <= LOWERCASE_F) {
        return byte - LOWERCASE_A + 10;
    }
    if (byte >= UPPERCASE_A && byte <= UPPERCASE_F) {
        return byte - UPPERCASE_A + 10;
    }
    return 0;
}

function utf8BytesForCodeUnit(codeUnit: number): number {
    if (codeUnit <= 0x7f) {
        return 1;
    }
    if (codeUnit <= 0x7ff) {
        return 2;
    }
    return 3;
}

/**
 * Passes a JSON byte stream through unchanged while bounding individual scalar
 * values before the JSON parser allocates their decoded strings.
 */
export class JsonScalarLimitTransform extends Transform {
    private mode: ScannerMode = 'outside';
    private scalarBytes = 0;
    private unicodeCodeUnit = 0;
    private unicodeDigits = 0;
    private pendingHighSurrogate = false;

    public constructor(private readonly maxScalarBytes = MAX_YOMITAN_JSON_SCALAR_BYTES) {
        super();
        if (!Number.isSafeInteger(maxScalarBytes) || maxScalarBytes < 0) {
            throw new RangeError('The JSON scalar byte limit must be a non-negative safe integer.');
        }
    }

    public override _transform(
        chunk: Buffer,
        _encoding: BufferEncoding,
        callback: TransformCallback,
    ): void {
        try {
            let index = 0;
            while (index < chunk.length) {
                if (this.mode === 'string') {
                    index = this.scanStringRun(chunk, index);
                } else {
                    this.scanByte(chunk[index]);
                    index += 1;
                }
            }
            this.push(chunk);
            callback();
        } catch (error) {
            callback(error instanceof Error ? error : new Error(String(error)));
        }
    }

    public override _flush(callback: TransformCallback): void {
        try {
            this.flushPendingHighSurrogate();
            callback();
        } catch (error) {
            callback(error instanceof Error ? error : new Error(String(error)));
        }
    }

    private scanStringRun(chunk: Buffer, start: number): number {
        const quote = chunk.indexOf(DOUBLE_QUOTE, start);
        const runEnd = quote < 0 ? chunk.length : quote;
        const backslashOffset = chunk.subarray(start, runEnd).indexOf(BACKSLASH);
        const end = backslashOffset < 0 ? runEnd : start + backslashOffset;
        if (end > start) {
            this.flushPendingHighSurrogate();
            this.addScalarBytes(end - start);
        }
        if (end === chunk.length) {
            return end;
        }
        if (chunk[end] === DOUBLE_QUOTE) {
            this.flushPendingHighSurrogate();
            this.mode = 'outside';
            this.scalarBytes = 0;
        } else {
            this.mode = 'escape';
        }
        return end + 1;
    }

    private scanByte(byte: number): void {
        if (this.mode === 'number') {
            if (isNumberByte(byte)) {
                this.addScalarBytes(1);
                return;
            }
            this.mode = 'outside';
            this.scalarBytes = 0;
        }

        if (this.mode === 'outside') {
            if (byte === DOUBLE_QUOTE) {
                this.mode = 'string';
                this.scalarBytes = 0;
                this.pendingHighSurrogate = false;
            } else if (byte === MINUS_SIGN || isDigit(byte)) {
                this.mode = 'number';
                this.scalarBytes = 0;
                this.addScalarBytes(1);
            }
            return;
        }

        if (this.mode === 'escape') {
            if (byte === LOWERCASE_U) {
                this.mode = 'unicode';
                this.unicodeCodeUnit = 0;
                this.unicodeDigits = 0;
            } else {
                this.flushPendingHighSurrogate();
                this.addScalarBytes(1);
                this.mode = 'string';
            }
            return;
        }

        if (this.mode === 'unicode') {
            this.unicodeCodeUnit = (this.unicodeCodeUnit << 4) | hexValue(byte);
            this.unicodeDigits += 1;
            if (this.unicodeDigits === 4) {
                this.countEscapedCodeUnit(this.unicodeCodeUnit);
                this.mode = 'string';
            }
            return;
        }

        if (byte === DOUBLE_QUOTE) {
            this.flushPendingHighSurrogate();
            this.mode = 'outside';
            this.scalarBytes = 0;
        } else if (byte === BACKSLASH) {
            this.mode = 'escape';
        } else {
            this.flushPendingHighSurrogate();
            this.addScalarBytes(1);
        }
    }

    private countEscapedCodeUnit(codeUnit: number): void {
        if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
            this.flushPendingHighSurrogate();
            this.pendingHighSurrogate = true;
            return;
        }
        if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff && this.pendingHighSurrogate) {
            this.addScalarBytes(4);
            this.pendingHighSurrogate = false;
            return;
        }

        this.flushPendingHighSurrogate();
        this.addScalarBytes(utf8BytesForCodeUnit(codeUnit));
    }

    private flushPendingHighSurrogate(): void {
        if (!this.pendingHighSurrogate) {
            return;
        }
        this.addScalarBytes(3);
        this.pendingHighSurrogate = false;
    }

    private addScalarBytes(bytes: number): void {
        this.scalarBytes += bytes;
        if (this.scalarBytes > this.maxScalarBytes) {
            throw new Error(YOMITAN_JSON_SCALAR_LIMIT_ERROR);
        }
    }
}

export function createJsonScalarLimitTransform(
    maxScalarBytes = MAX_YOMITAN_JSON_SCALAR_BYTES,
): JsonScalarLimitTransform {
    return new JsonScalarLimitTransform(maxScalarBytes);
}
