const MAX_EVIDENCE_AGE_MS = 5_000;
const WINDOW_LOSS_GRACE_MS = 5_000;

/** Shared session evidence from the backend's capture and window monitor. */
export class ActiveGameTracker {
    private snapshot: { sceneName: string; active: boolean | null } | null = null;
    private receivedAt = 0;
    private inactiveSince: number | null = null;

    update(value: unknown, now = Date.now()): void {
        if (!value || typeof value !== 'object') return;
        const data = value as Record<string, unknown>;
        if (typeof data.sceneName !== 'string' ||
            (typeof data.active !== 'boolean' && data.active !== null)) return;
        // Discard heartbeats buffered during a backend/bus reconnect.
        if (typeof data.observedAt === 'number' &&
            (!Number.isFinite(data.observedAt) || now - data.observedAt > MAX_EVIDENCE_AGE_MS || data.observedAt > now + 1000)) return;
        if (this.snapshot?.sceneName !== data.sceneName || now - this.receivedAt > MAX_EVIDENCE_AGE_MS) {
            this.inactiveSince = null;
        }
        this.snapshot = { sceneName: data.sceneName, active: data.active };
        this.receivedAt = now;
        this.inactiveSince = data.active === false ? (this.inactiveSince ?? now) : null;
    }

    hasSnapshot(): boolean {
        return this.snapshot !== null;
    }

    get(sceneName?: string, now = Date.now()): boolean | null {
        if (!this.snapshot || now - this.receivedAt > MAX_EVIDENCE_AGE_MS ||
            (sceneName !== undefined && this.snapshot.sceneName !== sceneName)) return null;
        if (this.snapshot.active !== false) return this.snapshot.active;
        return this.inactiveSince !== null && now - this.inactiveSince >= WINDOW_LOSS_GRACE_MS ? false : null;
    }
}

export const activeGame = new ActiveGameTracker();
