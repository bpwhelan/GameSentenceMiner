import * as path from 'node:path';

export type TrayVisualState = 'loading' | 'ready' | 'paused' | 'normal';

export function resolveTrayStyleName(
    configuredIconStyle: string,
    resolvedRandomStyle: string
): string {
    const effectiveStyle = configuredIconStyle.includes('random')
        ? resolvedRandomStyle
        : configuredIconStyle;

    if (configuredIconStyle.includes('[tray]')) {
        return effectiveStyle.replace('[tray]', '');
    }

    return 'gsm';
}

export function getTrayBaseIconPath(options: {
    assetsDir: string;
    configuredIconStyle: string;
    resolvedRandomStyle: string;
    extension: 'ico' | 'png';
}): string {
    const trayStyleName = resolveTrayStyleName(
        options.configuredIconStyle,
        options.resolvedRandomStyle
    );
    return path.join(options.assetsDir, `${trayStyleName}.${options.extension}`);
}

export function getStatusTrayIconPath(options: {
    assetsDir: string;
    state: Exclude<TrayVisualState, 'normal'>;
    extension: 'ico' | 'png';
}): string {
    return path.join(options.assetsDir, `gsm-${options.state}.${options.extension}`);
}

export function resolveTrayVisualState(options: {
    pythonIpcConnected: boolean;
    backendStatusReady: boolean;
    readyIndicatorActive: boolean;
    textIntakePaused: boolean;
}): TrayVisualState {
    if (!options.pythonIpcConnected || !options.backendStatusReady) {
        return 'loading';
    }
    if (options.textIntakePaused) {
        return 'paused';
    }
    if (options.readyIndicatorActive) {
        return 'ready';
    }
    return 'normal';
}

export function getTrayTooltip(state: TrayVisualState): string {
    switch (state) {
        case 'loading':
            return 'GameSentenceMiner (Starting up)';
        case 'ready':
            return 'GameSentenceMiner (Ready)';
        case 'paused':
            return 'GameSentenceMiner (Text Intake Paused)';
        default:
            return 'GameSentenceMiner';
    }
}
