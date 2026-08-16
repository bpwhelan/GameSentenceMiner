import * as fs from 'node:fs';
import * as path from 'node:path';

import { applyMagesCharsetOverrides, parseMagesCompoundMap } from './mages_decoder.js';

interface EngineHookManifestBase {
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
}

type EngineHookCoordinateSpace =
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

type EngineHookAdvance =
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

export interface EngineHookMagesManifest extends EngineHookManifestBase {
    decoder: 'mages-v1';
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

export interface EngineHookVlrManifest extends EngineHookManifestBase {
    decoder: 'vlr-v1';
    signatures: {
        textBuilder: string;
        alternativeTextBuilder?: string;
        lineLayout: string;
        alternativeLineLayout?: string;
    };
    memory: {
        kind: 'vlr-text-layout-v1';
        textObject: {
            entriesOffset: string;
            countOffset: string;
            glyphHeightOffset: string;
            maximumXOffset: string;
            maximumYOffset: string;
            originXOffset: string;
            originYOffset: string;
        };
        entry: {
            stride: number;
            typeOffset: string;
            xOffset: string;
            yOffset: string;
            widthOffset: string;
            codeOffset: string;
            visibleType: number;
        };
        maximumEntries: number;
    };
    capture: {
        acceptedModes: number[];
        requiredTerminator: 'K-or-P';
    };
}

export interface EngineHookBgiManifest extends EngineHookManifestBase {
    decoder: 'bgi-v1';
    signatures: {
        glyphDraw: string;
        textCapture: string;
        copyDispatcher: string;
        surfaceLock: string;
    };
}

export type EngineHookManifest =
    | EngineHookMagesManifest
    | EngineHookVlrManifest
    | EngineHookBgiManifest;

export interface EngineHookSupport {
    directory: string;
    manifest: EngineHookManifest;
    payloadSource: string;
    charset?: string;
    compoundCharacters?: Map<string, string>;
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

export function parseEngineHookManifest(value: unknown): EngineHookManifest {
    const root = object(value, 'manifest');
    if (root.schema !== 'gsm_engine_hook_manifest_v1') throw new Error('Unsupported engine-hook manifest schema.');
    const target = object(root.target, 'target');
    const coordinateSpace = object(root.coordinateSpace, 'coordinateSpace');
    const signatures = object(root.signatures, 'signatures');
    const advance = object(root.advance, 'advance');
    if (
        target.platform !== 'windows' ||
        (target.architecture !== 'ia32' && target.architecture !== 'x64')
    ) {
        throw new Error('Engine-hook targets must use Windows ia32 or x64.');
    }
    if (
        coordinateSpace.provider !== 'window-client-over-memory-scale' &&
        coordinateSpace.provider !== 'window-client-over-design-space' &&
        coordinateSpace.provider !== 'payload-client-pixels'
    ) {
        throw new Error(
            'coordinateSpace.provider must be window-client-over-memory-scale, ' +
                'window-client-over-design-space, or payload-client-pixels.',
        );
    }
    const hasExecutableNames = Array.isArray(target.executableNames) && target.executableNames.length > 0;
    const hasVersionMarkers = Array.isArray(target.versionMarkers) && target.versionMarkers.length > 0;
    if (!hasExecutableNames && !hasVersionMarkers) {
        throw new Error('target must declare executableNames or versionMarkers.');
    }
    const executableNames = hasExecutableNames
        ? (target.executableNames as unknown[]).map((entry, index) =>
              nonEmptyString(entry, `target.executableNames[${index}]`),
          )
        : undefined;
    const versionMarkers = hasVersionMarkers
        ? (target.versionMarkers as unknown[]).map((entry, index) =>
              nonEmptyString(entry, `target.versionMarkers[${index}]`),
          )
        : undefined;
    const knownExecutableSha256 = target.knownExecutableSha256;
    if (
        knownExecutableSha256 !== undefined &&
        (!Array.isArray(knownExecutableSha256) ||
            knownExecutableSha256.some((entry) => typeof entry !== 'string' || !/^[0-9a-f]{64}$/iu.test(entry)))
    ) {
        throw new Error('target.knownExecutableSha256 must contain SHA-256 hashes.');
    }

    const advanceConfig: EngineHookAdvance =
        advance.method === 'foreground-key'
            ? {
                  method: 'foreground-key',
                  virtualKey: positiveInteger(advance.virtualKey, 'advance.virtualKey', 255),
                  scanCode: positiveInteger(advance.scanCode, 'advance.scanCode', 255),
              }
            : advance.method === 'foreground-click'
              ? {
                    method: 'foreground-click',
                    clientXRatio: unitRatio(advance.clientXRatio, 'advance.clientXRatio'),
                    clientYRatio: unitRatio(advance.clientYRatio, 'advance.clientYRatio'),
                }
              : (() => {
                    throw new Error('advance.method must be foreground-key or foreground-click.');
                })();

    const coordinateSpaceConfig: EngineHookCoordinateSpace =
        coordinateSpace.provider === 'window-client-over-memory-scale'
            ? {
                  provider: 'window-client-over-memory-scale',
                  scaleXRva: rva(coordinateSpace.scaleXRva, 'coordinateSpace.scaleXRva'),
                  scaleYRva: rva(coordinateSpace.scaleYRva, 'coordinateSpace.scaleYRva'),
              }
            : coordinateSpace.provider === 'window-client-over-design-space'
              ? {
                    provider: 'window-client-over-design-space',
                    designWidth: positiveInteger(
                        coordinateSpace.designWidth,
                        'coordinateSpace.designWidth',
                        16384,
                    ),
                    designHeight: positiveInteger(
                        coordinateSpace.designHeight,
                        'coordinateSpace.designHeight',
                        16384,
                    ),
                }
              : { provider: 'payload-client-pixels' };

    const common = {
        schema: 'gsm_engine_hook_manifest_v1',
        id: nonEmptyString(root.id, 'id'),
        name: nonEmptyString(root.name, 'name'),
        engine: nonEmptyString(root.engine, 'engine'),
        target: {
            platform: 'windows',
            architecture: target.architecture,
            ...(target.moduleName === undefined
                ? {}
                : { moduleName: nonEmptyString(target.moduleName, 'target.moduleName') }),
            ...(executableNames ? { executableNames } : {}),
            ...(versionMarkers ? { versionMarkers } : {}),
            ...(knownExecutableSha256
                ? { knownExecutableSha256: knownExecutableSha256.map((hash) => hash.toLowerCase()) }
                : {}),
        },
        coordinateSpace: coordinateSpaceConfig,
        payload: relativeAssetPath(root.payload, 'payload'),
        advance: advanceConfig,
    } as const;

    // Only the memory-reading decoders declare memory layouts and capture modes, so
    // those blocks are validated per decoder rather than for every manifest.
    function requireCaptureModes(): number[] {
        const capture = object(root.capture, 'capture');
        if (
            !Array.isArray(capture.acceptedModes) ||
            capture.acceptedModes.length === 0 ||
            capture.acceptedModes.some(
                (entry) => typeof entry !== 'number' || !Number.isInteger(entry) || entry < 0 || entry > 255,
            )
        ) {
            throw new Error('capture.acceptedModes must contain byte-sized integers.');
        }
        return [...(capture.acceptedModes as number[])];
    }

    function requireModuleName(): string {
        if (common.target.moduleName === undefined) {
            throw new Error('target.moduleName must be a non-empty string.');
        }
        return common.target.moduleName;
    }

    if (root.decoder === 'bgi-v1') {
        if (coordinateSpaceConfig.provider !== 'payload-client-pixels') {
            throw new Error('bgi-v1 coordinateSpace.provider must be payload-client-pixels.');
        }
        return {
            ...common,
            decoder: 'bgi-v1',
            signatures: {
                glyphDraw: nonEmptyString(signatures.glyphDraw, 'signatures.glyphDraw'),
                textCapture: nonEmptyString(signatures.textCapture, 'signatures.textCapture'),
                copyDispatcher: nonEmptyString(signatures.copyDispatcher, 'signatures.copyDispatcher'),
                surfaceLock: nonEmptyString(signatures.surfaceLock, 'signatures.surfaceLock'),
            },
        };
    }

    if (root.decoder === 'mages-v1') {
        const resources = object(root.resources, 'resources');
        const memory = object(root.memory, 'memory');
        const acceptedModes = requireCaptureModes();
        requireModuleName();
        return {
            ...common,
            decoder: 'mages-v1',
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
            signatures: {
                textBuilder: nonEmptyString(signatures.textBuilder, 'signatures.textBuilder'),
                lineLayout: nonEmptyString(signatures.lineLayout, 'signatures.lineLayout'),
            },
            memory: {
                codeCountRva: rva(memory.codeCountRva, 'memory.codeCountRva'),
                codesRva: rva(memory.codesRva, 'memory.codesRva'),
                metricsRva: rva(memory.metricsRva, 'memory.metricsRva'),
                positionsRva: rva(memory.positionsRva, 'memory.positionsRva'),
                metricStride: positiveInteger(memory.metricStride, 'memory.metricStride', 256),
                positionStride: positiveInteger(memory.positionStride, 'memory.positionStride', 256),
                maximumCodes: positiveInteger(memory.maximumCodes, 'memory.maximumCodes', 2000),
            },
            capture: { acceptedModes },
        };
    }

    if (root.decoder === 'vlr-v1') {
        const memory = object(root.memory, 'memory');
        const capture = object(root.capture, 'capture');
        const acceptedModes = requireCaptureModes();
        requireModuleName();
        const textObject = object(memory.textObject, 'memory.textObject');
        const entry = object(memory.entry, 'memory.entry');
        if (memory.kind !== 'vlr-text-layout-v1') {
            throw new Error('memory.kind must be vlr-text-layout-v1.');
        }
        if (capture.requiredTerminator !== 'K-or-P') {
            throw new Error('capture.requiredTerminator must be K-or-P.');
        }
        const visibleType = positiveInteger(entry.visibleType, 'memory.entry.visibleType', 255);
        const requiredTerminator = 'K-or-P' as const;
        return {
            ...common,
            decoder: 'vlr-v1',
            signatures: {
                textBuilder: nonEmptyString(signatures.textBuilder, 'signatures.textBuilder'),
                ...(signatures.alternativeTextBuilder === undefined
                    ? {}
                    : {
                          alternativeTextBuilder: nonEmptyString(
                              signatures.alternativeTextBuilder,
                              'signatures.alternativeTextBuilder',
                          ),
                      }),
                ...(signatures.alternativeLineLayout === undefined
                    ? {}
                    : {
                          alternativeLineLayout: nonEmptyString(
                              signatures.alternativeLineLayout,
                              'signatures.alternativeLineLayout',
                          ),
                      }),
                lineLayout: nonEmptyString(signatures.lineLayout, 'signatures.lineLayout'),
            },
            memory: {
                kind: 'vlr-text-layout-v1',
                textObject: {
                    entriesOffset: rva(textObject.entriesOffset, 'memory.textObject.entriesOffset'),
                    countOffset: rva(textObject.countOffset, 'memory.textObject.countOffset'),
                    glyphHeightOffset: rva(
                        textObject.glyphHeightOffset,
                        'memory.textObject.glyphHeightOffset',
                    ),
                    maximumXOffset: rva(textObject.maximumXOffset, 'memory.textObject.maximumXOffset'),
                    maximumYOffset: rva(textObject.maximumYOffset, 'memory.textObject.maximumYOffset'),
                    originXOffset: rva(textObject.originXOffset, 'memory.textObject.originXOffset'),
                    originYOffset: rva(textObject.originYOffset, 'memory.textObject.originYOffset'),
                },
                entry: {
                    stride: positiveInteger(entry.stride, 'memory.entry.stride', 256),
                    typeOffset: rva(entry.typeOffset, 'memory.entry.typeOffset'),
                    xOffset: rva(entry.xOffset, 'memory.entry.xOffset'),
                    yOffset: rva(entry.yOffset, 'memory.entry.yOffset'),
                    widthOffset: rva(entry.widthOffset, 'memory.entry.widthOffset'),
                    codeOffset: rva(entry.codeOffset, 'memory.entry.codeOffset'),
                    visibleType,
                },
                maximumEntries: positiveInteger(memory.maximumEntries, 'memory.maximumEntries', 512),
            },
            capture: { acceptedModes, requiredTerminator },
        };
    }

    throw new Error('Unsupported engine-hook decoder.');
}

export function loadEngineHookSupport(directory: string): EngineHookSupport {
    const manifestPath = path.join(directory, 'manifest.json');
    const manifest = parseEngineHookManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
    const payloadSource = fs.readFileSync(path.join(directory, manifest.payload), 'utf8');
    // Only MAGES needs character resources; the others carry Unicode already.
    if (manifest.decoder !== 'mages-v1') return { directory, manifest, payloadSource };
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
 * markers used are engine identity strings, such as the BURIKO interpreter banner,
 * that appear nowhere else.
 */
export function executableContainsVersionMarkers(
    contents: Buffer,
    markers: readonly string[],
): boolean {
    return markers.every((marker) => contents.includes(Buffer.from(marker, 'utf16le')));
}

export function resolveEngineHookSupport(
    directory: string,
    target: {
        exeName: string;
        arch: 'x86' | 'x64';
        executableSha256?: string;
        executableContents?: Buffer;
    },
): EngineHookSupport {
    const architecture = target.arch === 'x86' ? 'ia32' : 'x64';
    // Engine hooks are intentionally opt-in experiments. The target process
    // name is useful for logging, but it is not a compatibility boundary:
    // different games can use the same engine under different executable names.
    //
    // A package covering a whole engine says so with version markers, and is
    // considered only for executables carrying them. Without that, an
    // engine-wide package would be the fallback for every unrecognised game,
    // because it is the one package with no build hash to disqualify it.
    const candidates = loadEngineHookCatalog(directory).filter((support) => {
        if (support.manifest.target.architecture !== architecture) return false;
        const markers = support.manifest.target.versionMarkers;
        if (!markers) return true;
        return (
            target.executableContents !== undefined &&
            executableContainsVersionMarkers(target.executableContents, markers)
        );
    });
    // A hash is useful for selecting between packages, but it should not prevent
    // users from trying a unique engine package against another build of the
    // same engine. Runtime signature checks remain the compatibility gate.
    const hashMatches = target.executableSha256
        ? candidates.filter((support) =>
              support.manifest.target.knownExecutableSha256?.includes(
                  target.executableSha256!.toLowerCase(),
              ),
          )
        : [];
    const hashIndependentCandidates = candidates.filter(
        (support) => !support.manifest.target.knownExecutableSha256,
    );
    const matchingBuilds =
        hashMatches.length > 0
            ? hashMatches
            : hashIndependentCandidates.length > 0
              ? hashIndependentCandidates
              : candidates;
    if (matchingBuilds.length !== 1) {
        const reason =
            matchingBuilds.length === 0
                ? 'no matching support packages were found'
                : `found ${matchingBuilds.length} matching support packages`;
        throw new Error(`No unambiguous engine-hook support for ${target.exeName} (${target.arch}): ${reason}.`);
    }
    return matchingBuilds[0];
}
