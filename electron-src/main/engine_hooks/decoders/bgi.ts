import { selectBgiLayout } from '../bgi_decoder.js';
import {
    nonEmptyString,
    object,
    type EngineHookDecoderDescriptor,
    type EngineHookManifestBase,
} from '../manifest.js';

export interface EngineHookBgiManifest extends EngineHookManifestBase {
    decoder: 'bgi-v1';
    signatures: {
        glyphDraw: string;
        textCapture: string;
        copyDispatcher: string;
        surfaceLock: string;
    };
}

export const bgiDecoderDescriptor: EngineHookDecoderDescriptor = {
    decoder: 'bgi-v1',

    validateManifest(root, common): EngineHookBgiManifest {
        const signatures = object(root.signatures, 'signatures');
        if (common.coordinateSpace.provider !== 'payload-client-pixels') {
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
    },

    decodeLayout(message) {
        return selectBgiLayout(message.candidates ?? [], message.positionedCodes);
    },
};
