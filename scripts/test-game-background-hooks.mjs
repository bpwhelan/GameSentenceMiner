// Real cross-process injection with a deterministic gamepad API; no controller required.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'native', 'game-background-hooks');
function start(file, args = []) {
    const child = spawn(file, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = [];
    let error = '';
    child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', problem => { error += problem.message; });
    createInterface({ input: child.stdout }).on('line', line => {
        try { lines.push(JSON.parse(line)); } catch { error += line; }
    });
    return {
        child, lines,
        command: text => child.stdin.write(`${text}\n`),
        async wait(predicate, description, timeout = 7000) {
            const started = Date.now();
            while (Date.now() - started < timeout) {
                const found = lines.find(predicate);
                if (found) return found;
                if (child.exitCode !== null || error) throw new Error(`${description}: ${error} ${JSON.stringify(lines.slice(-3))}`);
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            throw new Error(`Timed out: ${description}: ${JSON.stringify(lines.slice(-3))}`);
        },
        clear() { lines.length = 0; },
    };
}

for (const arch of ['x64', 'x86']) {
    const build = path.join(root, `build-${arch}`, 'Release');
    const exe = path.join(build, 'game-background-fixture.exe');
    const { buildId } = JSON.parse(readFileSync(path.join(root, 'bin', arch, 'current.json'), 'utf8'));
    const helper = path.join(root, 'bin', arch, buildId, 'gsm-game-background-helper.exe');
    const fixture = start(exe);
    let controller;
    try {
        const identity = await fixture.wait(x => x.pid, 'fixture identity');
        fixture.command('load');
        await fixture.wait(x => x.buttons === 4096 && !x.foreground && !x.active, 'unmodified background input');
        const args = ['--attach', '--pid', String(identity.pid), '--hwnd', identity.hwnd, '--path', exe,
            '--keep-active', '1', '--block-gamepad', '1'];
        // Reject mismatched process identity before injection.
        const bad = start(helper, args.map((x, i) => i === args.indexOf('--path') + 1 ? `${exe}.wrong` : x));
        const failure = await bad.wait(x => x.type === 'error', 'reject wrong executable');
        assert.match(failure.message, /executable changed/);
        controller = start(helper, args);
        await controller.wait(x => x.type === 'ready', 'native hook ready');
        const ready = await controller.wait(x => x.effective === 3 && x.inputHooks > 0, 'both options enabled');
        assert.equal(ready.errors, 0);
        assert.equal(ready.foreground, false, 'synthetic activation must not take real focus');
        fixture.clear();
        fixture.command('deactivate');
        const blocked = await fixture.wait(x => x.active && x.foreground && x.buttons === 0 && x.code === 0, 'active rendering with neutral controller');
        assert.equal(blocked.absent, 1167);
        assert.equal(blocked.trigger, 0);
        assert.equal(blocked.axis, 0);
        assert.equal(blocked.keyCode, 4306);
        assert.notEqual(blocked.packet, 7, 'neutral state must invalidate a cached held-button packet');
        const progressed = await fixture.wait(x => x.active && x.ticks > blocked.ticks + 2, 'background render ticks continue');
        assert.equal(progressed.deactivations, blocked.deactivations);
        controller.command('configure 0 1');
        fixture.clear();
        await fixture.wait(x => !x.active && !x.foreground && x.buttons === 0, 'independent keep-active toggle');
        controller.command('configure 1 0');
        fixture.clear();
        await fixture.wait(x => x.active && x.buttons === 4096, 'independent input toggle');
        controller.command('stop');
        await controller.wait(x => x.type === 'stopped', 'clean stop');
        fixture.clear();
        await fixture.wait(x => !x.active && !x.foreground && x.buttons === 4096, 'original behavior restored');
        const packagedHelper = path.resolve(root, '..', '..', 'build', 'game-background-hooks', 'bin', arch, buildId, 'gsm-game-background-helper.exe');
        const otherBuild = start(packagedHelper, args);
        assert.match((await otherBuild.wait(x => x.type === 'error', 'reject a different resident build')).message, /restart the game/);
        // Reconnect to the resident pass-through DLL; a second controller must be refused.
        controller = start(helper, args);
        await controller.wait(x => x.type === 'ready', 'reattach');
        const duplicate = start(helper, args);
        assert.match((await duplicate.wait(x => x.type === 'error', 'reject second owner')).message, /Another GSM controller/);
        await controller.wait(x => x.effective === 3, 'reattach active');
        fixture.clear();
        controller.child.kill();
        await fixture.wait(x => !x.active && !x.foreground && x.buttons === 4096, 'lease expires after controller crash', 6000);
        console.log(`${arch}: real injection, neutral input, render ticks, independent options, stop, reconnect, ownership and crash recovery passed`);
    } finally {
        controller?.child.kill();
        fixture.command('quit');
    }
    // Input APIs loaded after injection are discovered without restarting the game.
    const late = start(exe);
    let host;
    try {
        const identity = await late.wait(x => x.pid, 'late fixture identity');
        host = start(helper, ['--attach', '--pid', String(identity.pid), '--hwnd', identity.hwnd,
            '--path', exe, '--keep-active', '1', '--block-gamepad', '1']);
        await host.wait(x => x.type === 'ready' && x.inputHooks === 0, 'ready before input load');
        late.command('load');
        await host.wait(x => x.inputHooks > 0, 'late input hook');
        await late.wait(x => x.buttons === 0 && x.code === 0, 'late input filtered');
        host.command('stop');
        await host.wait(x => x.type === 'stopped', 'late controller stop');
        console.log(`${arch}: late-loaded XInput passed`);
    } finally { host?.child.kill(); late.command('quit'); }
}
