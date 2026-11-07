import type { MenuItem, MenuItemConstructorOptions } from 'electron';

export const VAD_DEBUG_TOPIC = 'dev.vad_debug';

interface DebugStatus {
    enabled: boolean;
    directory?: string;
    error?: string;
}

interface DebugDependencies {
    isDev: boolean;
    bus: {
        isConnected(client: string): boolean;
        request(client: string, topic: string, data: unknown, timeoutMs: number): Promise<unknown>;
    };
    openFolder(): Promise<void>;
    onStatus(status: DebugStatus): void;
    onError(message: string): void;
}

/** Backend-confirmed, session-only capture, like the OCR benchmark switch. */
export class DevVadDebug {
    private recording = false;

    constructor(private readonly deps: DebugDependencies) {}

    private async request(data: Record<string, unknown>): Promise<DebugStatus> {
        if (!this.deps.isDev || !this.deps.bus.isConnected('backend')) {
            throw new Error('The GSM backend must be running to record VAD debug audio.');
        }
        const result = await this.deps.bus.request('backend', VAD_DEBUG_TOPIC, data, 5000);
        if (!result || typeof result !== 'object' || typeof (result as DebugStatus).enabled !== 'boolean') {
            throw new Error('The backend returned an invalid VAD debug status.');
        }
        const status = result as DebugStatus;
        this.recording = status.enabled;
        this.deps.onStatus(status);
        return status;
    }

    async refresh(): Promise<void> {
        if (this.deps.isDev) await this.request({});
    }

    menuItems(): MenuItemConstructorOptions[] {
        if (!this.deps.isDev) return [];
        return [
            {
                id: 'dev-vad-debug',
                label: 'Record VAD Debug Audio (includes FireRed analysis)',
                type: 'checkbox',
                checked: this.recording,
                click: async (item: MenuItem) => {
                    const previous = this.recording;
                    item.checked = previous;
                    item.enabled = false;
                    try {
                        const status = await this.request({ enabled: !previous });
                        item.checked = status.enabled;
                        if (status.directory) console.info(`VAD debug ${status.enabled ? 'started' : 'stopped'}: ${status.directory}`);
                    } catch (error) {
                        item.checked = previous;
                        try {
                            await this.refresh();
                            item.checked = this.recording;
                        } catch {
                            // Keep the last confirmed state while disconnected.
                        }
                        this.deps.onError(String(error));
                    } finally {
                        item.enabled = true;
                    }
                },
            },
            {
                label: 'Open VAD Debug Folder',
                click: async () => {
                    try {
                        await this.deps.openFolder();
                    } catch (error) {
                        this.deps.onError(String(error));
                    }
                },
            },
        ];
    }
}
