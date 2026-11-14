// Exercise the actual service with an empty, isolated cache. Never send prepare_sudachi
// without a browser Origin: the only setup request below must be rejected.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const WebSocket = require('ws');

async function main() {
  const executable = path.resolve(process.argv[2]);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-sudachi-migration-'));
  const settings = path.join(directory, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ gamepadXinputEnabled: false, gamepadDinputEnabled: false }));
  const child = spawn(executable, ['--port', '0'], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GSM_SUDACHI_DATA_PATH: directory,
      GSM_SUDACHI_USER_DICTS_PATH: path.join(directory, 'user'), GSM_GAMEPAD_SETTINGS_PATH: settings },
  });
  const closed = once(child, 'close');
  const sockets = [];
  let output = '';
  const timer = setTimeout(() => child.kill(), 20000);
  try {
    const endpoint = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () => reject(Error(`Service exited: ${output}`)));
      for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {
        output += data.toString();
        const match = output.match(/GSM_INPUT_SERVER_READY:([^\r\n]+)/);
        if (match) resolve(JSON.parse(match[1]));
      });
    });
    const connect = async options => {
      const socket = new WebSocket(`ws://${endpoint.host}:${endpoint.port}`, options);
      sockets.push(socket);
      await once(socket, 'open');
      return socket;
    };
    const request = (socket, payload, type) => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { socket.off('message', receive); reject(Error(`No ${type} response`)); }, 5000);
      const receive = raw => {
        const value = JSON.parse(raw);
        if (value.type !== type) return;
        clearTimeout(timeout); socket.off('message', receive); resolve(value);
      };
      socket.on('message', receive);
      socket.send(JSON.stringify(payload));
    });
    const first = await connect();
    const features = await request(first, { type: 'configure_features', features: ['mecab'] }, 'service_features_changed');
    assert(features.features.enabled.includes('sudachi'));
    assert(!features.features.capabilities.includes('mecab'));
    const config = await request(first, { type: 'configure_sudachi', dictionary: 'core' }, 'sudachi_configuration');
    assert.equal(config.dictionary, 'core');
    assert.equal(config.state, 'setup_required');
    const second = await connect();
    const shared = await request(second, { type: 'configure_sudachi', dictionary: 'full' }, 'sudachi_configuration');
    assert.equal(shared.dictionary, 'core', 'ordinary clients cannot replace the shared selection');
    const tokens = await request(first, { type: 'tokenize', backend: 'mecab', dictionary: 'full', text: '日本語', requestId: 17 }, 'tokens');
    assert.equal(tokens.requestId, 17);
    assert.equal(tokens.tokenSource, 'sudachi');
    assert.equal(tokens.setupRequired, true);
    assert.equal(tokens.sudachiAvailable, false);
    assert.deepEqual(tokens.tokens, []);
    assert.match(tokens.error, /setup.*retry/);
    const reading = await request(first, { type: 'get_furigana', text: '日本語' }, 'furigana');
    assert.equal(reading.setupRequired, true);
    assert.deepEqual(reading.segments, []);
    const browser = await connect({ origin: 'https://example.com' });
    const rejected = await request(browser, { type: 'prepare_sudachi', dictionary: 'full' }, 'sudachi_status');
    assert.equal(rejected.state, 'error');
    assert.deepEqual(fs.readdirSync(path.join(directory, 'sudachi')), ['selection.txt']);
    assert(!output.includes('downloading Sudachi'));
    console.log('Passed: shared selection, legacy migration, explicit setup errors, no dictionary download');
  } finally {
    clearTimeout(timer);
    sockets.forEach(socket => socket.terminate());
    child.kill();
    await closed;
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert(path.basename(directory).startsWith('gsm-sudachi-migration-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
