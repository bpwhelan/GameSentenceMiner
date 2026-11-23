/** Migrated features call typed Tauri commands directly. No Node IPC hop. */
import type {IpcEventLike} from '../types/global';
type ProfileIdentity = {exeName: string; sceneId?: string};
type ProfilesRequest = {action:'list'} | ({action:'get'|'delete'} & ProfileIdentity) | {action:'save';profile:unknown};
type UpdatesRequest = {action:'status'|'check'|'download'} | {action:'version';version:string} | {action:'automatic';enabled:boolean};
type MiningRequest = {action:'loadText'|'latestText'|'exclusions'|'stopSpeech'|'speechStatus'}
    | {action:'saveText';config:unknown} | {action:'preview';payload:unknown}
    | {action:'addExclusion'|'removeExclusion';game:string;text:string}
    | {action:'loadSpeech';scene:unknown} | {action:'saveSpeech'|'startSpeech';scene:unknown;settings:unknown};
type SessionRequest = {action:'snapshot'} | {action:'retry';sessionId:string;attempt:number};
type DictionaryRequest = {action:'openSettings'|'openJitenSettings'|'settings'|'browserSources'|'browseProfile'}
    | {action:'lookup';text:string} | {action:'select'|'useOriginal';reader:string}
    | {action:'importBrowser';directory:string;id:string};
