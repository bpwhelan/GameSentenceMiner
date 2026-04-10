import { beforeEach, describe, expect, it, vi } from 'vitest';

const getExecutableNameFromSourceMock = vi.fn();
const getCurrentSceneMock = vi.fn();
const getWindowTitleFromSourceMock = vi.fn();
const sceneHasVisibleOutputMock = vi.fn();

const getOCRRuntimeStateMock = vi.fn();
const startManualOCRMock = vi.fn();
const startOCRMock = vi.fn();
const stopOCRMock = vi.fn();
const getOverlayRuntimeStateMock = vi.fn();
const runOverlayWithSourceMock = vi.fn();
const stopOverlayMock = vi.fn();

const getAgentPathMock = vi.fn();
const getAgentScriptsPathMock = vi.fn();
const getLaunchAgentMinimizedMock = vi.fn();
const getLaunchLunaTranslatorMinimizedMock = vi.fn();
const getLaunchTextractorMinimizedMock = vi.fn();
const getLunaTranslatorPathMock = vi.fn();
const getObsOcrScenesMock = vi.fn();
const getSceneLaunchProfileForSceneMock = vi.fn();
const getSteamGamesMock = vi.fn();
const getTextractorPath32Mock = vi.fn();
const getTextractorPath64Mock = vi.fn();
const getYuzuEmuPathMock = vi.fn();
const getYuzuGamesConfigMock = vi.fn();
const upsertSceneLaunchProfileMock = vi.fn();

vi.mock('./ui/obs.js', () => ({
    getExecutableNameFromSource: getExecutableNameFromSourceMock,
    getCurrentScene: getCurrentSceneMock,
    getWindowTitleFromSource: getWindowTitleFromSourceMock,
    sceneHasVisibleOutput: sceneHasVisibleOutputMock,
}));

vi.mock('./ui/ocr.js', () => ({
    getOCRRuntimeState: getOCRRuntimeStateMock,
    startManualOCR: startManualOCRMock,
    startOCR: startOCRMock,
    stopOCR: stopOCRMock,
}));

vi.mock('./ui/front.js', () => ({
    getOverlayRuntimeState: getOverlayRuntimeStateMock,
    runOverlayWithSource: runOverlayWithSourceMock,
    stopOverlay: stopOverlayMock,
}));

vi.mock('./store.js', () => ({
    getAgentPath: getAgentPathMock,
    getAgentScriptsPath: getAgentScriptsPathMock,
    getLaunchAgentMinimized: getLaunchAgentMinimizedMock,
    getLaunchLunaTranslatorMinimized: getLaunchLunaTranslatorMinimizedMock,
    getLaunchTextractorMinimized: getLaunchTextractorMinimizedMock,
    getLunaTranslatorPath: getLunaTranslatorPathMock,
    getObsOcrScenes: getObsOcrScenesMock,
    getSceneLaunchProfileForScene: getSceneLaunchProfileForSceneMock,
    getSteamGames: getSteamGamesMock,
    getTextractorPath32: getTextractorPath32Mock,
    getTextractorPath64: getTextractorPath64Mock,
    getYuzuEmuPath: getYuzuEmuPathMock,
    getYuzuGamesConfig: getYuzuGamesConfigMock,
    runtimeState: {
        get: vi.fn(),
    },
    upsertSceneLaunchProfile: upsertSceneLaunchProfileMock,
}));

vi.mock('./agent_script_resolver.js', () => ({
    findAgentScriptById: vi.fn(),
    resolveSwitchAgentScript: vi.fn(),
}));

vi.mock('child_process', () => ({
    exec: vi.fn(),
    spawn: vi.fn(),
}));

async function loadAutoLauncherModule() {
    vi.resetModules();
    return import('./auto_launcher.js');
}

