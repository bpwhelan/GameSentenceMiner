export interface EnginePackageVersion {
    version: string;
    notes?: string;
    engineVersions?: { luna: string; textractor: string };
}

export interface EngineStatus {
    installed: boolean;
    version: string | null;
    updateAvailable: boolean;
    remoteVersion: string | null;
    /** Newest first. remoteVersion remains the recommended automatic target. */
    availableVersions?: EnginePackageVersion[];
}

export interface EngineDownloadProgress {
    file: string;
    fileIndex: number;
    totalFiles: number;
    bytesDownloaded: number;
    bytesTotal: number | null;
}

export type EngineUpdatePhase = 'idle' | 'checking' | 'downloading' | 'verifying' | 'waiting' | 'installing' | 'error';

export interface EngineUpdateState extends EngineStatus {
    automatic: boolean;
    phase: EngineUpdatePhase;
    pendingVersion: string | null;
    error: string | null;
    progress: EngineDownloadProgress | null;
}
