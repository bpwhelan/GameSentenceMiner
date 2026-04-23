export type InstallSessionOrigin =
    | 'startup'
    | 'repair'
    | 'reset_dependencies'
    | 'backend_update';

export type InstallStageId =
    | 'prepare'
    | 'uv'
    | 'python'
    | 'venv'
    | 'verify_runtime'
    | 'lock_sync'
    | 'gsm_package'
    | 'backend_boot'
    | 'obs'
    | 'ffmpeg'
    | 'oneocr'
    | 'finalize';

export type InstallStageStatus =
    | 'pending'
    | 'running'
    | 'completed'
    | 'skipped'
    | 'failed';

export type InstallProgressKind = 'bytes' | 'estimated' | 'indeterminate';

export interface InstallStageDefinition {
    id: InstallStageId;
    label: string;
    weight: number;
}

export interface InstallStageState {
    id: InstallStageId;
    label: string;
    weight: number;
    status: InstallStageStatus;
    progressKind: InstallProgressKind;
    progress: number | null;
    message: string;
    downloadedBytes: number | null;
    totalBytes: number | null;
    startedAt: number | null;
    finishedAt: number | null;
    error: string | null;
}

export interface InstallLogEntry {
    id: string;
    message: string;
    level?: string;
    stream?: 'stdout' | 'stderr';
    source?: string;
    createdAt: number;
}

export interface InstallSessionSnapshot {
    id: string;
    origin: InstallSessionOrigin;
    status: 'running' | 'completed' | 'failed';
    startedAt: number;
    finishedAt: number | null;
    currentStageId: InstallStageId | null;
    overallProgress: number;
    currentMessage: string;
    error: string | null;
    stages: InstallStageState[];
    logs: InstallLogEntry[];
}

export interface InstallStageProgressUpdate {
    stageId: InstallStageId;
    status?: InstallStageStatus;
    progressKind?: InstallProgressKind;
    progress?: number | null;
    message?: string;
    downloadedBytes?: number | null;
    totalBytes?: number | null;
    error?: string | null;
}

export const INSTALL_STAGE_DEFINITIONS: InstallStageDefinition[] = [
    { id: 'prepare', label: 'Preparing install session', weight: 2 },
    { id: 'uv', label: 'Installing uv runtime', weight: 6 },
    { id: 'python', label: 'Installing Python runtime', weight: 15 },
    { id: 'venv', label: 'Creating virtual environment', weight: 8 },
    { id: 'verify_runtime', label: 'Verifying Python runtime', weight: 5 },
    { id: 'lock_sync', label: 'Syncing lockfile dependencies', weight: 20 },
    { id: 'gsm_package', label: 'Installing GSM backend package', weight: 5 },
    { id: 'backend_boot', label: 'Starting backend process', weight: 4 },
    { id: 'obs', label: 'Installing OBS dependencies', weight: 18 },
    { id: 'ffmpeg', label: 'Installing FFmpeg', weight: 10 },
    { id: 'oneocr', label: 'Installing OneOCR', weight: 6 },
    { id: 'finalize', label: 'Finalizing setup', weight: 1 },
];

export const INSTALL_STAGE_IDS = INSTALL_STAGE_DEFINITIONS.map(
    (definition) => definition.id
);

export function getInstallStageDefinition(stageId: InstallStageId): InstallStageDefinition {
    const definition = INSTALL_STAGE_DEFINITIONS.find((entry) => entry.id === stageId);
    if (!definition) {
        throw new Error(`Unknown install stage: ${stageId}`);
    }
    return definition;
}

export function clampInstallProgress(value: number | null | undefined): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return null;
    }
    return Math.max(0, Math.min(1, value));
}
