import type { EngineHookDecoderDescriptor } from '../manifest.js';
import { bgiDecoderDescriptor } from './bgi.js';
import { magesDecoderDescriptor } from './mages.js';
import { unityTmpDecoderDescriptor } from './unity-tmp.js';
import { vlrDecoderDescriptor } from './vlr.js';

// One sorted line per engine. A new engine adds its line here and nothing else
// in the shared files, so a merge conflict is a keep-both-lines resolution.
const ENGINE_HOOK_DECODERS: Record<string, EngineHookDecoderDescriptor> = {
    'bgi-v1': bgiDecoderDescriptor,
    'mages-v1': magesDecoderDescriptor,
    'unity-tmp-v1': unityTmpDecoderDescriptor,
    'vlr-v1': vlrDecoderDescriptor,
};

export function getEngineHookDecoder(decoder: unknown): EngineHookDecoderDescriptor {
    const descriptor =
        typeof decoder === 'string' ? ENGINE_HOOK_DECODERS[decoder] : undefined;
    if (!descriptor) throw new Error('Unsupported engine-hook decoder.');
    return descriptor;
}

export function listEngineHookDecoderIds(): string[] {
    return Object.keys(ENGINE_HOOK_DECODERS);
}
