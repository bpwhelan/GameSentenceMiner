// Verify request correlation against the built input server without loading a dictionary.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const WebSocket = require('ws');

async function main() {
  const executable = path.resolve(process.argv[2] || path.join(__dirname,
    '../input_server/bin', process.platform === 'win32' ? 'gsm_overlay_server.exe' : 'gsm_overlay_server'));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-tokenization-protocol-'));
  const settings = path.join(directory, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ gamepadXinputEnabled: false, gamepadDinputEnabled: false }));
  const child = spawn(executable, ['--host', '127.0.0.1', '--port', '0'], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GSM_OVERLAY_DATA_PATH: directory, GSM_GAMEPAD_SETTINGS_PATH: settings },
  });
  const closed = once(child, 'close');
  let socket, output = '';
  let rejectTimeout;
  const failed = new Promise((_, reject) => { rejectTimeout = reject; });
  const timeout = setTimeout(() => rejectTimeout(new Error(`Server smoke timed out: ${output}`)), 15000);
  child.once('error', rejectTimeout);
  try {
    const ready = new Promise(resolve => {
      for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {
        output += data.toString();
        const match = output.match(/GSM_INPUT_SERVER_READY:([^\r\n]+)/);
        if (match) resolve(JSON.parse(match[1]));
      });
    });
    const endpoint = await Promise.race([ready, failed]);
    socket = new WebSocket(`ws://${endpoint.host}:${endpoint.port}`);
    await Promise.race([once(socket, 'open'), failed]);
    const replies = [];
    const complete = new Promise(resolve => socket.on('message', data => {
      const reply = JSON.parse(data.toString());
      if (reply.type === 'tokens') replies.push(reply);
      if (replies.length === 3) resolve();
    }));
    for (const requestId of [1, 2, undefined]) {
      socket.send(JSON.stringify({ type: 'tokenize', text: '', blockIndex: 0, requestId }));
    }
    await Promise.race([complete, failed]);
    assert.deepEqual(replies.map(reply => reply.requestId), [1, 2, undefined]);
    assert(replies.every(reply => reply.blockIndex === 0 && reply.text === '' && reply.tokens.length === 0));
    assert.equal(Object.hasOwn(replies[2], 'requestId'), false);
    console.log('Passed: tokenization request IDs echoed and legacy requests supported');
  } finally {
    clearTimeout(timeout);
    socket?.terminate();
    child.kill(); // Only this test's isolated helper.
    await closed;
    fs.rmSync(settings, { force: true });
    fs.rmdirSync(directory);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
