import { probeWindowsProcessPrivileges, type PrivilegeTarget, type ProcessPrivilegeResult } from '../runtime/windows_process_privileges.js';
import type { GamePrivilegeWarning } from '../../shared/game_privileges.js';

export const GAME_PRIVILEGE_CHECK_INTERVAL_MS = 30_000;
type TargetSource = 'capture' | 'texthook';

interface Dependencies {
    platform?: NodeJS.Platform;
    probe: (targets: PrivilegeTarget[]) => Promise<ProcessPrivilegeResult>;
    publish?: (warning: GamePrivilegeWarning | null) => void;
}

const normalizeExe = (exe: string) => exe.replaceAll('\\', '/').split('/').at(-1)?.trim().toLowerCase() ?? '';
const targetKey = (target: PrivilegeTarget) => `${target.exeName}:${target.pid ?? '*'}`;

export class GamePrivilegeMonitor {
    private readonly targets = new Map<TargetSource, PrivilegeTarget>();
    private readonly lastChecked = new Map<string, number>();
    private readonly dismissed = new Set<string>();
    private warning: GamePrivilegeWarning | null = null;
    private revision = 0;
    private inFlight: Promise<void> | null = null;
    private gsmElevated = false;

    constructor(private readonly deps: Dependencies) {}

    setTarget(source: TargetSource, value: PrivilegeTarget | null): void {
        const exeName = value ? normalizeExe(value.exeName) : '';
        const pid = value?.pid;
        const target = exeName ? { exeName, ...(pid !== undefined && Number.isSafeInteger(pid) && pid > 0 ? { pid } : {}) } : null;
        const previous = this.targets.get(source);
        if ((!target && !previous) || (target && previous && targetKey(target) === targetKey(previous))) return;
        if (target) this.targets.set(source, target);
        else this.targets.delete(source);
        this.revision += 1;
        if (this.warning && !this.matchesTarget(this.warning)) this.setWarning(null);
    }

    handleForeground(snapshot: { pid: number; executableName?: string; executablePath?: string }): void {
        if (!Number.isSafeInteger(snapshot.pid) || snapshot.pid <= 0) return;
        const exeName = normalizeExe(snapshot.executableName || snapshot.executablePath || '');
        // Focus alone must never classify an unrelated administrator app as the game.
        for (const [source, target] of this.targets) {
            if (source === 'capture' && target.exeName === exeName && target.pid !== snapshot.pid) {
                this.setTarget(source, { exeName, pid: snapshot.pid });
            }
        }
        void this.check();
    }

    snapshot(): GamePrivilegeWarning | null { return this.warning; }

    dismiss(id: string): void {
        if (this.warning?.id !== id) return;
        this.dismissed.add(id);
        this.setWarning(null);
    }

    private matchesTarget(value: { exeName: string; pid: number }): boolean {
        return [...this.targets.values()].some(target => target.exeName === normalizeExe(value.exeName) &&
            (target.pid === undefined || target.pid === value.pid));
    }

    private setWarning(warning: GamePrivilegeWarning | null): void {
        if (warning?.id === this.warning?.id) return;
        this.warning = warning;
        this.deps.publish?.(warning);
    }

    async check(): Promise<void> {
        if ((this.deps.platform ?? process.platform) !== 'win32' || this.gsmElevated) return;
        if (this.inFlight) {
            await this.inFlight;
            return this.check();
        }
        const targets = [...this.targets.values()];
        const now = Date.now();
        if (!targets.some(target => now - (this.lastChecked.get(targetKey(target)) ?? -Infinity) >= GAME_PRIVILEGE_CHECK_INTERVAL_MS)) return;
        for (const target of targets) this.lastChecked.set(targetKey(target), now);
        const revision = this.revision;
        this.inFlight = (async () => {
            try {
                const result = await this.deps.probe(targets);
                this.gsmElevated = result.gsmElevated === true;
                if (revision !== this.revision) return;
                for (const value of result.processes) {
                    if (this.matchesTarget(value)) this.lastChecked.set(targetKey({ ...value, exeName: normalizeExe(value.exeName) }), now);
                }
                const game = result.gsmElevated === false ? result.processes.find(value =>
                    value.elevated === true && this.matchesTarget(value) && !this.dismissed.has(`${value.pid}:${value.startedAt}`)) : undefined;
                this.setWarning(game ? { id: `${game.pid}:${game.startedAt}`, pid: game.pid, exeName: game.exeName } : null);
            } catch {
                // Missing/blocked PowerShell and inaccessible tokens are unknown, not evidence of elevation.
                if (revision === this.revision) this.setWarning(null);
            }
        })();
        try { await this.inFlight; }
        finally { this.inFlight = null; }
    }
}

let publishWarning: (warning: GamePrivilegeWarning | null) => void = () => {};
export const gamePrivilegeMonitor = new GamePrivilegeMonitor({
    probe: probeWindowsProcessPrivileges,
    publish: warning => publishWarning(warning),
});

export function setGamePrivilegeWarningPublisher(publish: typeof publishWarning): void {
    publishWarning = publish;
}
