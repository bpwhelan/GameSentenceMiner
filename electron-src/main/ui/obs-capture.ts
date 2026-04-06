export type ObsCaptureMode = 'window_capture' | 'game_capture';
export type ObsSetupTargetKind = 'window' | 'capture_card';
export const OBS_APPLICATION_AUDIO_INPUT_KIND = 'wasapi_process_output_capture';
export const OBS_WASAPI_INPUT_CAPTURE_KIND = 'wasapi_input_capture';
export const OBS_DSHOW_INPUT_KIND = 'dshow_input';
export const OBS_XCOMPOSITE_INPUT_KIND = 'xcomposite_input';
export type ObsSceneCaptureInputKind =
    | ObsCaptureMode
    | typeof OBS_APPLICATION_AUDIO_INPUT_KIND
    | typeof OBS_WASAPI_INPUT_CAPTURE_KIND
    | typeof OBS_DSHOW_INPUT_KIND
    | typeof OBS_XCOMPOSITE_INPUT_KIND;

export interface ObsWindowPropertyItem {
    itemName: string;
    itemValue: string;
    captureMode: ObsCaptureMode;
    [key: string]: unknown;
}

export interface ObsWindowCaptureValues {
    window_capture?: string;
    game_capture?: string;
    xcomposite_input?: string;
}

export interface ObsDevicePropertyItem {
    itemName: string;
    itemValue: string;
    [key: string]: unknown;
}

export interface ObsSceneSetupOption {
    title: string;
    value: string;
    targetKind: ObsSetupTargetKind;
    captureValues?: ObsWindowCaptureValues;
    videoDeviceId?: string;
    audioDeviceId?: string;
    wasapiInputDeviceId?: string;
}

export type ObsWindowOption = ObsSceneSetupOption;

export interface ObsSceneCaptureInput {
    inputName: string;
    inputKind: ObsSceneCaptureInputKind;
    inputSettings: Record<string, unknown>;
    sceneItemEnabled: boolean;
}