type Request = {command:'overlay_lifecycle';request:{action:'status'|'openSettings'}|{action:'setEnabled';enabled:boolean}} | {command:'dictionary_service';request:DictionaryRequest} | {command:'hook_profiles';request:ProfilesRequest} | {command:'hook_updates';request:UpdatesRequest} | {command:'mining_workspace';request:MiningRequest} | {command:'installation_session';request:SessionRequest} | {command:'python_environment';request:{action:'info'|'packages'|'cleanCache'}};
function identity(value:unknown):ProfileIdentity {
    if(typeof value==='string')return {exeName:value};
    const data=(value??{}) as Partial<ProfileIdentity>;
    return {exeName:String(data.exeName??''),sceneId:data.sceneId};
}
export function nativeRequest(channel:string,args:unknown[]):Request|null {
    switch(channel){
        case 'getOverlayStatus':return {command:'overlay_lifecycle',request:{action:'status'}};
        case 'setOverlayEnabled':return {command:'overlay_lifecycle',request:{action:'setEnabled',enabled:args[0] as boolean}};
        case 'settings.openOverlaySettings':return {command:'overlay_lifecycle',request:{action:'openSettings'}};
        case 'reader.lookup':return {command:'dictionary_service',request:{action:'lookup',text:args[0] as string}};
        case 'dictionary.openSettings':return {command:'dictionary_service',request:{action:'openSettings'}};
        case 'dictionary.settings':return {command:'dictionary_service',request:{action:'settings'}};
        case 'dictionary.openJitenSettings':return {command:'dictionary_service',request:{action:'openJitenSettings'}};
        case 'dictionary.select':return {command:'dictionary_service',request:{action:'select',reader:args[0] as string}};
        case 'dictionary.browserSources':return {command:'dictionary_service',request:{action:'browserSources'}};
        case 'dictionary.browseProfile':return {command:'dictionary_service',request:{action:'browseProfile'}};
        case 'dictionary.importBrowser':{
            const source=args[0] as {directory:string;id:string};
            return {command:'dictionary_service',request:{action:'importBrowser',directory:source.directory,id:source.id}};
        }
        case 'dictionary.useOriginal':return {command:'dictionary_service',request:{action:'useOriginal',reader:args[0] as string}};
        case 'python.getPythonInfo':return {command:'python_environment',request:{action:'info'}};
        case 'python.getInstalledPackages':return {command:'python_environment',request:{action:'packages'}};
        case 'python.cleanCache':return {command:'python_environment',request:{action:'cleanCache'}};
        case 'install-session.getActive':return {command:'installation_session',request:{action:'snapshot'}};
        case 'install-session.retry':{
            const lease=args[0] as {sessionId:string;attempt:number};
            return {command:'installation_session',request:{action:'retry',sessionId:lease.sessionId,attempt:lease.attempt}};
        }
        case 'textprocess.load':return {command:'mining_workspace',request:{action:'loadText'}};
        case 'textprocess.save':return {command:'mining_workspace',request:{action:'saveText',config:args[0]}};
        case 'textprocess.preview':return {command:'mining_workspace',request:{action:'preview',payload:args[0]}};
        case 'textprocess.latestText':return {command:'mining_workspace',request:{action:'latestText'}};
        case 'textprocess.exclusions.list':return {command:'mining_workspace',request:{action:'exclusions'}};
        case 'textprocess.exclusions.add':case 'textprocess.exclusions.remove':{
            const payload=args[0] as {game:string;text:string};
            return {command:'mining_workspace',request:{action:channel.endsWith('.add')?'addExclusion':'removeExclusion',game:payload.game,text:payload.text}};
        }
        case 'speech-recognition.loadScene':return {command:'mining_workspace',request:{action:'loadSpeech',scene:(args[0] as {scene:unknown}).scene}};
        case 'speech-recognition.saveScene':case 'speech-recognition.start':{
            const payload=args[0] as {scene:unknown;settings:unknown};
            return {command:'mining_workspace',request:{action:channel.endsWith('.start')?'startSpeech':'saveSpeech',scene:payload.scene,settings:payload.settings}};
        }
        case 'speech-recognition.stop':return {command:'mining_workspace',request:{action:'stopSpeech'}};
        case 'speech-recognition.getStatus':return {command:'mining_workspace',request:{action:'speechStatus'}};
        case 'texthook.getAllProfiles':return {command:'hook_profiles',request:{action:'list'}};
        case 'texthook.getProfile':return {command:'hook_profiles',request:{action:'get',...identity(args[0])}};
        case 'texthook.saveProfile':return {command:'hook_profiles',request:{action:'save',profile:args[0]}};
        case 'texthook.deleteProfile':return {command:'hook_profiles',request:{action:'delete',...identity(args[0])}};
        case 'texthook.getEngineStatus':return {command:'hook_updates',request:{action:'status'}};
        case 'texthook.checkEngineUpdates':return {command:'hook_updates',request:{action:'check'}};
        case 'texthook.downloadEngines':return {command:'hook_updates',request:{action:'download'}};
        case 'texthook.installEngineVersion':return {command:'hook_updates',request:{action:'version',version:args[0] as string}};
        case 'texthook.setAutomaticEngineUpdates':return {command:'hook_updates',request:{action:'automatic',enabled:args[0] as boolean}};
        default:return null;
    }
}
export function invokeNative<T>(channel:string,args:unknown[]):Promise<T>|null {
    if(window.gsmEnv?.shell!=='tauri')return null;
    const request=nativeRequest(channel,args);
    if(!request)return null;
    if(request.command==='mining_workspace'||request.command==='installation_session'||request.command==='python_environment')return window.__GSM_INVOKE__!<string>(request.command,{request:request.request}).then(value=>JSON.parse(value) as T);
    return window.__GSM_INVOKE__!<T>(request.command,{request:request.request});
}
export function listenNative(channel:string,listener:(event:IpcEventLike,...args:unknown[])=>void):(()=>void)|null {
    const mining=['textprocess-latest-text','textprocess-exclusions-changed','speech-recognition.status','speech-recognition.log'].includes(channel);
    const session=['install-session.snapshot','install-session.finished'].includes(channel);
    if(window.gsmEnv?.shell!=='tauri'||(!session&&!mining&&channel!=='texthook.engineUpdateState'))return null;
    let disposed=false;let unlisten:(()=>void)|undefined;
    void window.__TAURI__!.event.listen(session?'installation-session':mining?'mining-workspace':'hook-updates',({payload})=>{
        if(disposed)return;
        if(mining||session){
            const event=(typeof payload==='string'?JSON.parse(payload):payload) as {channel:string;payload:unknown};
            if(event.channel===channel)listener({sender:null},event.payload);
        }else listener({sender:null},payload);
    }).then(off=>{if(disposed)off();else unlisten=off;}).catch(console.error);
    return ()=>{disposed=true;unlisten?.();};
}
