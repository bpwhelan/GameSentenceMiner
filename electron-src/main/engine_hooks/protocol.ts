export interface EngineHookPositionedCode {
    engineIndex: number;
    /**
     * The character drawn, where the engine exposes one. Engines that position
     * glyphs without naming them report `0` and supply `candidates` instead.
     */
    code: number;
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface EngineHookReadyMessage {
    schema: 'gsm_engine_hook_message_v1';
    type: 'ready';
    integrationId: string;
    diagnostics: Record<string, unknown>;
}

export interface EngineHookDiagnosticMessage {
    schema: 'gsm_engine_hook_message_v1';
    type: 'diagnostic';
    level: 'info' | 'warn' | 'error';
    message: string;
}

export interface EngineHookTextLayoutMessage {
    schema: 'gsm_engine_hook_message_v1';
    type: 'text-layout';
    integrationId: string;
    sequence: number;
    capturedAt: number;
    callerOffset: string | null;
    mode: number;
    style: number;
    coordinateSpace: {
        kind: 'engine-logical';
        width: number;
        height: number;
    };
    positionedCodes: EngineHookPositionedCode[];
    /**
     * Strings the engine emitted for this line, newest last. Present only for
     * engines whose glyph positions carry no character, where the displayed text
     * has to be identified by reconciling one of these against the glyphs.
     */
    candidates?: string[];
}

export type EngineHookMessage =
    | EngineHookReadyMessage
    | EngineHookDiagnosticMessage
    | EngineHookTextLayoutMessage;

const MAX_CODES = 2000;
const MAX_CANDIDATES = 32;
const MAX_CANDIDATE_LENGTH = 2000;
const MAX_COORDINATE_SPACE = 16_384;
const MAX_ABSOLUTE_COORDINATE = 32_768;
const MAX_GLYPH_DIMENSION = 4096;
const MAX_RENDER_SCALE = 16;

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function integer(value: unknown, minimum: number, maximum: number): number | null {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
        return null;
    }
    return value;
}

function finiteNumber(value: unknown, minimum: number, maximum: number): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
        return null;
    }
    return value;
}

export function deriveEngineLogicalCoordinateSpace(value: unknown): {
    kind: 'engine-logical';
    width: number;
    height: number;
} | null {
    if (!isObject(value) || value.kind !== 'scaled-window-client') return null;
    const clientWidth = integer(value.clientWidth, 1, MAX_COORDINATE_SPACE);
    const clientHeight = integer(value.clientHeight, 1, MAX_COORDINATE_SPACE);
    const scaleX = finiteNumber(value.scaleX, Number.EPSILON, MAX_RENDER_SCALE);
    const scaleY = finiteNumber(value.scaleY, Number.EPSILON, MAX_RENDER_SCALE);
    if (clientWidth === null || clientHeight === null || scaleX === null || scaleY === null) {
        return null;
    }
    const width = Math.round(clientWidth / scaleX);
    const height = Math.round(clientHeight / scaleY);
    if (
        width < 1 ||
        height < 1 ||
        width > MAX_COORDINATE_SPACE ||
        height > MAX_COORDINATE_SPACE
    ) {
        return null;
    }
    return { kind: 'engine-logical', width, height };
}

function string(value: unknown, maximumLength = 256): string | null {
    return typeof value === 'string' && value.length > 0 && value.length <= maximumLength ? value : null;
}

export function sanitizeEngineHookMessage(value: unknown): EngineHookMessage | null {
    if (!isObject(value) || value.schema !== 'gsm_engine_hook_message_v1') return null;
    if (value.type === 'ready') {
        const integrationId = string(value.integrationId);
        if (!integrationId || !isObject(value.diagnostics)) return null;
        return { schema: 'gsm_engine_hook_message_v1', type: 'ready', integrationId, diagnostics: value.diagnostics };
    }
    if (value.type === 'diagnostic') {
        const level = value.level;
        const message = string(value.message, 2000);
        if ((level !== 'info' && level !== 'warn' && level !== 'error') || !message) return null;
        return { schema: 'gsm_engine_hook_message_v1', type: 'diagnostic', level, message };
    }
    if (value.type !== 'text-layout') return null;

    const integrationId = string(value.integrationId);
    const sequence = integer(value.sequence, 0, Number.MAX_SAFE_INTEGER);
    const capturedAt = integer(value.capturedAt, 0, Number.MAX_SAFE_INTEGER);
    const mode = integer(value.mode, 0, 255);
    const style = integer(value.style, 0, 255);
    const coordinateSpace = deriveEngineLogicalCoordinateSpace(value.coordinateSpace);
    const callerOffset = value.callerOffset === null ? null : string(value.callerOffset, 32);
    if (
        !integrationId ||
        sequence === null ||
        capturedAt === null ||
        mode === null ||
        style === null ||
        coordinateSpace === null ||
        (value.callerOffset !== null && callerOffset === null) ||
        !Array.isArray(value.positionedCodes) ||
        value.positionedCodes.length === 0 ||
        value.positionedCodes.length > MAX_CODES
    ) {
        return null;
    }

    const positionedCodes: EngineHookPositionedCode[] = [];
    for (const candidate of value.positionedCodes) {
        if (!isObject(candidate)) return null;
        const engineIndex = integer(candidate.engineIndex, 0, MAX_CODES - 1);
        const code = integer(candidate.code, 0, 0x10ffff);
        const x = integer(candidate.x, -MAX_ABSOLUTE_COORDINATE, MAX_ABSOLUTE_COORDINATE);
        const y = integer(candidate.y, -MAX_ABSOLUTE_COORDINATE, MAX_ABSOLUTE_COORDINATE);
        const width = integer(candidate.width, 0, MAX_GLYPH_DIMENSION);
        const height = integer(candidate.height, 0, MAX_GLYPH_DIMENSION);
        if (
            engineIndex === null ||
            code === null ||
            x === null ||
            y === null ||
            width === null ||
            height === null
        ) {
            return null;
        }
        positionedCodes.push({ engineIndex, code, x, y, width, height });
    }

    const candidates: string[] = [];
    if (value.candidates !== undefined) {
        if (!Array.isArray(value.candidates) || value.candidates.length > MAX_CANDIDATES) return null;
        for (const candidate of value.candidates) {
            const text = string(candidate, MAX_CANDIDATE_LENGTH);
            if (text === null) return null;
            candidates.push(text);
        }
    }

    return {
        schema: 'gsm_engine_hook_message_v1',
        type: 'text-layout',
        integrationId,
        sequence,
        capturedAt,
        callerOffset,
        mode,
        style,
        coordinateSpace,
        positionedCodes,
        ...(candidates.length > 0 ? { candidates } : {}),
    };
}
