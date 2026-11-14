import {expect,it,vi} from 'vitest';
const native=vi.hoisted(()=>({pythonSync:vi.fn()}));
vi.mock('../runtime/native_python_install.js',()=>native);
import {getDevPyprojectSyncState} from './dev_environment_sync.js';
it('uses the native fingerprint while retaining the caller environment and extras',()=>{
    const state={changed:false,fingerprint:'native fingerprint'};native.pythonSync.mockReturnValue(state);
    expect(getDevPyprojectSyncState('project','venv',['gpu'])).toBe(state);
    expect(native.pythonSync).toHaveBeenCalledExactlyOnceWith('syncState',{venvPath:'venv',extras:['gpu']});
});
