/** Compatibility names for the native managed-Python installer. */
import {pythonCall,pythonSync} from '../runtime/native_python_install.js';
export function hasManagedPythonInstall():boolean{return pythonSync('present');}
export function getOrInstallPython():Promise<string>{return pythonCall('ensure');}
export async function reinstallPython():Promise<void>{await pythonCall('reinstall');}
