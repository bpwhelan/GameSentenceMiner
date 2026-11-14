/** Agent library installation belongs to Rust; UI path helpers stay here. */
import path from 'node:path';
import {BASE_DIR} from './util.js';
import {packagesCall} from './runtime/native_packages.js';
const MANAGED_AGENT_SCRIPTS_ROOT = path.join(BASE_DIR, 'agent-scripts');
const MANAGED_AGENT_SCRIPTS_PATH = path.join(MANAGED_AGENT_SCRIPTS_ROOT, 'scripts');
function normalizePathForCompare(value: string): string { return path.resolve(value).toLowerCase(); }
export interface ManagedAgentScriptsStatus {
    path: string;
    repository: string;
    branch?: string;
    commit?: string;
    installed: boolean;
    updated: boolean;
    scriptCount: number;
    checkedAt?: number;
    warning?: string;
}

export function getManagedAgentScriptsPath(): string {
    return MANAGED_AGENT_SCRIPTS_PATH;
}

export function getEffectiveAgentScriptsPath(configuredPath: string | null | undefined): string {
    const trimmedPath = typeof configuredPath === 'string' ? configuredPath.trim() : '';
    return trimmedPath || MANAGED_AGENT_SCRIPTS_PATH;
}

export function isManagedAgentScriptsPath(candidatePath: string | null | undefined): boolean {
    const trimmedPath = typeof candidatePath === 'string' ? candidatePath.trim() : '';
    if (!trimmedPath) {
        return true;
    }

    const candidate = normalizePathForCompare(trimmedPath);
    const root = normalizePathForCompare(MANAGED_AGENT_SCRIPTS_ROOT);
    const scriptsPath = normalizePathForCompare(MANAGED_AGENT_SCRIPTS_PATH);
    return (
        candidate === root ||
        candidate === scriptsPath ||
        candidate.startsWith(`${root}${path.sep}`) ||
        candidate.startsWith(`${scriptsPath}${path.sep}`)
    );
}

export function ensureManagedAgentScriptsCurrent(options: {force?: boolean} = {}): Promise<ManagedAgentScriptsStatus> {
    return packagesCall('scripts.ensure', {force: options.force === true});
}
