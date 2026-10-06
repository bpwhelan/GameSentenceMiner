import { ipcMain } from 'electron';
import { getResourcesDir } from '../util.js';
import { store } from '../store.js';
import { getCurrentScene, getExecutableNameFromSource, getWindowTitleFromSource } from '../ui/obs.js';
import { GameBackgroundService } from './game_background.js';
import { gameBackgroundBuildAvailable, launchGameBackgroundController, probeGameBackgroundTargets } from './game_background_native.js';
import { chooseGameBackgroundTarget, gameBackgroundPathKey, normalizeGameBackgroundOptions,
    type GameBackgroundOptions, type GameBackgroundTarget } from '../../shared/game_background.js';

let service: GameBackgroundService | undefined;
let timer: NodeJS.Timeout | undefined;

export function startGameBackgroundHooks(): void {
    if (service) return;
    const root = getResourcesDir();
    service = new GameBackgroundService({
        async resolve() {
            if (process.platform !== 'win32') return { sceneId: '', reason: 'unsupported' };
            if (!gameBackgroundBuildAvailable(root)) return { sceneId: '', reason: 'missingBuild' };
            const scene = await getCurrentScene();
            if (!scene?.id) return { sceneId: '', reason: 'noCapture' };
            const [executable, title] = await Promise.all([getExecutableNameFromSource(scene.id), getWindowTitleFromSource(scene.id)]);
            if (!executable) return { sceneId: scene.id, reason: 'noCapture' };
            const targets = await probeGameBackgroundTargets(root, executable);
            const latestScene = await getCurrentScene();
            if (latestScene?.id !== scene.id) return { sceneId: latestScene?.id || '', reason: 'noCapture' };
            const target = chooseGameBackgroundTarget(targets, title);
            return { sceneId: scene.id, target, reason: target ? undefined : targets.length ? 'ambiguous' : 'notRunning' };
        },
        load: executable => normalizeGameBackgroundOptions(store.get('gameBackgroundProfiles', {})[gameBackgroundPathKey(executable)]),
        save: (executable, options) => store.set('gameBackgroundProfiles', {
            ...store.get('gameBackgroundProfiles', {}), [gameBackgroundPathKey(executable)]: options,
        }),
        launch: (target, options, onStatus, onExit) => launchGameBackgroundController(root, target, options, onStatus, onExit),
    });
    ipcMain.handle('game-background.getState', () => service!.refresh());
    ipcMain.handle('game-background.save', (_event, payload: { sceneId: string; target: GameBackgroundTarget; options: GameBackgroundOptions }) => {
        if (!payload || typeof payload.sceneId !== 'string' || !payload.target || typeof payload.target.path !== 'string' ||
            typeof payload.target.hwnd !== 'string' || !Number.isSafeInteger(payload.target.pid))
            throw new Error('Invalid game background settings');
        return service!.save(payload.sceneId, payload.target, payload.options);
    });
    // Profiles remain off until the user opts in for the resolved executable.
    // Polling also discovers a relaunched game and handles OBS scene changes.
    timer = setInterval(() => {
        const phase = service?.snapshot().phase;
        if (phase === 'active' || phase === 'attaching' ||
            Object.values(store.get('gameBackgroundProfiles', {})).some(value => normalizeGameBackgroundOptions(value).enabled))
            void service?.refresh();
    }, 2500);
    timer.unref();
}

export async function stopGameBackgroundHooks(): Promise<void> {
    if (timer) clearInterval(timer);
    timer = undefined;
    await service?.shutdown();
}
