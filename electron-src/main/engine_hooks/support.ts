import * as fs from 'node:fs';
import * as path from 'node:path';

import { getEngineHookDecoder } from './decoders/index.js';
import {
    nonEmptyString,
    object,
    parseEngineHookDisplay,
    positiveInteger,
    relativeAssetPath,
    rva,
    unitRatio,
    type EngineHookAdvance,
    type EngineHookCoordinateSpace,
    type EngineHookManifest,
    type EngineHookManifestBase,
    type EngineHookSupport,
} from './manifest.js';

export type {
    EngineHookAdvance,
    EngineHookCoordinateSpace,
    EngineHookDisplay,
    EngineHookManifest,
    EngineHookManifestBase,
    EngineHookSupport,
} from './manifest.js';

export function parseEngineHookManifest(value: unknown): EngineHookManifest {
    const root = object(value, 'manifest');
    if (root.schema !== 'gsm_engine_hook_manifest_v1') throw new Error('Unsupported engine-hook manifest schema.');
    const target = object(root.target, 'target');
    const coordinateSpace = object(root.coordinateSpace, 'coordinateSpace');
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

    const display = parseEngineHookDisplay(root.display);

    const common: EngineHookManifestBase = {
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
        ...(display ? { display } : {}),
    };

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

    return getEngineHookDecoder(root.decoder).validateManifest(root, common, {
        requireCaptureModes,
        requireModuleName,
    });
}

export function loadEngineHookSupport(directory: string): EngineHookSupport {
    const manifestPath = path.join(directory, 'manifest.json');
    const manifest = parseEngineHookManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
    const payloadSource = fs.readFileSync(path.join(directory, manifest.payload), 'utf8');
    const resources = getEngineHookDecoder(manifest.decoder).loadResources?.(directory, manifest);
    return { directory, manifest, payloadSource, ...(resources === undefined ? {} : { resources }) };
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
