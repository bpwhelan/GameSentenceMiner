export type DesktopUpdateChangelogStatus = 'loading' | 'ready' | 'failed';

export type DesktopUpdateChangelogSource = 'bundled' | 'remote' | null;

export interface DesktopUpdateChangelogSnapshot {
    fromVersion: string;
    toVersion: string;
    status: DesktopUpdateChangelogStatus;
    source: DesktopUpdateChangelogSource;
    title: string;
    markdown: string;
    assetBaseUrl: string;
    error: string | null;
}

export interface DesktopUpdateChangelogPendingRecord {
    fromVersion: string;
    toVersion: string;
}
