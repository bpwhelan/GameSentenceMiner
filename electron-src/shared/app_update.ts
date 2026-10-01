export interface AppUpdateStatus {
    currentVersion: string;
    latestVersion: string | null;
    updateAvailable: boolean;
    checkedAt: string | null;
    error: string | null;
    checking: boolean;
    downloading: boolean;
    channel: 'latest' | 'beta';
    preview?: boolean;
}

export const APP_UPDATE_STATUS_CHANNEL = 'settings-app-update-status';
