import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    applyMagesCharsetOverrides,
    decodeMagesLayout,
    parseMagesCompoundMap,
} from '../mages_decoder.js';
import {
    nonEmptyString,
    object,
    positiveInteger,
    relativeAssetPath,
    rva,
    type EngineHookDecoderDescriptor,
    type EngineHookManifestBase,
} from '../manifest.js';

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
        coordinateSuppressedStyles?: number[];
    };
}

export interface MagesResources {
    charset: string;
    compoundCharacters: Map<string, string>;
}

export const magesDecoderDescriptor: EngineHookDecoderDescriptor = {
    decoder: 'mages-v1',

    validateManifest(root, common, context): EngineHookMagesManifest {
        const signatures = object(root.signatures, 'signatures');
        const resources = object(root.resources, 'resources');
        const memory = object(root.memory, 'memory');
        const capture = object(root.capture, 'capture');
        const acceptedModes = context.requireCaptureModes();
        context.requireModuleName();
        const coordinateSuppressedStyles = capture.coordinateSuppressedStyles;
        if (
            coordinateSuppressedStyles !== undefined &&
            (!Array.isArray(coordinateSuppressedStyles) ||
                coordinateSuppressedStyles.some(
                    (entry) => typeof entry !== 'number' || !Number.isInteger(entry) || entry < 0 || entry > 255,
                ))
        ) {
            throw new Error('capture.coordinateSuppressedStyles must contain byte-sized integers.');
        }
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
            capture: {
                acceptedModes,
                ...(coordinateSuppressedStyles === undefined
                    ? {}
                    : { coordinateSuppressedStyles: [...(coordinateSuppressedStyles as number[])] }),
            },
        };
    },

    loadResources(directory, manifest): MagesResources {
        const { resources } = manifest as EngineHookMagesManifest;
        const rawCharset = fs.readFileSync(path.join(directory, resources.charset), 'utf8');
        const charset = resources.charsetOverrides
            ? applyMagesCharsetOverrides(
                  rawCharset,
                  JSON.parse(
                      fs.readFileSync(path.join(directory, resources.charsetOverrides), 'utf8'),
                  ),
              )
            : rawCharset;
        return {
            charset,
            compoundCharacters: parseMagesCompoundMap(
                fs.readFileSync(path.join(directory, resources.compoundCharacters), 'utf8'),
            ),
        };
    },

    decodeLayout(message, support) {
        const resources = support.resources as MagesResources | undefined;
        return decodeMagesLayout(
            message.positionedCodes,
            resources?.charset ?? '',
            resources?.compoundCharacters ?? new Map(),
        );
    },
};
