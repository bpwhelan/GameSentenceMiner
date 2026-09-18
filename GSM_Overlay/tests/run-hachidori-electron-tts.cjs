// SPDX-License-Identifier: LGPL-3.0-only
// Run under a real display, for example:
//   xvfb-run -a node tests/run-hachidori-electron-tts.cjs baseline
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const mode = process.argv[2] || process.env.GSM_HACHIDORI_TTS_MODE;
if (!['baseline', 'fixed'].includes(mode)) {
  throw new Error('Pass baseline or fixed to run-hachidori-electron-tts.cjs.');
}
const evidenceDirectory = process.env.GSM_HACHIDORI_TTS_EVIDENCE_DIR;
const ankiExecutable = process.env.GSM_HACHIDORI_TTS_ANKI;
const ankiPython = process.env.GSM_HACHIDORI_TTS_ANKI_PYTHON;
const ankiConnectArchive = process.env.GSM_HACHIDORI_TTS_ANKICONNECT;
const speechDispatcher = process.env.GSM_HACHIDORI_TTS_SPEECH_DISPATCHER
  || '/usr/local/bin/speech-dispatcher';
for (const [name, value] of Object.entries({
  GSM_HACHIDORI_TTS_EVIDENCE_DIR: evidenceDirectory,
  GSM_HACHIDORI_TTS_ANKI: ankiExecutable,
  GSM_HACHIDORI_TTS_ANKI_PYTHON: ankiPython,
  GSM_HACHIDORI_TTS_ANKICONNECT: ankiConnectArchive,
  GSM_HACHIDORI_TTS_SPEECH_DISPATCHER: speechDispatcher,
})) {
  if (!value) throw new Error(`${name} is required.`);
}

const runDirectory = process.env.GSM_HACHIDORI_TTS_RUN_DIRECTORY
  || path.join(evidenceDirectory, 'runtime', mode);
const ankiBase = path.join(runDirectory, 'anki-base');
const profile = `I21 ${mode}`;
const profileResult = path.join(runDirectory, 'anki-profile.json');
const playerBin = path.join(runDirectory, 'player-bin');
const fixturePath = process.env.GSM_HACHIDORI_TTS_FIXTURE
  || path.resolve(__dirname, 'fixtures', 'hachidori-fixture.zip');
const ankiUrl = process.env.GSM_HACHIDORI_TTS_ANKI_URL || 'http://127.0.0.1:18765';
const parsedAnkiUrl = new URL(ankiUrl);
assert.equal(parsedAnkiUrl.hostname, '127.0.0.1');
assert.equal(parsedAnkiUrl.pathname, '/');
assert.equal(parsedAnkiUrl.search, '');
assert.equal(parsedAnkiUrl.hash, '');
const ankiPort = Number(parsedAnkiUrl.port);
assert.ok(Number.isInteger(ankiPort) && ankiPort > 1024 && ankiPort < 65536);
const sink = `hachidori_i21_${mode}_${process.pid}`;
const logPath = path.join(evidenceDirectory, 'logs', `${mode}-real-runtime.log`);
fs.mkdirSync(path.dirname(logPath), { recursive: true });
fs.rmSync(runDirectory, { recursive: true, force: true });
fs.mkdirSync(runDirectory, { recursive: true });
fs.mkdirSync(playerBin, { recursive: true });
fs.writeFileSync(logPath, '');

function appendLog(label, text) {
  fs.appendFileSync(logPath, `===== ${label} =====\n${text || ''}\n`);
}

function run(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: path.resolve(__dirname, '..'),
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  appendLog(`${label} stdout`, result.stdout);
  appendLog(`${label} stderr`, result.stderr);
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${label} succeeds; see ${logPath}`);
  return result.stdout.trim();
}

async function ankiAction(action, params = {}) {
  const response = await fetch(ankiUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, version: 6, params }),
  });
  if (!response.ok) throw new Error(`AnkiConnect ${action} returned HTTP ${response.status}.`);
  const reply = await response.json();
  if (reply.error !== null) throw new Error(`AnkiConnect ${action}: ${reply.error}`);
  return reply.result;
}

async function waitForAnki(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if (await ankiAction('version') >= 6) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for AnkiConnect at ${ankiUrl}: ${lastError}`);
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

