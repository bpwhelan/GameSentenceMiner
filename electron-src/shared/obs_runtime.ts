export type ObsRuntimePhase = 'idle' | 'checking' | 'downloading' | 'extracting' | 'stopping' | 'installing' | 'validating' | 'error';

export interface ObsRuntimeStatus {
    supported: boolean;
    managed: boolean;
    automatic: boolean;
    pinnedVersion: string | null;
    installedVersion: string | null;
    targetVersion: string | null;
    rollbackVersion: string | null;
    updateAvailable: boolean;
    phase: ObsRuntimePhase;
    progress: number | null;
    checkedAt: string | null;
    error: string | null;
}
