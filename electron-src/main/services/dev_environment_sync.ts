import {pythonSync} from '../runtime/native_python_install.js';
export interface DevPyprojectSyncState {changed:boolean;fingerprint:string}
export function getDevPyprojectSyncState(_projectPath:string,venvPath:string,extras:string[]=[]):DevPyprojectSyncState {
    return pythonSync('syncState',{venvPath,extras});
}
