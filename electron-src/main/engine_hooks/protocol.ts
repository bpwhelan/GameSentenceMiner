import type { BgiPositionedGlyph } from './bgi_decoder.js';
import type { MagesPositionedCode } from './mages_decoder.js';

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

/**
 * What a payload reports for one displayed line. Which variant arrives is decided
 * by the shape the payload sends, so a payload never has to be changed when another
 * engine is added.
 */
export type EngineHookLayout =
    | { kind: 'mages-v1'; positionedCodes: MagesPositionedCode[] }
    /**
     * BGI hands over the candidate strings it saw alongside the glyphs, because the
     * engine emits several strings per line and only glyph arithmetic identifies
     * which one was displayed.
     */
    | { kind: 'bgi-v1'; candidates: string[]; glyphs: BgiPositionedGlyph[] };

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
    layout: EngineHookLayout;
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
    if (!isObject(value)) return null;
    // A payload that already resolved its glyphs to client pixels reports the client
    // area directly; one that reports engine-space coordinates reports the scale it
    // rendered at, and the logical space is derived from it.
    if (value.kind === 'window-client') {
        const width = integer(value.clientWidth, 1, MAX_COORDINATE_SPACE);
        const height = integer(value.clientHeight, 1, MAX_COORDINATE_SPACE);
        if (width === null || height === null) return null;
        return { kind: 'engine-logical', width, height };
    }
    if (value.kind !== 'scaled-window-client') return null;
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
        (value.callerOffset !== null && callerOffset === null)
    ) {
        return null;
    }

    const layout = sanitizeLayout(value);
    if (!layout) return null;

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
        layout,
    };
}

function sanitizeBox(
    candidate: Record<string, unknown>,
): { engineIndex: number; x: number; y: number; width: number; height: number } | null {
    const engineIndex = integer(candidate.engineIndex, 0, MAX_CODES - 1);
    const x = integer(candidate.x, -MAX_ABSOLUTE_COORDINATE, MAX_ABSOLUTE_COORDINATE);
    const y = integer(candidate.y, -MAX_ABSOLUTE_COORDINATE, MAX_ABSOLUTE_COORDINATE);
    const width = integer(candidate.width, 0, MAX_GLYPH_DIMENSION);
    const height = integer(candidate.height, 0, MAX_GLYPH_DIMENSION);
    if (engineIndex === null || x === null || y === null || width === null || height === null) {
        return null;
    }
    return { engineIndex, x, y, width, height };
}

function sanitizeLayout(value: Record<string, unknown>): EngineHookLayout | null {
    if (Array.isArray(value.positionedCodes)) {
        if (value.positionedCodes.length === 0 || value.positionedCodes.length > MAX_CODES) return null;
        const positionedCodes: MagesPositionedCode[] = [];
        for (const candidate of value.positionedCodes) {
            if (!isObject(candidate)) return null;
            const box = sanitizeBox(candidate);
            const code = integer(candidate.code, 0, 0xffff);
            if (!box || code === null) return null;
            positionedCodes.push({ ...box, code });
        }
        return { kind: 'mages-v1', positionedCodes };
    }

    if (Array.isArray(value.glyphs)) {
        if (value.glyphs.length === 0 || value.glyphs.length > MAX_CODES) return null;
        if (
            !Array.isArray(value.candidates) ||
            value.candidates.length === 0 ||
            value.candidates.length > MAX_CANDIDATES
        ) {
            return null;
        }
        const candidates: string[] = [];
        for (const candidate of value.candidates) {
            const text = string(candidate, MAX_CANDIDATE_LENGTH);
            if (text === null) return null;
            candidates.push(text);
        }
        const glyphs: BgiPositionedGlyph[] = [];
        for (const candidate of value.glyphs) {
            if (!isObject(candidate)) return null;
            const box = sanitizeBox(candidate);
            if (!box) return null;
            glyphs.push(box);
        }
        return { kind: 'bgi-v1', candidates, glyphs };
    }

    return null;
}
