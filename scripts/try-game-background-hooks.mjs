// Bounded developer trial of one unambiguous running game. Does not save preferences.
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = process.argv[2];
const seconds = Number(process.argv[3] ?? 180);
if (!executable || !Number.isFinite(seconds) || seconds < 10 || seconds > 600)
    throw new Error('Usage: node scripts/try-game-background-hooks.mjs game.exe [10-600 seconds]');
const helper = arch => {
    const base = path.join(root, 'native', 'game-background-hooks', 'bin', arch);
    const { buildId } = JSON.parse(readFileSync(path.join(base, 'current.json'), 'utf8'));
    if (!/^[a-f0-9]{16}$/.test(buildId)) throw new Error('Invalid build manifest');
    return path.join(base, buildId, 'gsm-game-background-helper.exe');
};
const targets = JSON.parse(execFileSync(helper('x64'), ['--probe', '--exe', executable], { windowsHide: true, encoding: 'utf8' }));
if (targets.length !== 1) throw new Error(`Expected one game window, found ${targets.length}`);
const target = targets[0];
if (target.specialK) throw new Error('Special K is loaded; restart the game without it');
console.log(JSON.stringify({ type: 'target', ...target, trialSeconds: seconds }));
const child = spawn(helper(target.arch), ['--attach', '--pid', String(target.pid), '--hwnd', target.hwnd,
    '--path', target.path, '--keep-active', '1', '--block-gamepad', '1'], { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
let latest;
let lastForeground;
let lastPrint = 0;
createInterface({ input: child.stdout }).on('line', line => {
    const value = JSON.parse(line);
    latest = value;
    if (value.type !== 'status' || value.foreground !== lastForeground || Date.now() - lastPrint > 10_000) {
        console.log(line); lastPrint = Date.now();
    }
    lastForeground = value.foreground;
});
const timer = setTimeout(() => child.stdin.end('stop\n'), seconds * 1000);
const input = createInterface({ input: process.stdin });
input.on('line', command => {
    if (command === 'status') console.log(JSON.stringify(latest));
    else if (command === 'stop') child.stdin.end('stop\n');
    else if (/^configure [01] [01]$/.test(command)) child.stdin.write(`${command}\n`);
});
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('close', code => { clearTimeout(timer); input.close(); process.exit(code ?? 1); });
process.on('SIGINT', () => child.stdin.end('stop\n'));
