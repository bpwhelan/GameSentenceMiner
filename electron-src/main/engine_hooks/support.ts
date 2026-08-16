import * as fs from 'node:fs';
import * as path from 'node:path';

import { applyMagesCharsetOverrides, parseMagesCompoundMap } from './mages_decoder.js';

export interface EngineHookTarget {
    platform: 'windows';
    architecture: 'ia32' | 'x64';
    /** Absent when the module is the executable itself, whatever it is named. */
    moduleName?: string;
    executableNames?: string[];
    knownExecutableSha256?: string[];
    /**
     * UTF-16 strings that must all appear in the executable. Engines whose games
     * each rename the executable are identified by their version resource instead
     * of by file name.
     */
    versionMarkers?: string[];
}

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

interface EngineHookManifestBase {
    schema: 'gsm_engine_hook_manifest_v1';
    id: string;
    name: string;
    engine: string;
    target: EngineHookTarget;
    payload: string;
    advance: EngineHookAdvance;
}

export interface MagesEngineHookManifest extends EngineHookManifestBase {
    decoder: 'mages-v1';
    coordinateSpace: {
        provider: 'window-client-over-memory-scale';
        scaleXRva: string;
        scaleYRva: string;
    };
    resources: {
        charset: string;
        charsetOverrides?: string;
        compoundCharacters: string;
    };
    signatures: {
        textBuilder: string;
        lineLayout: string;
    };
    memory: {
        codeCountRva: string;
        codesRva: string;
        metricsRva: string;
        positionsRva: string;
        metricStride: number;
        positionStride: number;
        maximumCodes: number;
    };
    capture: {
        acceptedModes: number[];
    };
}

export interface BgiEngineHookManifest extends EngineHookManifestBase {
    decoder: 'bgi-v1';
    /**
     * The payload resolves glyphs to client pixels itself, by following the engine's
     * own surface copies, so nothing about the coordinate space is configured.
     */
    coordinateSpace: {
        provider: 'payload-client-pixels';
    };
    signatures: {
        glyphDraw: string;
        textCapture: string;
        copyDispatcher: string;
        surfaceLock: string;
    };
}

export type EngineHookManifest = MagesEngineHookManifest | BgiEngineHookManifest;

export interface EngineHookSupport {
    directory: string;
    manifest: EngineHookManifest;
    payloadSource: string;
    /** MAGES only; BGI text arrives as Unicode and needs no charset. */
    charset: string;
    compoundCharacters: Map<string, string>;
}

function object(value: unknown, label: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null) throw new Error(`${label} must be an object.`);
    return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
    return value;
}

function positiveInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > maximum) {
        throw new Error(`${label} must be a positive integer.`);
    }
    return value;
}

function unitRatio(value: unknown, label: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value >= 1) {
        throw new Error(`${label} must be a number between zero and one.`);
    }
    return value;
}

function relativeAssetPath(value: unknown, label: string): string {
    const candidate = nonEmptyString(value, label);
    if (path.isAbsolute(candidate) || candidate.split(/[\\/]/u).includes('..')) {
        throw new Error(`${label} must stay inside the support package.`);
    }
    return candidate;
}

function rva(value: unknown, label: string): string {
    const candidate = nonEmptyString(value, label);
    if (!/^0x[0-9a-f]+$/iu.test(candidate)) throw new Error(`${label} must be a hexadecimal RVA.`);
    return candidate;
}

function parseTarget(value: unknown): EngineHookTarget {
    const target = object(value, 'target');
    if (
        target.platform !== 'windows' ||
        (target.architecture !== 'ia32' && target.architecture !== 'x64')
    ) {
        throw new Error('Engine-hook targets must use Windows ia32 or x64.');
    }
    const hasNames = Array.isArray(target.executableNames) && target.executableNames.length > 0;
    const hasMarkers = Array.isArray(target.versionMarkers) && target.versionMarkers.length > 0;
    if (!hasNames && !hasMarkers) {
        throw new Error('target must match on executableNames or versionMarkers.');
    }
    const knownExecutableSha256 = target.knownExecutableSha256;
    if (
        knownExecutableSha256 !== undefined &&
        (!Array.isArray(knownExecutableSha256) ||
            knownExecutableSha256.some((entry) => typeof entry !== 'string' || !/^[0-9a-f]{64}$/iu.test(entry)))
    ) {
        throw new Error('target.knownExecutableSha256 must contain SHA-256 hashes.');
    }
    return {
        platform: 'windows',
        architecture: target.architecture,
        ...(target.moduleName === undefined
            ? {}
            : { moduleName: nonEmptyString(target.moduleName, 'target.moduleName') }),
        ...(hasNames
            ? {
                  executableNames: (target.executableNames as unknown[]).map((entry, index) =>
                      nonEmptyString(entry, `target.executableNames[${index}]`),
                  ),
              }
            : {}),
        ...(hasMarkers
            ? {
                  versionMarkers: (target.versionMarkers as unknown[]).map((entry, index) =>
                      nonEmptyString(entry, `target.versionMarkers[${index}]`),
                  ),
              }
            : {}),
        ...(knownExecutableSha256
            ? { knownExecutableSha256: knownExecutableSha256.map((hash) => hash.toLowerCase()) }
            : {}),
    };
}

