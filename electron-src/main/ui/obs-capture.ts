export type ObsCaptureMode = 'window_capture' | 'game_capture';
export const OBS_APPLICATION_AUDIO_INPUT_KIND = 'wasapi_process_output_capture';
export type ObsSceneCaptureInputKind =
    | ObsCaptureMode
    | typeof OBS_APPLICATION_AUDIO_INPUT_KIND;

export interface ObsWindowPropertyItem {
    itemName: string;
    itemValue: string;
    captureMode: ObsCaptureMode;
    [key: string]: unknown;
}

export interface ObsWindowCaptureValues {
    window_capture?: string;
    game_capture?: string;
}

export interface ObsWindowOption {
    title: string;
    value: string;
    captureValues: ObsWindowCaptureValues;
}

export interface ObsSceneCaptureInput {
    inputName: string;
    inputKind: ObsSceneCaptureInputKind;
    inputSettings: Record<string, unknown>;
    sceneItemEnabled: boolean;
}

export interface ObsSceneCaptureWindowSelection {
    title?: string;
    value?: string;
    captureValues?: ObsWindowCaptureValues | null;
}

interface WindowsCapturePlanOptions {
    isWindows: boolean;
    isWindows10OrHigher: boolean;
}

interface WindowCaptureVariantDefinition {
    id: string;
    inputNameSuffix: string;
    buildSettings: (
        windowValue: string,
        options: WindowsCapturePlanOptions
    ) => Record<string, unknown>;
}

const WINDOW_CAPTURE_VARIANTS: readonly WindowCaptureVariantDefinition[] = [
    {
        id: 'windows-graphics-capture',
        inputNameSuffix: 'Window Capture',
        buildSettings: (windowValue, options) =>
            compactSettings({
                window: windowValue,
                mode: 'window',
                cursor: false,
                method: options.isWindows10OrHigher ? 2 : undefined,
            }),
    },
];

function compactSettings(
    settings: Record<string, unknown>
): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(settings).filter(([, value]) => value !== undefined)
    );
}

function isLegacyObsWindowValue(value: string | undefined): value is string {
    return Boolean(value && value.includes(':') && !value.trim().startsWith('['));
}

function normalizeCaptureValues(
    selectedWindow: ObsSceneCaptureWindowSelection
): ObsWindowCaptureValues {
    const captureValues = selectedWindow.captureValues ?? {};
    const fallbackValue = isLegacyObsWindowValue(selectedWindow.value)
        ? selectedWindow.value
        : undefined;

    return {
        window_capture:
            typeof captureValues.window_capture === 'string'
                ? captureValues.window_capture
                : fallbackValue,
        game_capture:
            typeof captureValues.game_capture === 'string'
                ? captureValues.game_capture
                : fallbackValue,
    };
}

export function parseObsWindowValue(itemValue: string): {
    title: string;
    windowClass: string;
    executable: string;
} {
    const parts = itemValue.split(':');
    const executable = parts.pop()?.trim() ?? '';
    const windowClass = parts.pop()?.trim() ?? '';
    const title = parts.join(':').trim();

    return { title, windowClass, executable };
}

export function getObsWindowTitle(itemName: string): string {
    const parsedTitle = itemName.split(':').slice(1).join(':').trim();
    return parsedTitle || itemName.trim();
}

export function getObsWindowKey(
    item: Pick<ObsWindowPropertyItem, 'itemName' | 'itemValue'>
): string {
    const parsed = parseObsWindowValue(item.itemValue);
    return JSON.stringify([
        getObsWindowTitle(item.itemName).toLowerCase(),
        parsed.windowClass.toLowerCase(),
        parsed.executable.toLowerCase(),
    ]);
}

export function mergeObsWindowItems(
    items: ObsWindowPropertyItem[]
): ObsWindowOption[] {
    const windowsByKey = new Map<string, ObsWindowOption>();

    for (const item of items) {
        const title = getObsWindowTitle(item.itemName);
        const key = getObsWindowKey(item);
        const existing = windowsByKey.get(key);

        if (existing) {
            existing.captureValues[item.captureMode] = item.itemValue;
            if (!existing.title && title) {
                existing.title = title;
            }
            continue;
        }

        windowsByKey.set(key, {
            title,
            value: key,
            captureValues: {
                [item.captureMode]: item.itemValue,
            },
        });
    }

    return [...windowsByKey.values()].sort((left, right) =>
        left.title.localeCompare(right.title)
    );
}

function buildWindowsApplicationAudioCaptureInput(
    sceneName: string,
    windowValue: string
): ObsSceneCaptureInput {
    return {
        inputName: `${sceneName} - Audio Capture`,
        inputKind: OBS_APPLICATION_AUDIO_INPUT_KIND,
        inputSettings: {
            window: windowValue,
        },
        sceneItemEnabled: true,
    };
}

export function buildWindowsSceneCaptureInputs(
    sceneName: string,
    selectedWindow: ObsSceneCaptureWindowSelection,
    options: WindowsCapturePlanOptions
): ObsSceneCaptureInput[] {
    if (!options.isWindows) {
        throw new Error(
            'Automatic OBS capture setup is currently only supported on Windows.'
        );
    }

    const captureValues = normalizeCaptureValues(selectedWindow);
    const captureInputs: ObsSceneCaptureInput[] = [];

    for (const variant of WINDOW_CAPTURE_VARIANTS) {
        const windowValue = captureValues.window_capture;
        if (!windowValue) {
            continue;
        }

        captureInputs.push({
            inputName: `${sceneName} - ${variant.inputNameSuffix}`,
            inputKind: 'window_capture',
            inputSettings: variant.buildSettings(windowValue, options),
            sceneItemEnabled: true,
        });
    }

    if (captureValues.window_capture) {
        captureInputs.push(
            buildWindowsApplicationAudioCaptureInput(
                sceneName,
                captureValues.window_capture
            )
        );
    }

    if (captureValues.game_capture) {
        captureInputs.push({
            inputName: `${sceneName} - Game Capture`,
            inputKind: 'game_capture',
            inputSettings: {
                window: captureValues.game_capture,
                capture_mode: 'window',
                capture_cursor: false,
            },
            sceneItemEnabled: true,
        });
    }

    if (!captureInputs.length) {
        const windowLabel = selectedWindow.title || sceneName;
        throw new Error(`No OBS capture sources were available for "${windowLabel}".`);
    }

    return captureInputs;
}
