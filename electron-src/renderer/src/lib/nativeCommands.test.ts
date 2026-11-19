import {describe,it,expect,vi,afterEach} from 'vitest';
import {invokeNative,listenNative,nativeRequest} from './nativeCommands';
afterEach(()=>vi.unstubAllGlobals());
describe('direct Tauri feature boundary',()=>{
    it('routes Python information, installed packages and cache cleanup directly to Rust',async()=>{
        const invoke=vi.fn().mockResolvedValue('{"success":true,"packages":[]}');
        vi.stubGlobal('window',{gsmEnv:{shell:'tauri'},__GSM_INVOKE__:invoke});
        for(const [channel,action] of [['python.getPythonInfo','info'],['python.getInstalledPackages','packages'],['python.cleanCache','cleanCache']]){
            expect(await invokeNative(channel,[])).toEqual({success:true,packages:[]});
            expect(invoke).toHaveBeenLastCalledWith('python_environment',{request:{action}});
        }
    });
    it('reads installation state and retries through the native session owner',async()=>{
        const invoke=vi.fn().mockResolvedValue('{"status":"failed","attempt":2}');
        vi.stubGlobal('window',{gsmEnv:{shell:'tauri'},__GSM_INVOKE__:invoke});
        expect(await invokeNative('install-session.getActive',[])).toEqual({status:'failed',attempt:2});
        expect(invoke).toHaveBeenCalledWith('installation_session',{request:{action:'snapshot'}});
        expect(nativeRequest('install-session.retry',[{sessionId:'session',attempt:2}])).toEqual({command:'installation_session',request:{action:'retry',sessionId:'session',attempt:2}});
    });
    it('delivers native installation events with no service forwarding',async()=>{
        let receive!:(event:{payload:unknown})=>void;const listener=vi.fn();
        const listen=vi.fn((_name:string,callback:typeof receive)=>{receive=callback;return Promise.resolve(vi.fn());});
        vi.stubGlobal('window',{gsmEnv:{shell:'tauri'},__TAURI__:{event:{listen}}});
        const dispose=listenNative('install-session.finished',listener)!;
        receive({payload:JSON.stringify({channel:'install-session.snapshot',payload:{status:'running'}})});
        receive({payload:JSON.stringify({channel:'install-session.finished',payload:{status:'completed'}})});
        expect(listener).toHaveBeenCalledExactlyOnceWith({sender:null},{status:'completed'});
        expect(listen.mock.calls[0][0]).toBe('installation-session');
        await Promise.resolve();dispose();
    });
    it('maps only migrated commands and preserves profile identities',()=>{
        expect(nativeRequest('texthook.getProfile',[{exeName:'game.exe',sceneId:'scene'}])).toEqual({command:'hook_profiles',request:{action:'get',exeName:'game.exe',sceneId:'scene'}});
        expect(nativeRequest('settings.getSettings',[])).toBeNull();
    });
    it('calls typed native commands without falling back to Node on errors',async()=>{
        const invoke=vi.fn().mockRejectedValue(Error('native failed'));
        vi.stubGlobal('window',{gsmEnv:{shell:'tauri'},__GSM_INVOKE__:invoke});
        await expect(invokeNative('texthook.getEngineStatus',[])).rejects.toThrow('native failed');
        expect(invoke).toHaveBeenCalledWith('hook_updates',{request:{action:'status'}});
    });
    it('routes mining settings, previews, exclusions and speech directly to Tauri',()=>{
        const cases:Record<string,unknown>={
            'textprocess.load':{action:'loadText'},'textprocess.save':{action:'saveText',config:{scene:'id',settings:{}}},
            'textprocess.preview':{action:'preview',payload:{scene:'id',settings:{}}},'textprocess.latestText':{action:'latestText'},
            'textprocess.exclusions.list':{action:'exclusions'},'speech-recognition.loadScene':{action:'loadSpeech',scene:'id'},
            'speech-recognition.saveScene':{action:'saveSpeech',scene:'id',settings:{}},'speech-recognition.start':{action:'startSpeech',scene:'id',settings:{}},
            'speech-recognition.stop':{action:'stopSpeech'},'speech-recognition.getStatus':{action:'speechStatus'},
        };
        for(const [channel,request]of Object.entries(cases))expect(nativeRequest(channel,[{scene:'id',settings:{}}])).toEqual({command:'mining_workspace',request});
        expect(nativeRequest('textprocess.exclusions.add',[{game:'日本語',text:'menu'}])).toEqual({command:'mining_workspace',request:{action:'addExclusion',game:'日本語',text:'menu'}});
    });
    it('filters native mining events by their channel',async()=>{
        let receive!:(event:{payload:unknown})=>void;const listener=vi.fn();
        const listen=vi.fn((_name:string,callback:typeof receive)=>{receive=callback;return Promise.resolve(vi.fn());});
        vi.stubGlobal('window',{gsmEnv:{shell:'tauri'},__TAURI__:{event:{listen}}});
        const dispose=listenNative('speech-recognition.status',listener)!;
        receive({payload:{channel:'textprocess-latest-text',payload:{text:'ignored'}}});
        receive({payload:JSON.stringify({channel:'speech-recognition.status',payload:{running:true}})});
        expect(listener).toHaveBeenCalledExactlyOnceWith({sender:null},{running:true});
        await Promise.resolve();dispose();
        receive({payload:{channel:'speech-recognition.status',payload:{running:false}}});
        expect(listener).toHaveBeenCalledOnce();
    });
    it('preserves arbitrary game keys through the native JSON boundary',async()=>{
        const invoke=vi.fn().mockResolvedValue('{"success":true,"games":{"__proto__":["menu"]}}');
        vi.stubGlobal('window',{gsmEnv:{shell:'tauri'},__GSM_INVOKE__:invoke});
        const result=await invokeNative<{games:Record<string,string[]>}>('textprocess.exclusions.list',[]);
        expect(Object.hasOwn(result!.games,'__proto__')).toBe(true);
        expect(result!.games.__proto__).toEqual(['menu']);
    });
    it('cleans up a Tauri subscription even when unmounted before registration completes',async()=>{
        let finish!:(off:()=>void)=>void;const off=vi.fn();const listener=vi.fn();
        const listen=vi.fn(()=>new Promise<()=>void>(resolve=>{finish=resolve;}));
        vi.stubGlobal('window',{gsmEnv:{shell:'tauri'},__TAURI__:{event:{listen}}});
        const dispose=listenNative('texthook.engineUpdateState',listener)!;dispose();finish(off);await Promise.resolve();
        expect(off).toHaveBeenCalledOnce();
        expect(listen.mock.calls[0][0]).toBe('hook-updates');
    });
});

it('uses typed commands for overlay activation and independent dictionary lookup', async () => {
    const invoke = vi.fn().mockResolvedValue({isRunning:true});
    vi.stubGlobal('window', {gsmEnv:{shell:'tauri'}, __GSM_INVOKE__:invoke});
    await invokeNative('setOverlayEnabled', [true]);
    expect(invoke).toHaveBeenLastCalledWith('overlay_lifecycle', {request:{action:'setEnabled',enabled:true}});
    await invokeNative('reader.lookup', ['食べる']);
    expect(invoke).toHaveBeenLastCalledWith('dictionary_service', {request:{action:'lookup',text:'食べる'}});
});