function parseAdvance(value: unknown): EngineHookAdvance {
    const advance = object(value, 'advance');
    if (advance.method === 'foreground-key') {
        return {
            method: 'foreground-key',
            virtualKey: positiveInteger(advance.virtualKey, 'advance.virtualKey', 255),
            scanCode: positiveInteger(advance.scanCode, 'advance.scanCode', 255),
        };
    }
    if (advance.method === 'foreground-click') {
        return {
            method: 'foreground-click',
            clientXRatio: unitRatio(advance.clientXRatio, 'advance.clientXRatio'),
            clientYRatio: unitRatio(advance.clientYRatio, 'advance.clientYRatio'),
        };
    }
    throw new Error('advance.method must be foreground-key or foreground-click.');
}

function parseSignatures<K extends string>(value: unknown, keys: readonly K[]): Record<K, string> {
    const signatures = object(value, 'signatures');
    const result = {} as Record<K, string>;
    for (const key of keys) result[key] = nonEmptyString(signatures[key], `signatures.${key}`);
    return result;
}

export function parseEngineHookManifest(value: unknown): EngineHookManifest {
    const root = object(value, 'manifest');
    if (root.schema !== 'gsm_engine_hook_manifest_v1') throw new Error('Unsupported engine-hook manifest schema.');
    const base = {
        schema: 'gsm_engine_hook_manifest_v1',
        id: nonEmptyString(root.id, 'id'),
        name: nonEmptyString(root.name, 'name'),
        engine: nonEmptyString(root.engine, 'engine'),
        target: parseTarget(root.target),
        payload: relativeAssetPath(root.payload, 'payload'),
        advance: parseAdvance(root.advance),
    } as const;

    if (root.decoder === 'bgi-v1') {
        const coordinateSpace = object(root.coordinateSpace, 'coordinateSpace');
        if (coordinateSpace.provider !== 'payload-client-pixels') {
            throw new Error('bgi-v1 coordinateSpace.provider must be payload-client-pixels.');
        }
        return {
            ...base,
            decoder: 'bgi-v1',
            coordinateSpace: { provider: 'payload-client-pixels' },
            signatures: parseSignatures(root.signatures, [
                'glyphDraw',
                'textCapture',
                'copyDispatcher',
                'surfaceLock',
            ]),
        };
    }

    if (root.decoder !== 'mages-v1') throw new Error('Unsupported engine-hook decoder.');

    const coordinateSpace = object(root.coordinateSpace, 'coordinateSpace');
    const resources = object(root.resources, 'resources');
    const memory = object(root.memory, 'memory');
    const capture = object(root.capture, 'capture');
    if (coordinateSpace.provider !== 'window-client-over-memory-scale') {
        throw new Error('coordinateSpace.provider must be window-client-over-memory-scale.');
    }
    if (
        !Array.isArray(capture.acceptedModes) ||
        capture.acceptedModes.length === 0 ||
        capture.acceptedModes.some(
            (entry) => typeof entry !== 'number' || !Number.isInteger(entry) || entry < 0 || entry > 255,
        )
    ) {
        throw new Error('capture.acceptedModes must contain byte-sized integers.');
    }
    if (base.target.moduleName === undefined) {
        throw new Error('target.moduleName must be a non-empty string.');
    }

    return {
        ...base,
        decoder: 'mages-v1',
        coordinateSpace: {
            provider: 'window-client-over-memory-scale',
            scaleXRva: rva(coordinateSpace.scaleXRva, 'coordinateSpace.scaleXRva'),
            scaleYRva: rva(coordinateSpace.scaleYRva, 'coordinateSpace.scaleYRva'),
        },
        resources: {
            charset: relativeAssetPath(resources.charset, 'resources.charset'),
            ...(resources.charsetOverrides === undefined
                ? {}
                : {
                      charsetOverrides: relativeAssetPath(
                          resources.charsetOverrides,
                          'resources.charsetOverrides',
                      ),
                  }),
            compoundCharacters: relativeAssetPath(
                resources.compoundCharacters,
                'resources.compoundCharacters',
            ),
        },
        signatures: parseSignatures(root.signatures, ['textBuilder', 'lineLayout']),
        memory: {
            codeCountRva: rva(memory.codeCountRva, 'memory.codeCountRva'),
            codesRva: rva(memory.codesRva, 'memory.codesRva'),
            metricsRva: rva(memory.metricsRva, 'memory.metricsRva'),
            positionsRva: rva(memory.positionsRva, 'memory.positionsRva'),
            metricStride: positiveInteger(memory.metricStride, 'memory.metricStride', 256),
            positionStride: positiveInteger(memory.positionStride, 'memory.positionStride', 256),
            maximumCodes: positiveInteger(memory.maximumCodes, 'memory.maximumCodes', 2000),
        },
        capture: {
            acceptedModes: [...capture.acceptedModes],
        },
    };
}

