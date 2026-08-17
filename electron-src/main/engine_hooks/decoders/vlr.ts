import {
    nonEmptyString,
    object,
    positiveInteger,
    rva,
    type EngineHookDecoderDescriptor,
    type EngineHookManifestBase,
} from '../manifest.js';
import { decodeVlrLayout } from '../vlr_decoder.js';

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

export const vlrDecoderDescriptor: EngineHookDecoderDescriptor = {
    decoder: 'vlr-v1',

    validateManifest(root, common, context): EngineHookVlrManifest {
        const signatures = object(root.signatures, 'signatures');
        const memory = object(root.memory, 'memory');
        const capture = object(root.capture, 'capture');
        const acceptedModes = context.requireCaptureModes();
        context.requireModuleName();
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
    },

    decodeLayout(message) {
        return decodeVlrLayout(
            message.positionedCodes.map((positionedCode) => ({
                ...positionedCode,
                type: 1,
            })),
        );
    },
};
