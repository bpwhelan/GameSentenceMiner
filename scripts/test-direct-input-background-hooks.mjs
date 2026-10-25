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
    return { child, lines, clear: () => { lines.length = 0; }, command: text => child.stdin.write(`${text}\n`),
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
    };
}
function peripheralInput(frame) {
    assert.equal(frame.keyboard, 128, 'keyboard input must pass through');
    assert.equal(frame.mouseX, 11, 'mouse axes must pass through');
    assert.equal(frame.mouseButton, 128, 'mouse buttons must pass through');
    assert.equal(frame.keyboardEvents, 1, 'buffered keyboard events must pass through');
    assert.equal(frame.mouseEvents, 1, 'buffered mouse events must pass through');
}

for (const arch of ['x64', 'x86']) for (const encoding of ['ansi', 'unicode']) {
    const exe = path.join(root, `build-${arch}`, 'Release', 'game-background-fixture.exe');
    const { buildId } = JSON.parse(readFileSync(path.join(root, 'bin', arch, 'current.json'), 'utf8'));
    const helper = path.join(root, 'bin', arch, buildId, 'gsm-game-background-helper.exe');
    const fixture = start(exe, encoding === 'ansi' ? ['--ansi'] : []);
    let host;
    try {
        const identity = await fixture.wait(frame => frame.pid, 'DirectInput fixture identity');
        // Deliberately create and format the devices before GSM is injected.
        fixture.command(`load-directinput-${encoding}`);
        const baseline = await fixture.wait(frame => frame.type === 'directinput' && frame.button === 128, 'unfiltered existing controller');
        assert.equal(baseline.x, 65535); assert.equal(baseline.pov, 9000); peripheralInput(baseline);
        host = start(helper, ['--attach', '--pid', String(identity.pid), '--hwnd', identity.hwnd,
            '--path', exe, '--keep-active', '1', '--block-gamepad', '1']);
        await host.wait(frame => frame.type === 'ready', 'DirectInput hooks ready');
        const installed = await host.wait(frame => frame.inputHooks > 0 && frame.effective === 3, 'existing DirectInput devices intercepted');
        assert.equal(installed.errors, 0); assert.equal(installed.foreground, false);
        fixture.clear();
        const blocked = await fixture.wait(frame => frame.type === 'directinput' && frame.button === 0 && frame.x === 32767, 'centered DirectInput state');
        assert.equal(blocked.y, 32767); assert.equal(blocked.pov, 4294967295);
        assert.equal(blocked.unusedPov, 4294967295, 'unmapped POV fields must not become a pressed direction');
        assert.equal(blocked.events, 0, 'buffered and peeked events must be hidden');
        peripheralInput(blocked);
        fixture.clear(); fixture.command('di-custom');
        const custom = await fixture.wait(frame => frame.type === 'directinput' && frame.bytes === 12 && frame.button === 0 && frame.x === 0,
            'custom data format with a signed axis range');
        assert.equal(custom.pov, 4294967295); peripheralInput(custom);
        fixture.clear(); fixture.command('di-range');
        await fixture.wait(frame => frame.type === 'directinput' && frame.x === 60, 'axis range changes invalidate the neutral state');
        fixture.clear(); fixture.command('di-signedrange');
        await fixture.wait(frame => frame.type === 'directinput' && frame.x === 0, 'full signed axis ranges center at zero');
        fixture.clear(); fixture.command('di-range');
        await fixture.wait(frame => frame.type === 'directinput' && frame.x === 60, 'absolute range restored before testing relative axes');
        fixture.clear(); fixture.command('di-relative');
        await fixture.wait(frame => frame.type === 'directinput' && frame.x === 0, 'relative axes are zero');
        fixture.clear(); fixture.command('di-lost');
        const lost = await fixture.wait(frame => frame.type === 'directinput' && frame.code < 0, 'device-loss errors are preserved');
        assert.equal(lost.dataCode, lost.code); peripheralInput(lost);
        fixture.command('di-restored');
        host.command('configure 1 0');
        fixture.clear(); fixture.command('di-queue');
        const off = await fixture.wait(frame => frame.type === 'directinput' && frame.button === 128 && frame.events === 1, 'input option disabled');
        peripheralInput(off);
        host.command('configure 1 1');
        fixture.clear();
        await fixture.wait(frame => frame.type === 'directinput' && frame.button === 0 && frame.events === 0, 'input option re-enabled');
        host.command('stop'); await host.wait(frame => frame.type === 'stopped', 'DirectInput controller stops');
        fixture.clear(); fixture.command('di-queue');
        await fixture.wait(frame => frame.type === 'directinput' && frame.button === 128 && frame.events === 1, 'original input restored');
        console.log(`${arch}/${encoding}: late attachment, neutral controller state, custom formats, ranges, buffered input, keyboard/mouse preservation and stop passed`);
    } finally { host?.child.kill(); fixture.command('quit'); }
    const late = start(exe, encoding === 'ansi' ? ['--ansi'] : []);
    let lateHost;
    try {
        const identity = await late.wait(frame => frame.pid, 'late DirectInput fixture');
        lateHost = start(helper, ['--attach', '--pid', String(identity.pid), '--hwnd', identity.hwnd,
            '--path', exe, '--keep-active', '1', '--block-gamepad', '1']);
        await lateHost.wait(frame => frame.type === 'ready' && frame.inputHooks === 0, 'ready before DirectInput load');
        late.command(`load-directinput-${encoding}`);
        const directHooks = await lateHost.wait(frame => frame.inputHooks > 0, 'late-loaded DirectInput hooks');
        await late.wait(frame => frame.type === 'directinput' && frame.button === 0 && frame.x === 32767, 'late DirectInput filtered');
        late.command('load');
        await lateHost.wait(frame => frame.inputHooks > directHooks.inputHooks, 'adding XInput preserves the DirectInput hook count');
        await late.wait(frame => frame.code === 0 && frame.buttons === 0, 'XInput filtered alongside DirectInput');
        late.clear();
        await late.wait(frame => frame.type === 'directinput' && frame.button === 0 && frame.x === 32767, 'DirectInput stays filtered alongside XInput');
        lateHost.command('stop'); await lateHost.wait(frame => frame.type === 'stopped', 'late DirectInput stops');
        console.log(`${arch}/${encoding}: late-loaded DirectInput and combined XInput/DirectInput passed`);
    } finally { lateHost?.child.kill(); late.command('quit'); }
}
