import * as fs from 'node:fs';
import * as path from 'node:path';

import { applyMagesCharsetOverrides, parseMagesCompoundMap } from './mages_decoder.js';

export interface EngineHookManifest {
    schema: 'gsm_engine_hook_manifest_v1';
    id: string;
    name: string;
    engine: string;
    decoder: 'mages-v1';
    target: {
        platform: 'windows';
        architecture: 'ia32' | 'x64';
        moduleName: string;
        executableNames: string[];
        knownExecutableSha256?: string[];
    };
    coordinateSpace: {
        provider: 'window-client-over-memory-scale';
        scaleXRva: string;
        scaleYRva: string;
    };
    payload: string;
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
    advance:
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
}

export interface EngineHookSupport {
    directory: string;
    manifest: EngineHookManifest;
    payloadSource: string;
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

export function parseEngineHookManifest(value: unknown): EngineHookManifest {
    const root = object(value, 'manifest');
    if (root.schema !== 'gsm_engine_hook_manifest_v1') throw new Error('Unsupported engine-hook manifest schema.');
    const target = object(root.target, 'target');
    const coordinateSpace = object(root.coordinateSpace, 'coordinateSpace');
    const resources = object(root.resources, 'resources');
    const signatures = object(root.signatures, 'signatures');
    const memory = object(root.memory, 'memory');
    const capture = object(root.capture, 'capture');
    const advance = object(root.advance, 'advance');
    if (
        target.platform !== 'windows' ||
        (target.architecture !== 'ia32' && target.architecture !== 'x64')
    ) {
        throw new Error('Engine-hook targets must use Windows ia32 or x64.');
    }
    if (coordinateSpace.provider !== 'window-client-over-memory-scale') {
        throw new Error('coordinateSpace.provider must be window-client-over-memory-scale.');
    }
    if (!Array.isArray(target.executableNames) || target.executableNames.length === 0) {
        throw new Error('target.executableNames must not be empty.');
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
    const executableNames = target.executableNames.map((entry, index) =>
        nonEmptyString(entry, `target.executableNames[${index}]`),
    );
    const knownExecutableSha256 = target.knownExecutableSha256;
    if (
        knownExecutableSha256 !== undefined &&
        (!Array.isArray(knownExecutableSha256) ||
            knownExecutableSha256.some((entry) => typeof entry !== 'string' || !/^[0-9a-f]{64}$/iu.test(entry)))
    ) {
        throw new Error('target.knownExecutableSha256 must contain SHA-256 hashes.');
    }

    return {
        schema: 'gsm_engine_hook_manifest_v1',
        id: nonEmptyString(root.id, 'id'),
        name: nonEmptyString(root.name, 'name'),
        engine: nonEmptyString(root.engine, 'engine'),
        decoder:
            root.decoder === 'mages-v1'
                ? 'mages-v1'
                : (() => {
                      throw new Error('Unsupported engine-hook decoder.');
                  })(),
        target: {
            platform: 'windows',
            architecture: target.architecture,
            moduleName: nonEmptyString(target.moduleName, 'target.moduleName'),
            executableNames,
            ...(knownExecutableSha256
                ? { knownExecutableSha256: knownExecutableSha256.map((hash) => hash.toLowerCase()) }
                : {}),
        },
        coordinateSpace: {
            provider: 'window-client-over-memory-scale',
            scaleXRva: rva(coordinateSpace.scaleXRva, 'coordinateSpace.scaleXRva'),
            scaleYRva: rva(coordinateSpace.scaleYRva, 'coordinateSpace.scaleYRva'),
        },
        payload: relativeAssetPath(root.payload, 'payload'),
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
        capture: {
            acceptedModes: [...capture.acceptedModes],
        },
        advance:
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
                    })(),
    };
}

export function loadEngineHookSupport(directory: string): EngineHookSupport {
    const manifestPath = path.join(directory, 'manifest.json');
    const manifest = parseEngineHookManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
    const payloadSource = fs.readFileSync(path.join(directory, manifest.payload), 'utf8');
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

export function resolveEngineHookSupport(
    directory: string,
    target: { exeName: string; arch: 'x86' | 'x64'; executableSha256?: string },
): EngineHookSupport {
    const architecture = target.arch === 'x86' ? 'ia32' : 'x64';
    const candidates = loadEngineHookCatalog(directory).filter(
        (support) =>
            support.manifest.target.architecture === architecture &&
            support.manifest.target.executableNames.some(
                (name) => name.toLowerCase() === target.exeName.toLowerCase(),
            ),
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
