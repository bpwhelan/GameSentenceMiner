import {beforeEach,describe,expect,it,vi} from 'vitest';
const native=vi.hoisted(()=>({pythonCall:vi.fn(),pythonSync:vi.fn()}));
vi.mock('../runtime/native_python_install.js',()=>native);
import {getBundledBackendSpecifier,getBundledBackendVersion,getInstalledPackageVersion,isPackageInstalled,resolveRequestedExtras,syncLockedEnvironment,installPackageNoDeps,runCommand,checkAndEnsurePip,checkAndInstallUV} from './python_ops.js';
describe('native Python operation adapters',()=>{
    beforeEach(()=>vi.resetAllMocks());
    it('uses native metadata, package selection and extra normalization',async()=>{
        native.pythonSync.mockReturnValueOnce('2026.11.0').mockReturnValueOnce('bundled.whl').mockReturnValueOnce({selectedExtras:['gpu'],ignoredExtras:['old']});
        expect(getBundledBackendVersion()).toBe('2026.11.0');expect(getBundledBackendSpecifier()).toBe('bundled.whl');
        expect(resolveRequestedExtras(['gpu','old'])).toEqual({selectedExtras:['gpu'],ignoredExtras:['old']});
        expect(native.pythonSync.mock.calls).toEqual([['version'],['specifier'],['extras',{extras:['gpu','old']}]]);
        native.pythonCall.mockResolvedValueOnce('2026.11.0.post1').mockResolvedValueOnce(null);
        expect(await getInstalledPackageVersion('python','GameSentenceMiner')).toBe('2026.11.0.post1');
        expect(await isPackageInstalled('python','missing')).toBe(false);
        expect(native.pythonCall).toHaveBeenCalledWith('installedVersion',{pythonPath:'python',packageName:'missing'});
    });
    it('preserves validation deferral, forced repair, extras and progress callbacks',async()=>{
        const progress=vi.fn();
        await syncLockedEnvironment('python',['gpu'],false,progress,{deferValidation:true,reinstall:true});
        expect(native.pythonCall).toHaveBeenCalledWith('sync',{pythonPath:'python',extras:['gpu'],checkOnly:false,options:{deferValidation:true,reinstall:true}},progress);
        await installPackageNoDeps('python','bundle.whl',true,progress,['gpu']);
        expect(native.pythonCall).toHaveBeenCalledWith('install',{pythonPath:'python',specifier:'bundle.whl',forceReinstall:true,extras:['gpu']},progress);
    });
    it('delegates tooling and direct commands without a Node subprocess',async()=>{
        await checkAndEnsurePip('python');await checkAndInstallUV('python');
        expect(native.pythonCall).toHaveBeenCalledWith('ensurePip',{pythonPath:'python'});
        expect(native.pythonCall).toHaveBeenCalledWith('ensureUv',{pythonPath:'python'});
        const onProgress=vi.fn();
        await runCommand('python',['-m','uv','sync'],true,true,'',{cwd:'project',env:{TEST:'value'},onProgress});
        expect(native.pythonCall).toHaveBeenCalledWith('command',{command:'python',args:['-m','uv','sync'],cwd:'project',env:{TEST:'value'}},onProgress);
        native.pythonCall.mockRejectedValue(new Error('Dependency verification failed'));
        await expect(syncLockedEnvironment('python')).rejects.toThrow('Dependency verification failed');
    });
});
