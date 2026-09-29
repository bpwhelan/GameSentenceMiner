import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getSceneLaunchProfileForSceneMock } = vi.hoisted(() => ({
    getSceneLaunchProfileForSceneMock: vi.fn(),
}));

vi.mock('../store.js', () => ({
    getSceneLaunchProfileForScene: getSceneLaunchProfileForSceneMock,
}));

vi.mock('../gsm_config.js', () => ({
    gsmBackendUrl: (routePath: string) => `http://localhost:7275${routePath}`,
}));

type SyncModule = typeof import('./process_pausing_target.js');
let syncProcessPausingTargetForScene: SyncModule['syncProcessPausingTargetForScene'];

const GAME = { id: 'uuid-game', name: 'Game' };

function okFetch() {
    return vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
}

function postedTargets(fetchImpl: ReturnType<typeof okFetch>): string[] {
    return fetchImpl.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).target);
}

function sceneExes(exes: Record<string, string>) {
    getSceneLaunchProfileForSceneMock.mockImplementation((scene: { name: string }) =>
        scene.name in exes ? { gameExecutablePath: exes[scene.name] } : null
    );
}

beforeEach(async () => {
    vi.resetModules();
    getSceneLaunchProfileForSceneMock.mockReset();
    ({ syncProcessPausingTargetForScene } = await import('./process_pausing_target.js'));
});

describe('syncProcessPausingTargetForScene', () => {
    it("posts the scene's game executable to the backend's in-memory target", async () => {
        sceneExes({ Game: 'S:\\Game\\Binaries\\Win64\\game_.exe' });
        const fetchImpl = okFetch();

        const synced = await syncProcessPausingTargetForScene(GAME, { platform: 'linux', fetchImpl });

        expect(synced).toBe(true);
        expect(getSceneLaunchProfileForSceneMock).toHaveBeenCalledWith(GAME);
        expect(fetchImpl).toHaveBeenCalledWith('http://localhost:7275/linux/set_scene_target_process', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ target: 'S:\\Game\\Binaries\\Win64\\game_.exe' }),
        });
    });

    it('clears the scene target for a scene without a game executable', async () => {
        sceneExes({ Game: '/games/native-game/game' });
        const fetchImpl = okFetch();

        await syncProcessPausingTargetForScene(GAME, { platform: 'linux', fetchImpl });
        await syncProcessPausingTargetForScene({ id: 'uuid-other', name: 'No Exe' }, { platform: 'linux', fetchImpl });

        expect(postedTargets(fetchImpl)).toEqual(['/games/native-game/game', '']);
    });

    it('skips an unchanged target unless forced', async () => {
        sceneExes({ Game: '/games/native-game/game' });
        const fetchImpl = okFetch();

        await syncProcessPausingTargetForScene(GAME, { platform: 'linux', fetchImpl });
        const repeated = await syncProcessPausingTargetForScene(GAME, { platform: 'linux', fetchImpl });
        const forced = await syncProcessPausingTargetForScene(GAME, { platform: 'linux', fetchImpl, force: true });

        expect([repeated, forced]).toEqual([false, true]);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('rejects on an HTTP error and retries the same target next time', async () => {
        sceneExes({ Game: '/games/native-game/game' });
        const failing = vi.fn(async () => new Response('{}', { status: 500 }));
        const fetchImpl = okFetch();

        await expect(
            syncProcessPausingTargetForScene(GAME, { platform: 'linux', fetchImpl: failing })
        ).rejects.toThrow('HTTP 500');
        const synced = await syncProcessPausingTargetForScene(GAME, { platform: 'linux', fetchImpl });

        expect(synced).toBe(true);
    });

    it('sends rapid switches in call order', async () => {
        sceneExes({ A: 'a.exe', B: 'b.exe' });
        let releaseFirst: () => void = () => {};
        const order: string[] = [];
        const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
            const target = JSON.parse(String(init?.body)).target;
            if (target === 'a.exe') {
                await new Promise<void>((resolve) => (releaseFirst = resolve));
            }
            order.push(target);
            return new Response('{}', { status: 200 });
        });

        const first = syncProcessPausingTargetForScene({ id: '1', name: 'A' }, { platform: 'linux', fetchImpl });
        const second = syncProcessPausingTargetForScene({ id: '2', name: 'B' }, { platform: 'linux', fetchImpl });
        await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
        releaseFirst();
        await Promise.all([first, second]);

        expect(order).toEqual(['a.exe', 'b.exe']);
    });

    it('does nothing off Linux, where the target is unused', async () => {
        sceneExes({ Game: 'C:\\Games\\game.exe' });
        const fetchImpl = okFetch();

        const synced = await syncProcessPausingTargetForScene(GAME, { platform: 'win32', fetchImpl });

        expect(synced).toBe(false);
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});
