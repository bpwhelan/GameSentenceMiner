import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { GameBackgroundOptions, GameBackgroundTarget, GameBackgroundTelemetry } from '../../shared/game_background.js';
import type { BackgroundController } from './game_background.js';

const execFileAsync = promisify(execFile);
export function gameBackgroundHelperPath(root: string, arch: 'x86' | 'x64'): string {
    const base = path.join(root, 'native', 'game-background-hooks', 'bin', arch);
    const { buildId } = JSON.parse(readFileSync(path.join(base, 'current.json'), 'utf8'));
    if (typeof buildId !== 'string' || !/^[a-f0-9]{16}$/.test(buildId)) throw new Error('Invalid game hook build manifest');
    return path.join(base, buildId, 'gsm-game-background-helper.exe');
}

export function gameBackgroundBuildAvailable(root: string): boolean {
    try {
        return (['x86', 'x64'] as const).every(arch => {
            const helper = gameBackgroundHelperPath(root, arch);
            return existsSync(helper) && existsSync(path.join(path.dirname(helper), 'gsm-game-background.dll'));
        });
    } catch { return false; }
}

export async function probeGameBackgroundTargets(root: string, executable: string): Promise<GameBackgroundTarget[]> {
    const { stdout } = await execFileAsync(gameBackgroundHelperPath(root, 'x64'), ['--probe', '--exe', executable],
        { windowsHide: true, timeout: 8000, maxBuffer: 256 * 1024, encoding: 'utf8' });
    const values: unknown = JSON.parse(stdout);
    if (!Array.isArray(values)) throw new Error('Invalid game probe response');
    return values.filter((value): value is GameBackgroundTarget => value &&
        Number.isSafeInteger(value.pid) && value.pid > 0 && /^\d+$/.test(value.hwnd) &&
        typeof value.path === 'string' && path.win32.isAbsolute(value.path) && typeof value.title === 'string' &&
        (value.arch === 'x86' || value.arch === 'x64') && typeof value.specialK === 'boolean');
}

export function launchGameBackgroundController(
    root: string, target: GameBackgroundTarget, options: GameBackgroundOptions,
    onStatus: (status: GameBackgroundTelemetry) => void, onExit: (error?: string) => void,
): BackgroundController {
    const child: ChildProcessWithoutNullStreams = spawn(gameBackgroundHelperPath(root, target.arch), [
        '--attach', '--pid', String(target.pid), '--hwnd', target.hwnd, '--path', target.path,
        '--keep-active', options.keepRendering ? '1' : '0', '--block-gamepad', options.blockGamepad ? '1' : '0',
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let failure = '';
    let stopped = false;
    let closing = false;
    let exited = false;
    let statusSeen = false;
    let stderr = '';
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const timeout = setTimeout(() => {
        failure = 'The game hook did not become ready within 20 seconds';
        child.kill();
    }, 20_000);
    timeout.unref();
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
    child.stdin.on('error', error => { if (!closing) failure = error.message; });
    child.on('error', error => { failure = error.message; });
    const reader = createInterface({ input: child.stdout });
    reader.on('line', line => {
        try {
            if (line.length > 16_384) throw new Error('Oversized native hook status');
            const value = JSON.parse(line);
            if (value.type === 'error') failure = String(value.message);
            else if (value.type === 'stopped') stopped = true;
            else if (value.type === 'ready' || value.type === 'status') {
                const fields = ['effective', 'focusHooks', 'windowHooks', 'inputHooks', 'errors', 'focusEvents', 'inputCalls', 'blockedCalls'];
                if (!fields.every(field => Number.isInteger(value[field])) || typeof value.foreground !== 'boolean')
                    throw new Error('Invalid native hook status');
                statusSeen = true;
                clearTimeout(timeout);
                onStatus(value);
            }
        } catch (error) { failure = String(error); child.kill(); }
    });
    child.on('close', code => {
        exited = true;
        clearTimeout(timeout);
        reader.close();
        if (!closing) onExit(failure || stderr || `Game hook helper exited (${code})`);
        finish();
    });
    return {
        configure(value) {
            if (exited || closing) throw new Error('Game hook helper is no longer running');
            child.stdin.write(`configure ${value.keepRendering ? 1 : 0} ${value.blockGamepad ? 1 : 0}\n`);
        },
        async stop() {
            if (exited) return;
            closing = true;
            child.stdin.end('stop\n');
            let killTimer: NodeJS.Timeout | undefined;
            try {
                await Promise.race([finished, new Promise<void>(resolve => {
                    killTimer = setTimeout(() => { child.kill(); resolve(); }, 5000);
                })]);
                // If a controller fails, the DLL's independent lease also restores
                // pass-through behavior. Wait for that lease before switching targets.
                if (!stopped && statusSeen) await new Promise(resolve => setTimeout(resolve, 3100));
            } finally { if (killTimer) clearTimeout(killTimer); }
        },
    };
}
