/** Compatibility API. Native Python services own probes, commands, sync and repair. */
import path from 'node:path';
import {pythonCall,pythonSync} from '../runtime/native_python_install.js';
export interface UvCommandProgressEvent {progress:number|null;message:string}
export interface ResolvedExtras {selectedExtras:string[];ignoredExtras:string[];allowedExtras:string[]|null}
export function getVenvDirFromPythonPath(pythonPath:string):string{return path.dirname(path.dirname(pythonPath));}
export function getPythonExecutablePathForVenv(venv:string):string{return path.join(venv,process.platform==='win32'?'Scripts/python.exe':'bin/python');}
export function getProjectPath():string{return pythonSync('project');}
export function getBundledBackendVersion():string|null{return pythonSync('version');}
export function getBundledBackendSpecifier():string{return pythonSync('specifier');}
export function resolveRequestedExtras(extras:string[]=[]):ResolvedExtras{return pythonSync('extras',{extras});}
export function getInstalledPackageVersion(pythonPath:string,packageName:string):Promise<string|null>{return pythonCall('installedVersion',{pythonPath,packageName});}
export async function isPackageInstalled(pythonPath:string,packageName:string):Promise<boolean>{return (await getInstalledPackageVersion(pythonPath,packageName))!==null;}
export function checkAndInstallUV(pythonPath:string):Promise<void>{return pythonCall('ensureUv',{pythonPath});}
export function checkAndEnsurePip(pythonPath:string):Promise<void>{return pythonCall('ensurePip',{pythonPath});}
export function cleanUvCache(pythonPath:string):Promise<void>{return pythonCall('cleanCache',{pythonPath});}
export function syncLockedEnvironment(pythonPath:string,extras:string[]=[],checkOnly=false,onProgress?:(event:UvCommandProgressEvent)=>void,options:{deferValidation?:boolean;reinstall?:boolean}={}):Promise<void>{
    return pythonCall('sync',{pythonPath,extras,checkOnly,options},onProgress);
}
export function installPackageNoDeps(pythonPath:string,specifier:string,forceReinstall=false,onProgress?:(event:UvCommandProgressEvent)=>void,extras:string[]=[]):Promise<void>{
    return pythonCall('install',{pythonPath,specifier,forceReinstall,extras},onProgress);
}
export async function runCommand(command:string,args:string[],_stdout:boolean,_stderr:boolean,_prefix='',options:{env?:NodeJS.ProcessEnv;cwd?:string;suppressOutput?:boolean;onProgress?:(event:UvCommandProgressEvent)=>void}={}):Promise<void>{
    await pythonCall('command',{command,args,env:options.env,cwd:options.cwd},options.onProgress);
}
