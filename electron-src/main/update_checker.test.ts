import {beforeEach,expect,it,vi} from 'vitest';
const native=vi.hoisted(()=>({pythonCall:vi.fn(),pythonSync:vi.fn()}));
vi.mock('./runtime/native_python_install.js',()=>native);
vi.mock('./store.js',()=>({getPythonPath:()=> 'managed-python'}));
import {checkForUpdates} from './update_checker.js';
beforeEach(()=>vi.resetAllMocks());
it('asks Rust to choose compatible backend updates and reuses a supplied installed version',async()=>{
    native.pythonCall.mockResolvedValue({currentVersion:'2026.11.0',latestVersion:'2026.11.0.post1',updateAvailable:true});
    expect(await checkForUpdates(false,'2026.11.0')).toEqual({latestVersion:'2026.11.0.post1',updateAvailable:true});
    expect(native.pythonCall).toHaveBeenCalledExactlyOnceWith('updateCheck',{pythonPath:'managed-python',force:false,knownInstalledVersion:'2026.11.0'});
});
it('distinguishes an unknown installed version from a known missing package',async()=>{
    native.pythonCall.mockResolvedValue({latestVersion:'2026.11.0',updateAvailable:true});
    await checkForUpdates();await checkForUpdates(true,null);
    expect(native.pythonCall.mock.calls).toEqual([
        ['updateCheck',{pythonPath:'managed-python',force:false}],
        ['updateCheck',{pythonPath:'managed-python',force:true,knownInstalledVersion:null}],
    ]);
});
it('propagates native failures so the update screen retains an actionable error',async()=>{
    native.pythonCall.mockRejectedValue(Error('Invalid bundled project'));
    await expect(checkForUpdates()).rejects.toThrow('Invalid bundled project');
});
