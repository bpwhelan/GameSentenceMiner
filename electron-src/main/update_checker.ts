/** Compatibility entry points; Rust owns version probing and release policy. */
import {getPythonPath} from './store.js';
import {pythonCall, pythonSync} from './runtime/native_python_install.js';
export function getCurrentVersion(): string | null { return pythonSync('installedVersion',{pythonPath:getPythonPath(),packageName:'GameSentenceMiner'}); }
export function getLatestVersion(): string | null { return pythonSync('version'); }
export async function checkForUpdates(force=false,knownInstalledVersion?:string|null):Promise<{updateAvailable:boolean;latestVersion:string|null}> {
    const result=await pythonCall('updateCheck',{pythonPath:getPythonPath(),force,...(knownInstalledVersion===undefined?{}:{knownInstalledVersion})});
    return {updateAvailable:result.updateAvailable,latestVersion:result.latestVersion};
}
