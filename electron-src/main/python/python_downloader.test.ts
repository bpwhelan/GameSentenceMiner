import {beforeEach,describe,expect,it,vi} from 'vitest';
const native=vi.hoisted(()=>({pythonCall:vi.fn(),pythonSync:vi.fn()}));
vi.mock('../runtime/native_python_install.js',()=>native);
import {getOrInstallPython,hasManagedPythonInstall,reinstallPython} from './python_downloader.js';
describe('managed Python native adapter',()=>{
    beforeEach(()=>vi.resetAllMocks());
    it('adopts or installs using the native owner and returns its path',async()=>{
        native.pythonSync.mockReturnValue(true);native.pythonCall.mockResolvedValue('managed/Scripts/python.exe');
        expect(hasManagedPythonInstall()).toBe(true);
        expect(await getOrInstallPython()).toBe('managed/Scripts/python.exe');
        expect(native.pythonSync).toHaveBeenCalledWith('present');expect(native.pythonCall).toHaveBeenCalledWith('ensure');
    });
    it('surfaces native repair failures without deleting an environment in JavaScript',async()=>{
        native.pythonCall.mockRejectedValue(new Error('Previous environment restored'));
        await expect(reinstallPython()).rejects.toThrow('Previous environment restored');
        expect(native.pythonCall).toHaveBeenCalledExactlyOnceWith('reinstall');
    });
});
