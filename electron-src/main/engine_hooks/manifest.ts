import * as path from 'node:path';

import type { EngineHookTextLayoutMessage } from './protocol.js';

export interface EngineHookManifestBase {
    schema: 'gsm_engine_hook_manifest_v1';
    id: string;
    name: string;
    engine: string;
    target: {
        platform: 'windows';
        architecture: 'ia32' | 'x64';
        /** Absent when the module is the executable itself, whatever it is named. */
        moduleName?: string;
        executableNames?: string[];
        knownExecutableSha256?: string[];
        /**
         * UTF-16 strings that must all appear in the executable. Engines whose games
         * each rename the executable are identified by their version resource
         * instead of by file name.
         */
        versionMarkers?: string[];
    };
    coordinateSpace: EngineHookCoordinateSpace;
    payload: string;
    advance: EngineHookAdvance;
    display?: EngineHookDisplay;
}

export type EngineHookCoordinateSpace =
    | {
          provider: 'window-client-over-memory-scale';
          scaleXRva: string;
          scaleYRva: string;
      }
    | {
          provider: 'window-client-over-design-space';
          designWidth: number;
          designHeight: number;
      }
    | {
          /** The payload resolves glyphs to client pixels itself and reports them. */
          provider: 'payload-client-pixels';
      };

export type EngineHookAdvance =
    | {
          method: 'foreground-key';
          virtualKey: number;
          scanCode: number;
      }
    | {
          method: 'foreground-click';
          clientXRatio: number;
          clientYRatio: number;
      };

/**
 * Locale-keyed strings the support catalog owns, so a new package ships its own
 * user-facing copy instead of adding keys to every renderer locale file.
 */
export interface EngineHookDisplay {
    details: { en: string } & Record<string, string>;
}

/** The subset of every engine decoder's output that the session consumes. */
export interface DecodedEngineLayout {
    text: string;
    glyphs: {
        engineIndex: number;
        text: string;
        x: number;
        y: number;
        width: number;
        height: number;
    }[];
    lines: {
        bounds: { x: number; y: number; width: number; height: number };
        glyphStart: number;
        glyphEnd: number;
    }[];
}

export type EngineHookManifest = EngineHookManifestBase & { decoder: string };

export interface EngineHookSupport {
    directory: string;
    manifest: EngineHookManifest;
    payloadSource: string;
    /** Decoder-owned data loaded from the package; shaped by the descriptor. */
    resources?: unknown;
}

/** Validation the memory-reading decoders share but the common manifest does not require. */
export interface EngineHookManifestContext {
    requireCaptureModes(): number[];
    requireModuleName(): string;
}

export interface EngineHookDecoderDescriptor {
    decoder: string;
    validateManifest(
        root: Record<string, unknown>,
        common: EngineHookManifestBase,
        context: EngineHookManifestContext,
    ): EngineHookManifest;
    loadResources?(directory: string, manifest: EngineHookManifest): unknown;
    decodeLayout(
        message: EngineHookTextLayoutMessage,
        support: EngineHookSupport,
    ): DecodedEngineLayout | null;
}

export function object(value: unknown, label: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null) throw new Error(`${label} must be an object.`);
    return value as Record<string, unknown>;
}

export function nonEmptyString(value: unknown, label: string): string {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
    return value;
}

export function positiveInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > maximum) {
        throw new Error(`${label} must be a positive integer.`);
    }
    return value;
}

export function unitRatio(value: unknown, label: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value >= 1) {
        throw new Error(`${label} must be a number between zero and one.`);
    }
    return value;
}

export function relativeAssetPath(value: unknown, label: string): string {
    const candidate = nonEmptyString(value, label);
    if (path.isAbsolute(candidate) || candidate.split(/[\\/]/u).includes('..')) {
        throw new Error(`${label} must stay inside the support package.`);
    }
    return candidate;
}

export function rva(value: unknown, label: string): string {
    const candidate = nonEmptyString(value, label);
    if (!/^0x[0-9a-f]+$/iu.test(candidate)) throw new Error(`${label} must be a hexadecimal RVA.`);
    return candidate;
}

export function parseEngineHookDisplay(value: unknown): EngineHookDisplay | undefined {
    if (value === undefined) return undefined;
    const display = object(value, 'display');
    const details = object(display.details, 'display.details');
    // English is the renderer's fallback locale, so a package without it would
    // render blank for every locale it did not translate.
    const localized: Record<string, string> = {
        en: nonEmptyString(details.en, 'display.details.en'),
    };
    for (const [locale, text] of Object.entries(details)) {
        localized[locale] = nonEmptyString(text, `display.details.${locale}`);
    }
    return { details: localized as EngineHookDisplay['details'] };
}
