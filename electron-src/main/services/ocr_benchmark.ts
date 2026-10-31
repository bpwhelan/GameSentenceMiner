import type { MenuItem, MenuItemConstructorOptions } from 'electron';

export const OCR_BENCHMARK_TOPIC = 'dev.ocr_benchmark';

interface BenchmarkStatus {
    enabled: boolean;
    csv_path?: string;
    error?: string;
}

interface BenchmarkDependencies {
    isDev: boolean;
    bus: {
        isConnected(client: string): boolean;
        request(client: string, topic: string, data: unknown, timeoutMs: number): Promise<unknown>;
    };
    openFolder(): Promise<void>;
    onStatus(status: BenchmarkStatus): void;
    onError(message: string): void;
}

/** Backend-confirmed, session-only developer switch. Never persist this in user settings. */
export class DevOcrBenchmark {
    private recording = false;

    constructor(private readonly deps: BenchmarkDependencies) {}

    private async request(data: Record<string, unknown>): Promise<BenchmarkStatus> {
        if (!this.deps.isDev || !this.deps.bus.isConnected('backend')) {
            throw new Error('The GSM backend must be running to use OCR benchmarking.');
        }
        const result = await this.deps.bus.request('backend', OCR_BENCHMARK_TOPIC, data, 5000);
        if (!result || typeof result !== 'object' || typeof (result as BenchmarkStatus).enabled !== 'boolean') {
            throw new Error('The backend returned an invalid OCR benchmark status.');
        }
        const status = result as BenchmarkStatus;
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
                id: 'dev-ocr-benchmark',
                label: 'Record OCR vs Texthook (suppress automatic OCR)',
                type: 'checkbox',
                checked: this.recording,
                click: async (item: MenuItem) => {
                    const previous = this.recording;
                    item.checked = previous;
                    item.enabled = false;
                    try {
                        const status = await this.request({ enabled: !previous });
                        item.checked = status.enabled;
                        if (status.csv_path) console.info(`OCR benchmark ${status.enabled ? 'started' : 'stopped'}: ${status.csv_path}`);
                        if (status.error) this.deps.onError(status.error);
                    } catch (error) {
                        item.checked = previous;
                        try {
                            // A lost acknowledgement can still follow a
                            // successful change. Reconcile before reporting it.
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
                label: 'Open OCR Benchmark Folder',
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
