import {
    nonEmptyString,
    object,
    positiveInteger,
    type EngineHookDecoderDescriptor,
    type EngineHookManifestBase,
} from '../manifest.js';
import { decodeUnityTmpLayout } from '../unity_tmp_decoder.js';

/**
 * A Unity/Mono game is described by managed names rather than byte patterns: the
 * Mono runtime resolves classes, methods and field offsets from its own metadata,
 * which is ASLR-safe by construction and survives a rebuild that moves code.
 */
export interface EngineHookUnityTmpMonoMember {
    assembly: string;
    /** The global namespace is normal for game code, so an empty string is valid. */
    namespace: string;
    class: string;
    method: string;
    parameterCount: number;
}

export interface EngineHookUnityTmpManifest extends EngineHookManifestBase {
    decoder: 'unity-tmp-v1';
    mono: {
        /** The call that starts one displayed line and names the text component. */
        dialogue: EngineHookUnityTmpMonoMember & {
            textComponentField: string;
            /**
             * Argument slot of the "this is only a re-application" flag, counted from
             * the managed `this` pointer at slot zero.
             */
            updateOnlyArgumentIndex: number;
        };
        /** The call that finishes the layout, after which the cells are complete. */
        layout: EngineHookUnityTmpMonoMember;
    };
    capture: {
        acceptedModes: number[];
        maximumGlyphs: number;
    };
}

const MAXIMUM_GLYPHS = 2000;
const MAXIMUM_ARGUMENTS = 16;

function namespaceName(value: unknown, label: string): string {
    if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
    return value;
}

function argumentCount(value: unknown, label: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAXIMUM_ARGUMENTS) {
        throw new Error(`${label} must be an argument count.`);
    }
    return value;
}

function monoMember(value: unknown, label: string): EngineHookUnityTmpMonoMember {
    const member = object(value, label);
    return {
        assembly: nonEmptyString(member.assembly, `${label}.assembly`),
        namespace: namespaceName(member.namespace, `${label}.namespace`),
        class: nonEmptyString(member.class, `${label}.class`),
        method: nonEmptyString(member.method, `${label}.method`),
        parameterCount: argumentCount(member.parameterCount, `${label}.parameterCount`),
    };
}

export const unityTmpDecoderDescriptor: EngineHookDecoderDescriptor = {
    decoder: 'unity-tmp-v1',

    validateManifest(root, common, context): EngineHookUnityTmpManifest {
        // The payload converts cells to client pixels itself, because only the engine
        // knows the canvas render mode and the camera that maps it to the window.
        if (common.coordinateSpace.provider !== 'payload-client-pixels') {
            throw new Error('unity-tmp-v1 coordinateSpace.provider must be payload-client-pixels.');
        }
        // No module name is required. The module that matters is the Mono runtime,
        // never the Unity launcher executable, and Unity renames it by version
        // (`mono.dll` through 2019, `mono-2.0-bdwgc.dll` since 2020). A package
        // spanning both cannot name one, so the payload identifies the runtime by
        // the embedding API it exports instead.
        const acceptedModes = context.requireCaptureModes();
        const mono = object(root.mono, 'mono');
        const capture = object(root.capture, 'capture');
        const dialogue = object(mono.dialogue, 'mono.dialogue');
        const dialogueMember = monoMember(dialogue, 'mono.dialogue');
        const updateOnlyArgumentIndex = argumentCount(
            dialogue.updateOnlyArgumentIndex,
            'mono.dialogue.updateOnlyArgumentIndex',
        );
        // Slot zero is the managed `this` pointer, so a flag can never live there.
        if (updateOnlyArgumentIndex < 1 || updateOnlyArgumentIndex > dialogueMember.parameterCount) {
            throw new Error('mono.dialogue.updateOnlyArgumentIndex must address a declared parameter.');
        }
        return {
            ...common,
            decoder: 'unity-tmp-v1',
            mono: {
                dialogue: {
                    ...dialogueMember,
                    textComponentField: nonEmptyString(
                        dialogue.textComponentField,
                        'mono.dialogue.textComponentField',
                    ),
                    updateOnlyArgumentIndex,
                },
                layout: monoMember(mono.layout, 'mono.layout'),
            },
            capture: {
                acceptedModes,
                maximumGlyphs: positiveInteger(
                    capture.maximumGlyphs,
                    'capture.maximumGlyphs',
                    MAXIMUM_GLYPHS,
                ),
            },
        };
    },

    decodeLayout(message) {
        return decodeUnityTmpLayout(message.positionedCodes);
    },
};
