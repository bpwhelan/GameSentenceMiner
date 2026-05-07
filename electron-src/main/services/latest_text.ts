export interface LatestTextProcessingInput {
    text: string;
    processed_text?: string;
    source?: string;
    source_display_name?: string;
    time?: string;
}

let latestTextProcessingInput: LatestTextProcessingInput | null = null;

export function getLatestTextProcessingInput(): LatestTextProcessingInput | null {
    return latestTextProcessingInput;
}

export function recordLatestTextProcessingInput(
    payload: Record<string, any> | undefined
): LatestTextProcessingInput | null {
    if (!payload || typeof payload.text !== 'string') {
        return latestTextProcessingInput;
    }

    latestTextProcessingInput = {
        text: payload.text,
        processed_text: typeof payload.processed_text === 'string' ? payload.processed_text : undefined,
        source: typeof payload.source === 'string' ? payload.source : undefined,
        source_display_name:
            typeof payload.source_display_name === 'string' ? payload.source_display_name : undefined,
        time: typeof payload.time === 'string' ? payload.time : undefined,
    };

    return latestTextProcessingInput;
}
