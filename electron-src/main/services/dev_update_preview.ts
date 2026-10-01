import type { AppUpdateStatus } from '../../shared/app_update.js';
import type { DesktopUpdateChangelogSnapshot } from '../../shared/changelog.js';

/** Session-only display state, separate from the updater's real offer and installer. */
export class DevUpdatePreview {
    private changelog: DesktopUpdateChangelogSnapshot | null = null;
    private requestId = 0;

    public constructor(
        private readonly enabled: boolean,
        private readonly onChange: () => void
    ) {}

    public async show(load: () => Promise<DesktopUpdateChangelogSnapshot>): Promise<void> {
        if (!this.enabled) return;
        const requestId = ++this.requestId;
        const changelog = await load();
        if (requestId !== this.requestId) return;
        this.changelog = { ...changelog };
        this.onChange();
    }

    public clear(): void {
        if (!this.enabled) return;
        this.requestId += 1;
        this.changelog = null;
        this.onChange();
    }

    public getChangelog(): DesktopUpdateChangelogSnapshot | null {
        return this.changelog ? { ...this.changelog } : null;
    }

    public apply(status: AppUpdateStatus): AppUpdateStatus {
        if (!this.changelog || status.downloading) return status;
        return {
            ...status,
            currentVersion: this.changelog.fromVersion,
            latestVersion: this.changelog.toVersion,
            updateAvailable: true,
            checking: false,
            error: null,
            preview: true,
        };
    }
}