describe('AutoLauncher OCR scene activity fallback', () => {
    beforeEach(() => {
        getExecutableNameFromSourceMock.mockReset();
        getCurrentSceneMock.mockReset();
        getWindowTitleFromSourceMock.mockReset();
        sceneHasVisibleOutputMock.mockReset();
        getOCRRuntimeStateMock.mockReset();
        startManualOCRMock.mockReset();
        startOCRMock.mockReset();
        stopOCRMock.mockReset();
        getOverlayRuntimeStateMock.mockReset();
        runOverlayWithSourceMock.mockReset();
        stopOverlayMock.mockReset();
        getAgentPathMock.mockReset();
        getAgentScriptsPathMock.mockReset();
        getLaunchAgentMinimizedMock.mockReset();
        getLaunchLunaTranslatorMinimizedMock.mockReset();
        getLaunchTextractorMinimizedMock.mockReset();
        getLunaTranslatorPathMock.mockReset();
        getObsOcrScenesMock.mockReset();
        getSceneLaunchProfileForSceneMock.mockReset();
        getSteamGamesMock.mockReset();
        getTextractorPath32Mock.mockReset();
        getTextractorPath64Mock.mockReset();
        getYuzuEmuPathMock.mockReset();
        getYuzuGamesConfigMock.mockReset();
        upsertSceneLaunchProfileMock.mockReset();

        getOCRRuntimeStateMock.mockReturnValue({
            isRunning: false,
            source: null,
            mode: 'auto',
        });
        stopOCRMock.mockReturnValue(false);
        startOCRMock.mockResolvedValue(undefined);
        startManualOCRMock.mockReturnValue(undefined);
        getOverlayRuntimeStateMock.mockReturnValue({
            isRunning: false,
            source: null,
        });
        runOverlayWithSourceMock.mockResolvedValue(true);
        stopOverlayMock.mockReturnValue(false);
        getObsOcrScenesMock.mockReturnValue([]);
        getSceneLaunchProfileForSceneMock.mockReturnValue(null);
        getSteamGamesMock.mockReturnValue([]);
        getYuzuGamesConfigMock.mockReturnValue([]);
        getAgentPathMock.mockReturnValue('');
        getAgentScriptsPathMock.mockReturnValue('');
        getLaunchAgentMinimizedMock.mockReturnValue(false);
        getLaunchLunaTranslatorMinimizedMock.mockReturnValue(false);
        getLaunchTextractorMinimizedMock.mockReturnValue(false);
        getLunaTranslatorPathMock.mockReturnValue('');
        getTextractorPath32Mock.mockReturnValue('');
        getTextractorPath64Mock.mockReturnValue('');
        getYuzuEmuPathMock.mockReturnValue('');
    });

    it('does not probe OBS scene output when the current scene is not configured for OCR auto-launch', async () => {
        const { AutoLauncher } = await loadAutoLauncherModule();
        const launcher = new AutoLauncher() as any;
        const scene = { id: 'scene-1', name: 'Scene 1' };

        await launcher.runOcrAutomation(scene);

        expect(getExecutableNameFromSourceMock).not.toHaveBeenCalled();
        expect(sceneHasVisibleOutputMock).not.toHaveBeenCalled();
        expect(startOCRMock).not.toHaveBeenCalled();
    });

    it('falls back to OBS scene output when executable detection is unavailable', async () => {
        const { AutoLauncher } = await loadAutoLauncherModule();
        const launcher = new AutoLauncher() as any;
        const scene = { id: 'scene-1', name: 'Octopath Traveler 0' };

        getSceneLaunchProfileForSceneMock.mockReturnValue({
            sceneId: scene.id,
            sceneName: scene.name,
            textHookMode: 'none',
            ocrMode: 'auto',
            launchOverlay: false,
            agentScriptPath: '',
            launchDelaySeconds: 0,
        });
        getExecutableNameFromSourceMock.mockResolvedValue(null);
        sceneHasVisibleOutputMock.mockResolvedValue(true);

        await launcher.runOcrAutomation(scene);

        expect(getExecutableNameFromSourceMock).toHaveBeenCalledWith(scene.id);
        expect(sceneHasVisibleOutputMock).toHaveBeenCalledWith(scene);
        expect(startOCRMock).toHaveBeenCalledWith({
            scene,
            promptForAreaSelection: false,
            source: 'auto-launcher',
        });
    });

    it('starts overlay when the scene enables overlay automation and the game/session is active', async () => {
        const { AutoLauncher } = await loadAutoLauncherModule();
        const launcher = new AutoLauncher() as any;
        const scene = { id: 'scene-1', name: 'Scene 1' };

        getSceneLaunchProfileForSceneMock.mockReturnValue({
            sceneId: scene.id,
            sceneName: scene.name,
            textHookMode: 'none',
            ocrMode: 'none',
            launchOverlay: true,
            agentScriptPath: '',
            launchDelaySeconds: 0,
        });
        getExecutableNameFromSourceMock.mockResolvedValue(null);
        sceneHasVisibleOutputMock.mockResolvedValue(true);

        await launcher.runOverlayAutomation(scene);

        expect(runOverlayWithSourceMock).toHaveBeenCalledWith('auto-launcher');
        expect(stopOverlayMock).not.toHaveBeenCalled();
    });

    it('stops auto-launched overlay when the active scene no longer enables overlay automation', async () => {
        const { AutoLauncher } = await loadAutoLauncherModule();
        const launcher = new AutoLauncher() as any;
        const scene = { id: 'scene-1', name: 'Scene 1' };

        getSceneLaunchProfileForSceneMock.mockReturnValue({
            sceneId: scene.id,
            sceneName: scene.name,
            textHookMode: 'none',
            ocrMode: 'none',
            launchOverlay: false,
            agentScriptPath: '',
            launchDelaySeconds: 0,
        });
        getOverlayRuntimeStateMock.mockReturnValue({
            isRunning: true,
            source: 'auto-launcher',
        });
        stopOverlayMock.mockReturnValue(true);

        await launcher.runOverlayAutomation(scene);

        expect(stopOverlayMock).toHaveBeenCalledWith({ onlyIfSource: 'auto-launcher' });
        expect(runOverlayWithSourceMock).not.toHaveBeenCalled();
    });
});
