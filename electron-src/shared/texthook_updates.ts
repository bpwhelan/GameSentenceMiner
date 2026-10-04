export interface EngineStatus {
    installed: boolean;
    version: string | null;
    updateAvailable: boolean;
    remoteVersion: string | null;
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
