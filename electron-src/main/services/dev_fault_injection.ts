type FailurePlan = Record<string, number>;

interface InjectedFailureRecord {
    checkpoint: string;
    scenario: string;
    timestamp: string;
}

function parseCount(value: string | undefined): number {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function parseFailurePlan(rawPlan: string): FailurePlan {
    const trimmed = rawPlan.trim();
    if (!trimmed) {
        return {};
    }

    // Accept JSON object first: {"update.sync":1,"update.install":2}
    if (trimmed.startsWith('{')) {
        try {
            const parsed = JSON.parse(trimmed) as Record<string, unknown>;
            const plan: FailurePlan = {};
            for (const [checkpoint, value] of Object.entries(parsed)) {
                if (typeof checkpoint !== 'string' || checkpoint.trim().length === 0) {
                    continue;
                }
                if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
                    plan[checkpoint.trim()] = Math.floor(value);
                }
            }
            return plan;
        } catch (error) {
            console.warn('[Chaos] Failed to parse JSON failure plan from GSM_CHAOS_FAIL_PLAN:', error);
            return {};
        }
    }

    // Fallback format: checkpoint:count,other_checkpoint:count
    const plan: FailurePlan = {};
    for (const token of trimmed.split(',')) {
        const entry = token.trim();
        if (!entry) {
            continue;
        }
        const [checkpointRaw, countRaw] = entry.split(':');
        const checkpoint = checkpointRaw?.trim();
        if (!checkpoint) {
            continue;
        }
        plan[checkpoint] = parseCount(countRaw);
    }
    return plan;
}

class DevFaultInjector {
    private enabled = false;
    private scenario = 'none';
    private failurePlan = new Map<string, number>();
    private lastInjected: InjectedFailureRecord | null = null;

    public constructor() {
        this.bootstrapFromEnv();
    }

    private canUseChaosMode(): boolean {
        if (process.env.GSM_ENABLE_CHAOS === '1' || process.argv.includes('--dev-chaos-update')) {
            return true;
        }
        if (
            process.env.NODE_ENV === 'development' ||
            process.env.ELECTRON_IS_DEV === '1' ||
            process.defaultApp === true
        ) {
            return true;
        }
        return process.env.GSM_CHAOS_ALLOW_NON_DEV === '1';
    }

    private bootstrapFromEnv(): void {
        if (!this.canUseChaosMode()) {
            return;
        }
        const rawPlan = process.env.GSM_CHAOS_FAIL_PLAN;
        if (!rawPlan) {
            return;
        }
        const parsed = parseFailurePlan(rawPlan);
        if (Object.keys(parsed).length === 0) {
            return;
        }
        this.configureScenario('env', parsed);
    }

    public configureScenario(scenarioName: string, plan: FailurePlan): void {
        if (!this.canUseChaosMode()) {
            return;
        }
        this.enabled = true;
        this.scenario = scenarioName.trim() || 'unnamed';
        this.failurePlan.clear();
        for (const [checkpoint, count] of Object.entries(plan)) {
            if (count <= 0) {
                continue;
            }
            this.failurePlan.set(checkpoint, Math.floor(count));
        }
        this.lastInjected = null;
        const tokens = Array.from(this.failurePlan.entries()).map(([checkpoint, count]) => {
            return `${checkpoint}:${count}`;
        });
        console.log(
            `[Chaos] Scenario "${this.scenario}" configured with plan: ${
                tokens.length > 0 ? tokens.join(', ') : '(empty)'
            }`
        );
    }

    public clearScenario(): void {
        this.enabled = false;
        this.scenario = 'none';
        this.failurePlan.clear();
        this.lastInjected = null;
    }

    public getLastInjectedFailure(): InjectedFailureRecord | null {
        return this.lastInjected ? { ...this.lastInjected } : null;
    }

    public maybeFail(checkpoint: string, context?: string): void {
        if (!this.enabled || !this.canUseChaosMode()) {
            return;
        }

        const exactCount = this.failurePlan.get(checkpoint) ?? 0;
        const wildcardCount = this.failurePlan.get('*') ?? 0;
        let selectedKey: string | null = null;
        let remaining = 0;

        if (exactCount > 0) {
            selectedKey = checkpoint;
            remaining = exactCount;
        } else if (wildcardCount > 0) {
            selectedKey = '*';
            remaining = wildcardCount;
        }

        if (!selectedKey || remaining <= 0) {
            return;
        }

        this.failurePlan.set(selectedKey, remaining - 1);
        this.lastInjected = {
            checkpoint,
            scenario: this.scenario,
            timestamp: new Date().toISOString(),
        };

        const contextSuffix = context ? ` (${context})` : '';
        const message = `[Chaos] Injected failure at "${checkpoint}"${contextSuffix} [scenario=${this.scenario}]`;
        console.warn(message);
        throw new Error(message);
    }
}

export const devFaultInjector = new DevFaultInjector();