export function loadEngineHookSupport(directory: string): EngineHookSupport {
    const manifestPath = path.join(directory, 'manifest.json');
    const manifest = parseEngineHookManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
    const payloadSource = fs.readFileSync(path.join(directory, manifest.payload), 'utf8');
    if (manifest.decoder !== 'mages-v1') {
        return { directory, manifest, payloadSource, charset: '', compoundCharacters: new Map() };
    }
    const rawCharset = fs.readFileSync(path.join(directory, manifest.resources.charset), 'utf8');
    const charset = manifest.resources.charsetOverrides
        ? applyMagesCharsetOverrides(
              rawCharset,
              JSON.parse(
                  fs.readFileSync(
                      path.join(directory, manifest.resources.charsetOverrides),
                      'utf8',
                  ),
              ),
          )
        : rawCharset;
    const compoundMapContents = fs.readFileSync(
        path.join(directory, manifest.resources.compoundCharacters),
        'utf8',
    );
    return {
        directory,
        manifest,
        payloadSource,
        charset,
        compoundCharacters: parseMagesCompoundMap(compoundMapContents),
    };
}

export function createInjectedPayloadSource(support: EngineHookSupport): string {
    return `globalThis.__GSM_ENGINE_HOOK_CONFIG__ = ${JSON.stringify(support.manifest)};\n${support.payloadSource}`;
}

export function loadEngineHookCatalog(directory: string): EngineHookSupport[] {
    if (!fs.existsSync(directory)) return [];
    return fs
        .readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(directory, entry.name))
        .filter((candidate) => fs.existsSync(path.join(candidate, 'manifest.json')))
        .sort((left, right) => left.localeCompare(right))
        .map(loadEngineHookSupport);
}

/**
 * Reports whether an executable's bytes contain every marker as a UTF-16 string.
 *
 * This is a substring probe over the file, not a parsed version resource: the
 * markers used are engine identity strings such as the BURIKO interpreter banner,
 * which appear nowhere else, and every game on such an engine renames its
 * executable so the file name cannot identify it.
 */
export function executableContainsVersionMarkers(
    contents: Buffer,
    markers: readonly string[],
): boolean {
    return markers.every((marker) => contents.includes(Buffer.from(marker, 'utf16le')));
}

export interface EngineHookTargetDescription {
    exeName: string;
    arch: 'x86' | 'x64';
    executableSha256?: string;
    executableContents?: Buffer;
}

function targetMatches(manifest: EngineHookManifest, target: EngineHookTargetDescription): boolean {
    const names = manifest.target.executableNames;
    if (names?.some((name) => name.toLowerCase() === target.exeName.toLowerCase())) return true;
    const markers = manifest.target.versionMarkers;
    if (!markers || !target.executableContents) return false;
    return executableContainsVersionMarkers(target.executableContents, markers);
}

export function resolveEngineHookSupport(
    directory: string,
    target: EngineHookTargetDescription,
): EngineHookSupport {
    const architecture = target.arch === 'x86' ? 'ia32' : 'x64';
    const candidates = loadEngineHookCatalog(directory).filter(
        (support) =>
            support.manifest.target.architecture === architecture && targetMatches(support.manifest, target),
    );
    const matchingBuilds = target.executableSha256
        ? candidates.filter((support) => {
              const knownHashes = support.manifest.target.knownExecutableSha256;
              return !knownHashes || knownHashes.includes(target.executableSha256!.toLowerCase());
          })
        : candidates.filter((support) => !support.manifest.target.knownExecutableSha256);
    if (matchingBuilds.length !== 1) {
        const reason =
            !target.executableSha256 && candidates.some((support) => support.manifest.target.knownExecutableSha256)
                ? 'the executable hash could not be verified'
                : candidates.length > 0 && matchingBuilds.length === 0
                ? 'the executable hash is not supported'
                : `found ${matchingBuilds.length} matching support packages`;
        throw new Error(`No unambiguous engine-hook support for ${target.exeName} (${target.arch}): ${reason}.`);
    }
    return matchingBuilds[0];
}
