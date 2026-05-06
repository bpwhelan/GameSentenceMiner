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
const getYuzuGamesConfigMock = vi.fn();
const upsertSceneLaunchProfileMock = vi.fn();
const isHighConfidenceScriptMatchMock = vi.fn();
const isSwitchEmulatorTargetMock = vi.fn();
const resolveSwitchAgentScriptMock = vi.fn();

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
    getYuzuGamesConfig: getYuzuGamesConfigMock,
    runtimeState: {
        get: vi.fn(),
    },
    upsertSceneLaunchProfile: upsertSceneLaunchProfileMock,
}));

vi.mock('./agent_script_resolver.js', () => ({
    isHighConfidenceScriptMatch: isHighConfidenceScriptMatchMock,
    isSwitchEmulatorTarget: isSwitchEmulatorTargetMock,
    resolveSwitchAgentScript: resolveSwitchAgentScriptMock,
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
        getYuzuGamesConfigMock.mockReset();
        upsertSceneLaunchProfileMock.mockReset();
        isHighConfidenceScriptMatchMock.mockReset();
        isSwitchEmulatorTargetMock.mockReset();
        resolveSwitchAgentScriptMock.mockReset();

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
        isHighConfidenceScriptMatchMock.mockReturnValue(false);
        isSwitchEmulatorTargetMock.mockReturnValue(false);
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

    it('uses the target emulator executable to guard configured Switch Agent launches', async () => {
        const { AutoLauncher } = await loadAutoLauncherModule();
        const launcher = new AutoLauncher() as any;
        const scene = { id: 'scene-1', name: 'Unicorn Overlord' };
        const sceneProfile = {
            sceneId: scene.id,
            sceneName: scene.name,
            textHookMode: 'agent',
            ocrMode: 'none',
            launchOverlay: false,
            agentScriptPath: 'C:\\Agent\\data\\scripts\\NS_0100GAME.js',
            launchDelaySeconds: 1.5,
        };
        const validateContext = vi.fn();

        isSwitchEmulatorTargetMock.mockReturnValue(true);
        launcher.resolveSceneAgentScript = vi.fn().mockResolvedValue(sceneProfile.agentScriptPath);
        launcher.createSwitchContextValidator = vi.fn().mockReturnValue(validateContext);
        launcher.handleGame = vi.fn().mockResolvedValue(undefined);

        await launcher.handleAgentAutomation(scene, 'Ryujinx.exe', sceneProfile, false);

        expect(getYuzuGamesConfigMock).not.toHaveBeenCalled();
        expect(isSwitchEmulatorTargetMock).toHaveBeenCalledWith('Ryujinx.exe', null);
        expect(launcher.createSwitchContextValidator).toHaveBeenCalledWith(
            scene,
            'Ryujinx.exe',
            scene.name
        );
        expect(launcher.handleGame).toHaveBeenCalledWith(
            'Ryujinx.exe',
            sceneProfile.agentScriptPath,
            scene.id,
            1.5,
            validateContext
        );
    });

    it('resolves legacy Switch Agent scripts from the emulator executable without yuzu scene config', async () => {
        const { AutoLauncher } = await loadAutoLauncherModule();
        const launcher = new AutoLauncher() as any;
        const scene = { id: 'scene-1', name: 'Unicorn Overlord' };
        const scriptPath = 'C:\\Agent\\data\\scripts\\NS_Unicorn_Overlord.js';
        const validateContext = vi.fn().mockResolvedValue(true);

        getAgentScriptsPathMock.mockReturnValue('C:\\Agent\\data\\scripts');
        isSwitchEmulatorTargetMock.mockReturnValue(true);
        resolveSwitchAgentScriptMock.mockReturnValue({
            path: scriptPath,
            reason: 'matched_name',
            isSwitchTarget: true,
            titleId: null,
            candidates: [{ path: scriptPath, reason: 'matched_name', score: 0.12 }],
        });
        launcher.getPidByProcessName = vi.fn().mockResolvedValue(1234);
        launcher.getLiveWindowTitle = vi
            .fn()
            .mockResolvedValue('Eden | v0.0.4 | Unicorn Overlord (64-bit)');
        launcher.createSwitchContextValidator = vi.fn().mockReturnValue(validateContext);
        launcher.handleGame = vi.fn().mockResolvedValue(undefined);

        const keepFastPolling = await launcher.handleAgentAutomation(
            scene,
            'Eden.exe',
            null,
            true
        );

        expect(keepFastPolling).toBe(true);
        expect(getYuzuGamesConfigMock).not.toHaveBeenCalled();
        expect(resolveSwitchAgentScriptMock).toHaveBeenCalledWith({
            scriptsPath: 'C:\\Agent\\data\\scripts',
            processName: 'Eden.exe',
            windowTitle: 'Eden | v0.0.4 | Unicorn Overlord (64-bit)',
            sceneName: scene.name,
            explicitGameId: null,
        });
        expect(launcher.createSwitchContextValidator).toHaveBeenCalledWith(
            scene,
            'Eden.exe',
            scene.name
        );
        expect(launcher.handleGame).toHaveBeenCalledWith(
            'Eden.exe',
            scriptPath,
            `switch:${scriptPath}`,
            0,
            validateContext
        );
    });

    it('auto-fills Switch Agent scripts from trusted emulator title matches without yuzu scene config', async () => {
        const { AutoLauncher } = await loadAutoLauncherModule();
        const launcher = new AutoLauncher() as any;
        const scene = { id: 'scene-1', name: 'Unicorn Overlord' };
        const sceneProfile = {
            sceneId: scene.id,
            sceneName: scene.name,
            textHookMode: 'agent',
            ocrMode: 'none',
            launchOverlay: false,
            agentScriptPath: '',
            launchDelaySeconds: 0,
        };
        const scriptPath = 'C:\\Agent\\data\\scripts\\NS_0100GAME.js';

        getAgentScriptsPathMock.mockReturnValue('C:\\Agent\\data\\scripts');
        resolveSwitchAgentScriptMock.mockReturnValue({
            path: scriptPath,
            reason: 'matched_title_id',
            isSwitchTarget: true,
            titleId: '0100GAME00000000',
            candidates: [{ path: scriptPath, reason: 'matched_title_id', score: 0.01 }],
        });
        launcher.getPidByProcessName = vi.fn().mockResolvedValue(1234);
        launcher.getLiveWindowTitle = vi
            .fn()
            .mockResolvedValue('Ryujinx 1.1.0 | Unicorn Overlord | 0100GAME00000000');

        await expect(
            launcher.resolveSceneAgentScript(scene, 'Ryujinx.exe', sceneProfile)
        ).resolves.toBe(scriptPath);

        expect(getYuzuGamesConfigMock).not.toHaveBeenCalled();
        expect(resolveSwitchAgentScriptMock).toHaveBeenCalledWith({
            scriptsPath: 'C:\\Agent\\data\\scripts',
            processName: 'Ryujinx.exe',
            windowTitle: 'Ryujinx 1.1.0 | Unicorn Overlord | 0100GAME00000000',
            sceneName: scene.name,
            explicitGameId: null,
        });
        expect(upsertSceneLaunchProfileMock).toHaveBeenCalledWith({
            sceneId: scene.id,
            sceneName: scene.name,
            textHookMode: sceneProfile.textHookMode,
            ocrMode: sceneProfile.ocrMode,
            launchOverlay: sceneProfile.launchOverlay,
            agentScriptPath: scriptPath,
            launchDelaySeconds: sceneProfile.launchDelaySeconds,
        });
    });
});