run(ankiPython, [
  path.join(__dirname, 'prepare-anki-runtime.py'),
  '--base', ankiBase,
  '--profile', profile,
  '--result', profileResult,
], 'prepare Anki profile');
const addonDirectory = path.join(ankiBase, 'addons21', '2055492159');
fs.mkdirSync(addonDirectory, { recursive: true });
run('unzip', ['-q', '-o', ankiConnectArchive, '-d', addonDirectory], 'install AnkiConnect');
const ankiConnectEntrypoint = path.join(addonDirectory, '__init__.py');
const replayAction = `    @util.api()
    def guiReplayAudioForHachidoriTest(self):
        if not self.guiReviewActive():
            return False

        self.reviewer().replayAudio()
        return True


`;
const ankiConnectSource = fs.readFileSync(ankiConnectEntrypoint, 'utf8');
const replayInsertionPoint = '    @util.api()\n    def guiStartCardTimer(self):';
assert.equal(
  ankiConnectSource.split(replayInsertionPoint).length,
  2,
  'the isolated AnkiConnect copy has one reviewer action insertion point',
);
fs.writeFileSync(
  ankiConnectEntrypoint,
  ankiConnectSource.replace(replayInsertionPoint, `${replayAction}${replayInsertionPoint}`),
);
appendLog(
  'install isolated Anki reviewer replay action',
  'Added guiReplayAudioForHachidoriTest, which calls the real reviewer.replayAudio() method.\n',
);
fs.writeFileSync(path.join(addonDirectory, 'config.json'), `${JSON.stringify({
  apiKey: null,
  apiLogPath: path.join(runDirectory, 'ankiconnect-api.log'),
  webBindAddress: '127.0.0.1',
  webBindPort: ankiPort,
  webCorsOriginList: ['http://localhost'],
  ignoreOriginList: [],
}, null, 2)}\n`);
const mplayerLauncher = path.join(playerBin, 'mplayer');
fs.writeFileSync(mplayerLauncher, `#!/bin/sh
audio_file=
take_file=0
for argument in "$@"; do
  if [ "$take_file" -eq 1 ]; then
    audio_file=$argument
    break
  fi
  if [ "$argument" = "--" ]; then
    take_file=1
  fi
done
if [ -z "$audio_file" ]; then
  exit 2
fi
exec /usr/bin/paplay "$audio_file"
`);
fs.chmodSync(mplayerLauncher, 0o755);
appendLog(
  'install isolated Anki audio player',
  `${mplayerLauncher} adapts Anki's supported MPlayer fallback to /usr/bin/paplay.\n`,
);

const moduleId = run('pactl', [
  'load-module',
  'module-null-sink',
  `sink_name=${sink}`,
  'rate=48000',
  'channels=2',
], 'create private Pulse sink');
run('pactl', ['set-sink-mute', sink, '0'], 'unmute private Pulse sink');
run('pactl', ['set-sink-volume', sink, '100%'], 'set private Pulse sink volume');
fs.writeFileSync(path.join(ankiBase, 'mpv.conf'), `ao=pulse\naudio-device=pulse/${sink}\n`);

const speechdLog = fs.openSync(path.join(runDirectory, 'speech-dispatcher.log'), 'w');
const speechd = spawn(speechDispatcher, [
  '--run-single',
  '--timeout', '0',
  '--log-level', '4',
], {
  env: { ...process.env, PULSE_SINK: sink },
  stdio: ['ignore', speechdLog, speechdLog],
});
const ankiLog = fs.openSync(path.join(runDirectory, 'anki.log'), 'w');
const ankiEnvironment = {
  ...process.env,
  ANKI_SINGLE_INSTANCE_KEY: `hachidori-i21-${mode}-${process.pid}`,
  ANKI_SOFTWAREOPENGL: '1',
  PATH: `${playerBin}${path.delimiter}${process.env.PATH || ''}`,
  PULSE_SINK: sink,
  QTWEBENGINE_CHROMIUM_FLAGS: '--disable-gpu --disable-dev-shm-usage',
};
const anki = spawn(ankiExecutable, ['-b', ankiBase, '-p', profile], {
  env: ankiEnvironment,
  stdio: ['ignore', ankiLog, ankiLog],
});

