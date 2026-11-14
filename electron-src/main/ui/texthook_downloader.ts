/** Compatibility API. Rust owns downloads, hashing, extraction and activation. */
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import semver from 'semver';
import {getSharedBaseDir} from '../data_dir.js';
import {packagesCall, packagesSync, packageEvents} from '../runtime/native_packages.js';
import type {EngineStatus, EngineDownloadProgress} from '../../shared/texthook_updates.js';
export type {EngineStatus, EngineDownloadProgress} from '../../shared/texthook_updates.js';
export const TEXTHOOK_DOWNLOAD_DIR = path.join(getSharedBaseDir(), 'texthook');
export const FORCE_TEXTHOOK_DOWNLOAD = true;
export interface TexhookManifest { version: string; files: {path: string; sha256: string}[]; archive?: {path: string; sha256: string}; notes?: string; engineVersions?: {luna: string; textractor: string} }
export interface PreparedTexthookUpdate { token: string; directory: string; manifest: TexhookManifest; allowDowngrade?: boolean }
export function getTexthookRuntimeDir(): string { return packagesSync('engines.directory'); }
export function isTexthookInstalled(): boolean { return packagesSync('engines.installed'); }
export function getLocalEngineStatus(): EngineStatus { return packagesSync('engines.local'); }
export function getEngineStatus(): Promise<EngineStatus> { return packagesCall('engines.status'); }
export function isNewerEngineVersion(remote: string | null, local: string | null): boolean { return !!remote && !!local && !!semver.valid(remote) && !!semver.valid(local) && semver.gt(remote, local); }
export async function prepareTexthookUpdate(onProgress?: (progress: EngineDownloadProgress) => void, onVerifying?: () => void, selectedVersion?: string): Promise<PreparedTexthookUpdate> {
    const operation = randomUUID();
    const unsubscribe = packageEvents(operation, (event, data) => { if (event === 'progress') onProgress?.(data); if (event === 'verifying') onVerifying?.(); });
    try { return await packagesCall('engines.prepare', {version: selectedVersion, operation}); } finally { unsubscribe(); }
}
export async function activateTexthookUpdate(prepared: PreparedTexthookUpdate): Promise<void> { await packagesCall('engines.activate', {token: prepared.token}); }
export async function discardTexthookUpdate(prepared: PreparedTexthookUpdate): Promise<void> { await packagesCall('engines.discard', {token: prepared.token}); }
export async function downloadTexthookEngines(onProgress?: (progress: EngineDownloadProgress) => void): Promise<void> {
    const prepared = await prepareTexthookUpdate(onProgress);
    try { await activateTexthookUpdate(prepared); } catch (error) { await discardTexthookUpdate(prepared); throw error; }
}
