import {describe, expect, it, vi} from 'vitest';
const call = vi.hoisted(() => vi.fn());
vi.mock('./runtime/native_packages.js', () => ({packagesCall: call}));
vi.mock('./util.js', () => ({BASE_DIR: 'fixture'}));
import {ensureManagedAgentScriptsCurrent, getEffectiveAgentScriptsPath, getManagedAgentScriptsPath, isManagedAgentScriptsPath} from './agent_scripts_repository.js';
describe('native Agent library facade', () => {
    it('preserves custom paths and resolves an empty choice to the managed library', () => {
        expect(getEffectiveAgentScriptsPath('  custom  ')).toBe('custom');
        expect(getEffectiveAgentScriptsPath('')).toBe(getManagedAgentScriptsPath());
        expect(isManagedAgentScriptsPath(getManagedAgentScriptsPath())).toBe(true);
        expect(isManagedAgentScriptsPath('custom')).toBe(false);
    });
    it('delegates forced updates and returns native offline warnings', async () => {
        const result = {installed: true, updated: false, warning: 'Offline; using local scripts'};
        call.mockResolvedValue(result);
        expect(await ensureManagedAgentScriptsCurrent({force: true})).toBe(result);
        expect(call).toHaveBeenCalledWith('scripts.ensure', {force: true});
    });
});