export interface ObsSceneCaptureWindowSelection {
    title?: string;
    value?: string;
    sceneName?: string;
    targetKind?: ObsSetupTargetKind;
    captureValues?: ObsWindowCaptureValues | null;
    videoDeviceId?: string | null;
    audioDeviceId?: string | null;
    wasapiInputDeviceId?: string | null;
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

function isLinuxXCompositeWindowValue(value: string | undefined): value is string {
    return Boolean(value && value.includes('\r\n'));
}

function getCaptureCardSourceNameBase(
    sceneName: string,
    selectedWindow: ObsSceneCaptureWindowSelection
): string {
    const preferredName =
        typeof selectedWindow.title === 'string' && selectedWindow.title.trim()
            ? selectedWindow.title.trim()
            : sceneName;
    return preferredName || sceneName;
}

function tokenizeDeviceName(name: string): string[] {
    return name
        .toLowerCase()
        .replace(/microphone\s*\(/g, '')
        .replace(/digital audio interface\s*\(/g, '')
        .replace(/[()]/g, ' ')
        .split(/[^a-z0-9]+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3);
}

function normalizeComparableDeviceName(name: string): string {
    return tokenizeDeviceName(name).join('');
}

function scoreDeviceNameMatch(left: string, right: string): number {
    const normalizedLeft = normalizeComparableDeviceName(left);
    const normalizedRight = normalizeComparableDeviceName(right);

    if (!normalizedLeft || !normalizedRight) {
        return 0;
    }

    if (normalizedLeft === normalizedRight) {
        return 500;
    }

    if (
        normalizedLeft.includes(normalizedRight) ||
        normalizedRight.includes(normalizedLeft)
    ) {
        return 300;
    }

    const leftTokens = new Set(tokenizeDeviceName(left));
    const rightTokens = new Set(tokenizeDeviceName(right));
    let sharedTokenCount = 0;

    for (const token of leftTokens) {
        if (rightTokens.has(token)) {
            sharedTokenCount += 1;
        }
    }

    return sharedTokenCount >= 2 ? sharedTokenCount * 100 : 0;
}

function findBestMatchingDevice(
    videoDeviceName: string,
    devices: ObsDevicePropertyItem[]
): ObsDevicePropertyItem | null {
    let bestMatch: ObsDevicePropertyItem | null = null;
    let bestScore = 0;

    for (const device of devices) {
        const score = scoreDeviceNameMatch(videoDeviceName, device.itemName);
        if (score > bestScore) {
            bestMatch = device;
            bestScore = score;
        }
    }

    return bestMatch;
}

function isVirtualCaptureDevice(deviceName: string): boolean {
    return (
        /virtual camera/i.test(deviceName) ||
        /^screen-capture-recorder$/i.test(deviceName.trim())
    );
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
        const parsedWindow = parseObsWindowValue(item.itemValue);
        if (!title && !parsedWindow.windowClass && !parsedWindow.executable) {
            continue;
        }
        const key = getObsWindowKey(item);
        const existing = windowsByKey.get(key);

        if (existing) {
            if (!existing.captureValues) {
                existing.captureValues = {};
            }
            existing.captureValues[item.captureMode] = item.itemValue;
            if (!existing.title && title) {
                existing.title = title;
            }
            continue;
        }

        windowsByKey.set(key, {
            title,
            value: key,
            targetKind: 'window',
            captureValues: {
                [item.captureMode]: item.itemValue,
            },
        });
    }

    return [...windowsByKey.values()].sort((left, right) =>
        left.title.localeCompare(right.title)
    );
}

export function buildCaptureCardOptions(
    videoDevices: ObsDevicePropertyItem[],
    directShowAudioDevices: ObsDevicePropertyItem[],
    wasapiInputDevices: ObsDevicePropertyItem[]
): ObsSceneSetupOption[] {
    return videoDevices
        .filter((device) => !isVirtualCaptureDevice(device.itemName))
        .map((videoDevice) => {
            const matchedDirectShowAudio = findBestMatchingDevice(
                videoDevice.itemName,
                directShowAudioDevices
            );
            const matchedWasapiInput = findBestMatchingDevice(
                videoDevice.itemName,
                wasapiInputDevices
            );

            return {
                title: videoDevice.itemName,
                value: JSON.stringify(['capture_card', videoDevice.itemValue]),
                targetKind: 'capture_card' as const,
                videoDeviceId: videoDevice.itemValue,
                audioDeviceId: matchedDirectShowAudio?.itemValue,
                wasapiInputDeviceId: matchedWasapiInput?.itemValue,
            };
        })
        .sort((left, right) => left.title.localeCompare(right.title));
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

    if (
        selectedWindow.targetKind === 'capture_card' ||
        typeof selectedWindow.videoDeviceId === 'string'
    ) {
        const videoDeviceId = selectedWindow.videoDeviceId?.trim();
        if (!videoDeviceId) {
            throw new Error('No OBS video capture device was selected.');
        }

        const wasapiInputDeviceId = selectedWindow.wasapiInputDeviceId?.trim();
        const directShowAudioDeviceId = selectedWindow.audioDeviceId?.trim();
        const sourceNameBase = getCaptureCardSourceNameBase(sceneName, selectedWindow);

        const videoCaptureInput: ObsSceneCaptureInput = {
            inputName: `${sourceNameBase} - Video Capture Device`,
            inputKind: OBS_DSHOW_INPUT_KIND,
            inputSettings: compactSettings({
                video_device_id: videoDeviceId,
                audio_device_id: wasapiInputDeviceId
                    ? undefined
                    : directShowAudioDeviceId,
            }),
            sceneItemEnabled: true,
        };

        const captureInputs: ObsSceneCaptureInput[] = [videoCaptureInput];

        if (wasapiInputDeviceId) {
            captureInputs.push({
                inputName: `${sourceNameBase} - Capture Card Audio`,
                inputKind: OBS_WASAPI_INPUT_CAPTURE_KIND,
                inputSettings: {
                    device_id: wasapiInputDeviceId,
                },
                sceneItemEnabled: true,
            });
        }

        return captureInputs;
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

export function buildLinuxSceneCaptureInputs(
    sceneName: string,
    selectedWindow: ObsSceneCaptureWindowSelection,
    options: { isLinux: boolean }
): ObsSceneCaptureInput[] {
    if (!options.isLinux) {
        throw new Error(
            'Automatic Linux OBS capture setup is currently only supported for XComposite window capture.'
        );
    }

    const captureWindow =
        typeof selectedWindow.captureValues?.xcomposite_input === 'string'
            ? selectedWindow.captureValues.xcomposite_input
            : isLinuxXCompositeWindowValue(selectedWindow.value)
              ? selectedWindow.value
              : undefined;

    if (!captureWindow) {
        const windowLabel = selectedWindow.title || sceneName;
        throw new Error(
            `No OBS XComposite capture source was available for "${windowLabel}".`
        );
    }

    return [
        {
            inputName: `${sceneName} - XComposite Window Capture`,
            inputKind: OBS_XCOMPOSITE_INPUT_KIND,
            inputSettings: {
                capture_window: captureWindow,
                show_cursor: false,
                include_border: false,
                exclude_alpha: false,
            },
            sceneItemEnabled: true,
        },
    ];
}
