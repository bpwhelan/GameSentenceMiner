/** Compatibility client; Rust owns update scheduling and attachment exclusion. */
import {packagesCall,packagesSync} from './native_packages.js';
import type {EngineUpdateState} from '../../shared/texthook_updates.js';
export const nativeHookUpdates = {
    getState: (): EngineUpdateState => packagesSync('updates.state'),
    check: (_automatic = false): Promise<EngineUpdateState> => packagesCall('updates.check'),
    download: () => packagesCall('updates.download'),
    downloadVersion: (version: string) => packagesCall('updates.version', version),
    setAutomatic: (enabled: boolean) => packagesSync('updates.automatic', enabled),
    start: () => { void packagesCall('updates.start').catch(console.error); },
    notifyIdle: () => { void packagesCall('updates.idle').catch(console.error); },
    dispose: () => packagesSync('updates.shutdown'),
};
export function reserveHookAttachment(): string {return packagesSync('updates.reserve');}
export function releaseHookAttachment(token: string): void {packagesSync('updates.release',{token});}
