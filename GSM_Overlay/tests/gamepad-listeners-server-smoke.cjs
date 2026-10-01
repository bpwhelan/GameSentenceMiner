// Run against a built Windows helper; each case uses an isolated settings file.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const executable = path.resolve(process.argv[2] || path.join(__dirname, '../input_server/target/release/gsm_overlay_server.exe'));
const cases = [
  ['existing settings', {}, 'XInput'],
  ['both disabled', { gamepadXinputEnabled: false, gamepadDinputEnabled: false }, 'Disabled'],
  ['extended only', { gamepadXinputEnabled: false, gamepadDinputEnabled: true }, 'Sdl { xinput: false }'],
  ['both enabled', { gamepadXinputEnabled: true, gamepadDinputEnabled: true }, 'Sdl { xinput: true }'],
  ['explicit XInput only', { gamepadXinputEnabled: true, gamepadDinputEnabled: false }, 'XInput'],
];

async function checkCase(label, settings, backend, explicitSettingsPath) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-gamepad-listeners-'));
  const settingsPath = path.join(directory, explicitSettingsPath ? 'overlay-settings.json' : 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify(settings));
  const env = { ...process.env, GSM_OVERLAY_DATA_PATH: directory };
  delete env.GSM_GAMEPAD_SETTINGS_PATH;
  if (explicitSettingsPath) {
    env.GSM_GAMEPAD_SETTINGS_PATH = settingsPath;
    // The managed service's tokenizer directory must not override UI settings.
    fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({ gamepadDinputEnabled: true }));
  }
  const child = spawn(executable, ['--host', '127.0.0.1', '--port', '0'], {
    env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let socket;
  const closed = once(child, 'close');
  let fail;
  const failed = new Promise((_, reject) => { fail = reject; });
  const deadline = setTimeout(() => fail(new Error(`Timed out: ${label}\n${output}`)), 15_000);
  child.once('error', fail);
  child.once('exit', code => { if (!socket) fail(new Error(`Early exit ${code}: ${output}`)); });
  const listeners = new Set();
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', data => {
      output += data.toString();
      for (const listener of listeners) listener();
    });
  }
  const waitForOutput = predicate => Promise.race([failed, new Promise(resolve => {
    const check = () => {
      if (!predicate(output)) return;
      listeners.delete(check);
      resolve();
    };
    listeners.add(check);
    check();
  })]);

  try {
    await waitForOutput(text => text.includes(`Windows gamepad listener: ${backend}`) && /GSM_INPUT_SERVER_READY:([^\r\n]+)/.test(text));
    if (backend === 'XInput') await waitForOutput(text => text.includes('gilrs initialized'));
    if (backend.startsWith('Sdl')) await waitForOutput(text => text.includes('SDL gamepad input initialized'));
    const endpoint = JSON.parse(output.match(/GSM_INPUT_SERVER_READY:([^\r\n]+)/)[1]);
    socket = new WebSocket(`ws://${endpoint.host}:${endpoint.port}`);
    const messages = [];
    socket.on('message', data => messages.push(JSON.parse(data.toString())));
    await Promise.race([once(socket, 'open'), failed]);
    socket.send(JSON.stringify({ type: 'get_state' }));
    const pong = new Promise(resolve => socket.on('message', data => {
      if (JSON.parse(data.toString()).type === 'pong') resolve();
    }));
    socket.send(JSON.stringify({ type: 'ping' }));
    await Promise.race([pong, failed]);
    assert(messages.some(message => message.type === 'service_info'));
    if (backend === 'Disabled') {
      assert(!messages.some(message => message.type.startsWith('gamepad_')));
      assert(!output.includes('gilrs initialized'));
    }
    if (!backend.startsWith('Sdl')) assert(!output.includes('SDL gamepad input initialized'));
    else assert(!output.includes('gilrs initialized'));
    console.log(`Passed: ${label} (${explicitSettingsPath ? 'managed' : 'standalone'} settings)`);
  } finally {
    clearTimeout(deadline);
    socket?.terminate();
    // Only terminate the helper this test started, and remove its own files.
    child.kill();
    await closed;
    for (const filename of new Set([settingsPath, path.join(directory, 'settings.json')])) {
      fs.rmSync(filename, { force: true });
    }
    fs.rmdirSync(directory);
  }
}

(async () => {
  assert.equal(process.platform, 'win32', 'Windows listener smoke requires Windows');
  for (const [label, settings, backend] of cases) {
    await checkCase(label, settings, backend, true);
  }
  await checkCase('both disabled', { gamepadXinputEnabled: false, gamepadDinputEnabled: false }, 'Disabled', false);
})().catch(error => { console.error(error); process.exitCode = 1; });