(async () => {
  let ankiReady = false;
  try {
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(speechd.exitCode, null, 'the owned Speech Dispatcher stays running');
    await waitForAnki();
    ankiReady = true;
    await ankiAction('createDeck', { deck: 'I21::Baseline' });
    await ankiAction('createDeck', { deck: 'I21::Failure' });
    await ankiAction('createDeck', { deck: 'I21::Captured speech' });
    await ankiAction('createModel', {
      modelName: 'I21 Hachidori TTS',
      inOrderFields: ['Expression', 'Reading', 'Audio'],
      css: '.card { font-family: sans-serif; font-size: 28px; text-align: center; }',
      isCloze: false,
      cardTemplates: [{
        Name: 'Pronunciation',
        Front: '{{Expression}}<br>{{Reading}}<br>{{Audio}}',
        Back: '{{FrontSide}}',
      }],
    });

    const electronBinary = require('electron');
    const childScript = path.join(__dirname, 'hachidori-electron-tts.cjs');
    const childEnvironment = {
      ...process.env,
      GSM_HACHIDORI_TTS_MODE: mode,
      GSM_HACHIDORI_TTS_EVIDENCE_DIR: evidenceDirectory,
      GSM_HACHIDORI_TTS_RUN_DIRECTORY: runDirectory,
      GSM_HACHIDORI_TTS_FIXTURE: fixturePath,
      GSM_HACHIDORI_TTS_ANKI_URL: ankiUrl,
      GSM_HACHIDORI_TTS_PULSE_SINK: sink,
      PULSE_SINK: sink,
    };
    delete childEnvironment.ELECTRON_RUN_AS_NODE;
    const child = spawnSync(electronBinary, [childScript], {
      cwd: path.resolve(__dirname, '..'),
      env: childEnvironment,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 270_000,
    });
    appendLog('Electron stdout', child.stdout);
    appendLog('Electron stderr', child.stderr);
    appendLog('Electron status', `${child.status} signal ${child.signal || 'none'}`);
    if (child.error) throw child.error;
    if (child.status !== 0) {
      process.stdout.write(child.stdout || '');
      process.stderr.write(child.stderr || '');
    }
    assert.equal(child.status, 0, `${mode} Electron runtime succeeds; see ${logPath}`);

    const resultPath = path.join(evidenceDirectory, `${mode}-real-gsm-electron-tts.json`);
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    assert.equal(result.ok, true);
    assert.equal(result.mode, mode);
    assert.equal(result.ankiUrl, ankiUrl);
    fs.writeFileSync(path.join(runDirectory, 'runtime-result.json'), `${JSON.stringify({
      mode,
      profile: JSON.parse(fs.readFileSync(profileResult, 'utf8')),
      sourceCommit: result.sourceCommit,
      voice: result.voice,
      resultPath,
      logPath,
    }, null, 2)}\n`);
    console.log(JSON.stringify({
      ok: true,
      mode,
      sourceCommit: result.sourceCommit,
      voice: result.voice,
      evidence: resultPath,
      log: logPath,
    }));
  } finally {
    if (ankiReady) {
      try {
        await ankiAction('guiExitAnki');
      } catch (error) {
        appendLog('Anki exit request error', error.stack || String(error));
      }
    }
    if (!(await waitForExit(anki, 10_000))) {
      anki.kill('SIGTERM');
      if (!(await waitForExit(anki, 5_000))) anki.kill('SIGKILL');
    }
    speechd.kill('SIGTERM');
    if (!(await waitForExit(speechd, 5_000))) speechd.kill('SIGKILL');
    fs.closeSync(ankiLog);
    fs.closeSync(speechdLog);
    run('pactl', ['unload-module', moduleId], 'remove private Pulse sink');
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
