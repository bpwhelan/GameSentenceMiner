import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getGameExePathForSceneMock } = vi.hoisted(() => ({
    getGameExePathForSceneMock: vi.fn(),
}));

vi.mock('../store.js', () => ({
    getGameExePathForScene: getGameExePathForSceneMock,
}));

vi.mock('../gsm_config.js', () => ({
    getConfiguredSinglePort: () => 7275,
}));

import {
    syncProcessPausingTarget,
    syncProcessPausingTargetForScene,
} from './process_pausing_target.js';

function okFetch() {
    return vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
}

describe('syncProcessPausingTarget', () => {
    it('posts the executable path to the backend endpoint', async () => {
        const fetchImpl = okFetch();

        await syncProcessPausingTarget('/games/native-game/game', { fetchImpl });

        expect(fetchImpl).toHaveBeenCalledWith('http://localhost:7275/linux/set_target_process', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ target: '/games/native-game/game' }),
        });
    });
});

describe('syncProcessPausingTargetForScene', () => {
    beforeEach(() => {
        getGameExePathForSceneMock.mockReset();
    });

    it("syncs the scene's game executable on Linux", async () => {
        getGameExePathForSceneMock.mockReturnValue('S:\\Game\\Binaries\\Win64\\game_.exe');
        const fetchImpl = okFetch();

        const synced = await syncProcessPausingTargetForScene('Game', { platform: 'linux', fetchImpl });

        expect(synced).toBe(true);
        expect(getGameExePathForSceneMock).toHaveBeenCalledWith('Game');
        expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({
            target: 'S:\\Game\\Binaries\\Win64\\game_.exe',
        });
    });

    it('leaves the target alone for a scene without a game executable', async () => {
        getGameExePathForSceneMock.mockReturnValue('   ');
        const fetchImpl = okFetch();

        const synced = await syncProcessPausingTargetForScene('No Exe', { platform: 'linux', fetchImpl });

        expect(synced).toBe(false);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('does nothing off Linux, where the target is unused', async () => {
        getGameExePathForSceneMock.mockReturnValue('C:\\Games\\game.exe');
        const fetchImpl = okFetch();

        const synced = await syncProcessPausingTargetForScene('Game', { platform: 'win32', fetchImpl });

        expect(synced).toBe(false);
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});
