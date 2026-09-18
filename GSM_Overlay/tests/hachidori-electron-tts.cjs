// SPDX-License-Identifier: LGPL-3.0-only
// Electron child for run-hachidori-electron-tts.cjs.
const {
  app,
  BrowserWindow,
  nativeImage,
  webContents,
} = require('electron');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  UnsupportedHachidoriSpeechVoiceError,
  setHachidoriSpeechSynthesisForTesting,
} = require('../hachidori_speech_synthesis');

const mode = process.env.GSM_HACHIDORI_TTS_MODE;
const evidenceDirectory = process.env.GSM_HACHIDORI_TTS_EVIDENCE_DIR;
const runDirectory = process.env.GSM_HACHIDORI_TTS_RUN_DIRECTORY;
const fixturePath = process.env.GSM_HACHIDORI_TTS_FIXTURE;
const ankiUrl = process.env.GSM_HACHIDORI_TTS_ANKI_URL;
const pulseSink = process.env.GSM_HACHIDORI_TTS_PULSE_SINK;
for (const [name, value] of Object.entries({
  GSM_HACHIDORI_TTS_MODE: mode,
  GSM_HACHIDORI_TTS_EVIDENCE_DIR: evidenceDirectory,
  GSM_HACHIDORI_TTS_RUN_DIRECTORY: runDirectory,
  GSM_HACHIDORI_TTS_FIXTURE: fixturePath,
  GSM_HACHIDORI_TTS_ANKI_URL: ankiUrl,
  GSM_HACHIDORI_TTS_PULSE_SINK: pulseSink,
})) {
  if (!value) throw new Error(`${name} is required.`);
}
if (!['baseline', 'fixed'].includes(mode)) throw new Error(`Unknown TTS mode: ${mode}`);
if (!fs.existsSync(fixturePath)) throw new Error(`Hachidori fixture does not exist: ${fixturePath}`);

const overlayDataPath = path.join(runDirectory, 'overlay-data');
const gsmDataPath = path.join(runDirectory, 'gsm-data');
fs.mkdirSync(evidenceDirectory, { recursive: true });
fs.mkdirSync(overlayDataPath, { recursive: true });
fs.mkdirSync(gsmDataPath, { recursive: true });
fs.writeFileSync(path.join(gsmDataPath, 'config.json'), JSON.stringify({
  experimental: {
    enable_experimental_features: true,
    enable_hachidori: true,
  },
  current_profile: 'Default',
  configs: {
    Default: {
      general: { single_port: 7275 },
      advanced: {},
      overlay: {},
    },
  },
}, null, 2));
fs.writeFileSync(path.join(overlayDataPath, 'settings.json'), JSON.stringify({
  pushToShowEnforcedDialogDismissed: true,
  mainBoxStartupWarningAcknowledged: true,
  openSettingsOnStartup: false,
  hideOnStartup: false,
  enableJitenReader: false,
  gamepadEnabled: false,
  gamepadControllerEnabled: false,
  gamepadKeyboardEnabled: false,
  routeAllHotkeysThroughInputServer: false,
}, null, 2));

process.env.GSM_OVERLAY_IN_PROCESS = '1';
process.env.GSM_OVERLAY_DATA_PATH = overlayDataPath;
process.env.GSM_DATA_DIR = gsmDataPath;
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('enable-speech-dispatcher');
app.commandLine.appendSwitch(
  'host-resolver-rules',
  'MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
);

const MODEL = 'I21 Hachidori TTS';
const BASELINE_DECK = 'I21::Baseline';
const FAILURE_DECK = 'I21::Failure';
const SUCCESS_DECK = 'I21::Captured speech';
const AUDIO_MEDIA_PATTERN = 'hachidori_*';
const timeout = setTimeout(() => {
  console.error(`GSM Hachidori TTS ${mode} phase timed out.`);
  app.exit(1);
}, 240_000);
let requestSequence = 0;
let synthesisMode = 'default';
const nativeSynthesis = [];
const restoreSpeechSynthesis = setHachidoriSpeechSynthesisForTesting(async (request, runDefault) => {
  if (synthesisMode === 'failure') {
    throw new Error('injected I21 native synthesis failure');
  }
  if (synthesisMode === 'unsupported') {
    throw new UnsupportedHachidoriSpeechVoiceError('injected I21 frame-capture fallback');
  }
  const result = await runDefault();
  nativeSynthesis.push({
    text: request.text,
    browserVoice: request.voice,
    backend: result.backend,
    executable: result.executable,
    voice: result.voice,
    wav: result.metadata,
    sha256: createHash('sha256').update(result.data).digest('hex'),
  });
  return result;
});

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(description, callback, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await callback();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  const suffix = lastError ? ` Last error: ${lastError.stack || lastError}` : '';
  throw new Error(`Timed out waiting for ${description}.${suffix}`);
}

function windowBy(predicate) {
  return BrowserWindow.getAllWindows().find(
    (window) => !window.isDestroyed() && predicate(window),
  );
}

async function withDebugger(contents, callback) {
  const attachedHere = !contents.debugger.isAttached();
  if (attachedHere) contents.debugger.attach('1.3');
  try {
    return await callback(contents.debugger);
  } finally {
    if (attachedHere && contents.debugger.isAttached()) contents.debugger.detach();
  }
}

async function showSettingsSection(settingsWindow, section) {
  await settingsWindow.webContents.executeJavaScript(
    `location.hash = ${JSON.stringify(`#${section}`)};`,
  );
  await waitFor(`the ${section} Settings section`, async () => (
    await settingsWindow.webContents.executeJavaScript(
      `document.getElementById(${JSON.stringify(section)})?.hidden === false`,
    )
  ));
}

async function waitForSettingsStartup(settingsWindow) {
  await waitFor('Hachidori Settings startup', async () => (
    settingsWindow.webContents.getURL().startsWith('chrome-extension://')
    && await settingsWindow.webContents.executeJavaScript(
      `document.readyState === "complete"
        && document.getElementById("engine-status") !== null
        && document.getElementById("audio-mining-help") !== null`,
    )
  ));
  await waitFor('the Hachidori engine status', async () => (
    await settingsWindow.webContents.executeJavaScript(`(() => {
      const text = document.getElementById("engine-status")?.textContent?.toLowerCase() || "";
      return text.includes("ready") || text.includes("no dictionaries")
        || text.includes("dictionary enabled") || text.includes("error");
    })()`)
  ), 90_000);
}

async function openSettings(mainWindow) {
  await mainWindow.webContents.executeJavaScript(
    `require("electron").ipcRenderer.send("open-yomitan-settings");`,
  );
  const settingsWindow = await waitFor('the real Hachidori Settings window', () => (
    windowBy((window) => {
      const url = window.webContents.getURL();
      return url.startsWith('chrome-extension://') && url.endsWith('/settings.html');
    })
  ));
  await waitForSettingsStartup(settingsWindow);
  return settingsWindow;
}

async function importFixture(settingsWindow) {
  await showSettingsSection(settingsWindow, 'add-dictionaries');
  await withDebugger(settingsWindow.webContents, async (debuggerApi) => {
    await debuggerApi.sendCommand('DOM.enable');
    const { root } = await debuggerApi.sendCommand('DOM.getDocument');
    const { nodeId } = await debuggerApi.sendCommand('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: '#import-file',
    });
    assert.ok(nodeId > 0, 'real Settings exposes the dictionary file input');
    await debuggerApi.sendCommand('DOM.setFileInputFiles', {
      nodeId,
      files: [fixturePath],
    });
  });
  await settingsWindow.webContents.executeJavaScript(
    `document.getElementById("import-file").dispatchEvent(new Event("change", { bubbles: true }));`,
  );
  await waitFor('the real dictionary import to finish', async () => (
    await settingsWindow.webContents.executeJavaScript(
      `document.getElementById("import-state")?.textContent?.trim()
        === "Finished 1 of 1 archive — 1 imported, 0 failed."`,
    )
  ), 120_000);
  await waitFor('the imported dictionary to become enabled', async () => (
    await settingsWindow.webContents.executeJavaScript(
      `document.getElementById("engine-status")?.textContent?.includes("1 dictionary enabled") === true`,
    )
  ), 90_000);
}

async function rawExtensionMessage(settingsWindow, target, type, fields = {}) {
  const message = {
    target,
    type,
    requestId: `i21-${mode}-${++requestSequence}`,
    ...fields,
  };
  const reply = await settingsWindow.webContents.executeJavaScript(
    `(async message => await chrome.runtime.sendMessage(message))(${JSON.stringify(message)})`,
  );
  return reply;
}

async function extensionMessage(settingsWindow, target, type, fields = {}) {
  const reply = await rawExtensionMessage(settingsWindow, target, type, fields);
  if (!reply?.ok) throw new Error(reply?.error || `${type} did not return a successful reply.`);
  return reply;
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

function readWav(data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  assert.equal(buffer.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(buffer.subarray(8, 12).toString('ascii'), 'WAVE');
  let offset = 12;
  let format = null;
  let samples = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.subarray(offset, offset + 4).toString('ascii');
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > buffer.length) throw new Error(`WAV chunk ${id} exceeds the file.`);
    if (id === 'fmt ') {
      format = {
        audioFormat: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        bitsPerSample: buffer.readUInt16LE(start + 14),
      };
    } else if (id === 'data') {
      samples = buffer.subarray(start, end);
    }
    offset = end + (size % 2);
  }
  assert.ok(format && samples, 'WAV contains fmt and data chunks');
  assert.equal(format.audioFormat, 1);
  assert.equal(format.bitsPerSample, 16);
  let peak = 0;
  let firstAudibleFrame = -1;
  let lastAudibleFrame = -1;
  const frameBytes = format.channels * 2;
  for (let frame = 0; frame * frameBytes + frameBytes <= samples.length; frame += 1) {
    let audible = false;
    for (let channel = 0; channel < format.channels; channel += 1) {
      const amplitude = Math.abs(samples.readInt16LE(frame * frameBytes + channel * 2));
      peak = Math.max(peak, amplitude);
      audible ||= amplitude >= 64;
    }
    if (audible) {
      if (firstAudibleFrame < 0) firstAudibleFrame = frame;
      lastAudibleFrame = frame;
    }
  }
  const audibleFrames = firstAudibleFrame < 0 ? 0 : lastAudibleFrame - firstAudibleFrame + 1;
  return {
    ...format,
    bytes: buffer.length,
    dataBytes: samples.length,
    frames: samples.length / (format.channels * 2),
    durationSeconds: samples.length / (format.channels * 2 * format.sampleRate),
    audibleFrames,
    audibleSpanSeconds: audibleFrames / format.sampleRate,
    peak,
  };
}

async function recordPulse(filename, action, afterMs = 600) {
  const output = path.join(evidenceDirectory, filename);
  fs.rmSync(output, { force: true });
  const recorder = spawn('parecord', [
    `--device=${pulseSink}.monitor`,
    '--file-format=wav',
    '--format=s16le',
    '--rate=48000',
    '--channels=2',
    output,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  recorder.stderr.setEncoding('utf8');
  recorder.stderr.on('data', (chunk) => { stderr += chunk; });
  await delay(250);
  const value = await action();
  await delay(afterMs);
  recorder.kill('SIGINT');
  const [code, signal] = await once(recorder, 'exit');
  if (code !== 0 && signal !== 'SIGINT') {
    throw new Error(`parecord failed (${code ?? signal}): ${stderr}`);
  }
  const wav = readWav(fs.readFileSync(output));
  assert.ok(wav.peak > 0, `${filename} contains audible PCM`);
  return { value, output, wav };
}

async function configure(settingsWindow, { deck, voice, duplicateBehavior = 'prevent' }) {
  return settingsWindow.webContents.executeJavaScript(`(async payload => {
    const stored = await chrome.storage.local.get("options");
    if (!Number.isInteger(stored.options?.revision) || stored.options.revision < 0) {
      throw new Error("The stored Hachidori options record has no valid revision.");
    }
    const beforeRevision = stored.options.revision;
    const before = HDReaderOptions.normaliseOptions(stored.options);
    const template = value => ({ value, overwriteMode: "overwrite" });
    const fieldTemplates = {
      Expression: template("{expression}"),
      Reading: template("{reading}"),
      Audio: template("{audio}"),
    };
    const source = {
      id: "i21-system-voice",
      type: "text-to-speech-reading",
      enabled: true,
      url: "",
      voice: payload.voice,
    };
    const anki = {
      ...HDReaderOptions.normaliseOptions({}).anki,
      deck: payload.deck,
      model: payload.model,
      url: payload.ankiUrl,
      captureScreenshot: false,
      duplicateScope: "model",
      duplicateBehavior: payload.duplicateBehavior,
      fieldTemplates,
    };
    const reply = await chrome.runtime.sendMessage({
      target: "hoshidicts-worker",
      type: "hd_options_write",
      requestId: payload.requestId,
      baseRevision: beforeRevision,
      options: { audioSources: [source], audioAutoplay: false, anki },
    });
    if (!reply?.ok) throw new Error(reply?.error || "Options could not be saved.");
    const afterStored = (await chrome.storage.local.get("options")).options;
    const after = HDReaderOptions.normaliseOptions(afterStored);
    return {
      beforeMapping: before.anki.fieldTemplates,
      afterMapping: after.anki.fieldTemplates,
      source: after.audioSources[0],
      anki: after.anki,
      revision: afterStored.revision,
    };
  })(${JSON.stringify({
    deck,
    voice,
    duplicateBehavior,
    model: MODEL,
    ankiUrl,
    requestId: `i21-configure-${++requestSequence}`,
  })})`);
}

async function lookupRequest(settingsWindow, expression) {
  const lookup = await extensionMessage(settingsWindow, 'hoshidicts-offscreen', 'hd_lookup', {
    text: expression,
    maxResults: 8,
  });
  const result = lookup.results.find((candidate) => candidate.term?.expression === expression);
  assert.ok(result, `real Hachidori lookup finds ${expression}`);
  const request = {
    ...result,
    generation: lookup.generation,
    sentence: `${expression}。`,
    matched: expression,
    matchOffset: 0,
    popupSelectionText: '',
    searchQuery: expression,
    documentTitle: `I21 ${mode} Electron test`,
    dictionaryAliases: {},
    frequencyDictionaries: [],
  };
  const status = await extensionMessage(settingsWindow, 'hachidori-anki', 'hd_anki_status');
  assert.equal(status.available, true, 'real AnkiConnect is available to Hachidori');
  request.configKey = status.configKey;
  return request;
}

async function mine(settingsWindow, expression) {
  const request = await lookupRequest(settingsWindow, expression);
  const preflight = await extensionMessage(
    settingsWindow,
    'hachidori-anki',
    'hd_anki_preflight',
    { request },
  );
  assert.equal(preflight.canAdd, true, `${expression} passes live Anki preflight`);
  const submit = await extensionMessage(
    settingsWindow,
    'hachidori-anki',
    'hd_anki_submit',
    { request },
  );
  assert.equal(submit.state, 'added', `${expression} is added to real Anki`);
  const [note] = await ankiAction('notesInfo', { notes: [submit.noteId] });
  assert.equal(note.noteId, submit.noteId);
  return { request, preflight, submit, note };
}

async function audioHelp(settingsWindow) {
  await showSettingsSection(settingsWindow, 'audio');
  const help = await settingsWindow.webContents.executeJavaScript(`(() => ({
    playbackOnlyHidden: document.getElementById("audio-mining-help").hidden,
    playbackOnlyText: document.getElementById("audio-mining-help").textContent.trim(),
    browserCaptureHidden: document.getElementById("audio-speech-capture-help").hidden,
    browserCaptureText: document.getElementById("audio-speech-capture-help").textContent.trim(),
    embeddedCaptureHidden: document.getElementById("audio-embedded-speech-capture-help")?.hidden ?? null,
    embeddedCaptureText: document.getElementById("audio-embedded-speech-capture-help")?.textContent.trim() ?? null,
  }))()`);
  const png = (await settingsWindow.webContents.capturePage()).toPNG();
  const screenshot = path.join(evidenceDirectory, `${mode}-real-gsm-electron-audio-settings.png`);
  fs.writeFileSync(screenshot, png);
  return {
    ...help,
    screenshot,
    screenshotSize: nativeImage.createFromBuffer(png).getSize(),
  };
}

async function captureLifecycleHost() {
  const captureHost = await waitFor('the Hachidori speech capture page', () => (
    webContents.getAllWebContents().find((contents) =>
      !contents.isDestroyed() && contents.getURL().endsWith('/speech-capture.html'))
  ));
  await captureHost.executeJavaScript(`(() => {
    if (globalThis.__i21CaptureLifecycle) return;
    const state = globalThis.__i21CaptureLifecycle = {
      streams: 0,
      tracks: 0,
      stops: 0,
      contextCloses: 0,
      directDestinationConnections: 0,
      keepaliveConnections: 0,
      keepaliveGainValues: [],
      mediaPlayCalls: 0,
      mediaEndedEvents: 0,
      failNextProcessor: false,
    };
    const mediaDevices = navigator.mediaDevices;
    const getDisplayMedia = mediaDevices.getDisplayMedia.bind(mediaDevices);
    mediaDevices.getDisplayMedia = async (...args) => {
      const stream = await getDisplayMedia(...args);
      state.streams += 1;
      for (const track of stream.getTracks()) {
        state.tracks += 1;
        const stop = track.stop.bind(track);
        let stopped = false;
        track.stop = () => {
          if (!stopped) {
            stopped = true;
            state.stops += 1;
          }
          return stop();
        };
      }
      return stream;
    };
    const close = AudioContext.prototype.close;
    AudioContext.prototype.close = function (...args) {
      state.contextCloses += 1;
      return close.apply(this, args);
    };
    const createScriptProcessor = AudioContext.prototype.createScriptProcessor;
    AudioContext.prototype.createScriptProcessor = function (...args) {
      if (state.failNextProcessor) {
        state.failNextProcessor = false;
        throw new Error("injected I21 audio-graph failure");
      }
      const context = this;
      const processor = createScriptProcessor.apply(context, args);
      const connect = processor.connect;
      processor.connect = function (target, ...connectArgs) {
        if (target === context.destination) state.directDestinationConnections += 1;
        return connect.call(this, target, ...connectArgs);
      };
      return processor;
    };
    const createGain = AudioContext.prototype.createGain;
    AudioContext.prototype.createGain = function (...args) {
      const gain = createGain.apply(this, args);
      const connect = gain.connect;
      gain.connect = function (target, ...connectArgs) {
        state.keepaliveConnections += 1;
        state.keepaliveGainValues.push(gain.gain.value);
        return connect.call(this, target, ...connectArgs);
      };
      return gain;
    };
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      state.mediaPlayCalls += 1;
      this.addEventListener("ended", () => {
        state.mediaEndedEvents += 1;
      }, { once: true });
      return play.apply(this, args);
    };
  })()`);
  return captureHost;
}

async function lifecycleState(captureHost, edit = null) {
  return captureHost.executeJavaScript(edit
    ? `(() => { ${edit}; return structuredClone(globalThis.__i21CaptureLifecycle); })()`
    : 'structuredClone(globalThis.__i21CaptureLifecycle)');
}

function noteFields(note) {
  return Object.fromEntries(
    Object.entries(note.fields).map(([name, field]) => [name, field.value]),
  );
}

async function storedAudio(note) {
  const fields = noteFields(note);
  const filename = /^\[sound:([^\]]+)\]$/u.exec(fields.Audio)?.[1];
  assert.ok(filename, `note ${note.noteId} references one sound file`);
  const encoded = await ankiAction('retrieveMediaFile', { filename });
  assert.equal(typeof encoded, 'string');
  const data = Buffer.from(encoded, 'base64');
  return {
    filename,
    fields,
    wav: readWav(data),
    sha256: createHash('sha256').update(data).digest('hex'),
    data,
  };
}

async function rejectedMine(settingsWindow, expression) {
  const request = await lookupRequest(settingsWindow, expression);
  const preflight = await extensionMessage(
    settingsWindow,
    'hachidori-anki',
    'hd_anki_preflight',
    { request },
  );
  assert.equal(preflight.canAdd, true, `${expression} passes live Anki preflight`);
  const submit = await rawExtensionMessage(
    settingsWindow,
    'hachidori-anki',
    'hd_anki_submit',
    { request },
  );
  assert.equal(submit?.ok, false, `${expression} fails before an Anki mutation`);
  return { request, preflight, submit };
}

async function directFrameCapture(captureHost, voice, expression, timeoutMs = null) {
  return captureHost.executeJavaScript(`(async payload => {
    try {
      const capture = await import("./embedded-speech-capture.js");
      const signal = payload.timeoutMs === null
        ? new AbortController().signal
        : AbortSignal.timeout(payload.timeoutMs);
      await capture.recordEmbeddedSpeech(
        globalThis,
        {
          id: "i21-frame-fallback",
          type: "text-to-speech-reading",
          enabled: true,
          url: "",
          voice: payload.voice,
        },
        {
          expression: payload.expression,
          reading: payload.reading,
        },
        signal,
      );
      return { ok: true };
    } catch (error) {
      return { ok: false, name: error?.name || "", error: error?.message || String(error) };
    }
  })(${JSON.stringify({
    voice: voice.voiceURI,
    expression,
    reading: expression,
    timeoutMs,
  })})`);
}

async function runBaseline(settingsWindow, voice) {
  const configuration = await configure(settingsWindow, { deck: BASELINE_DECK, voice: voice.voiceURI });
  const help = await audioHelp(settingsWindow);
  assert.equal(help.playbackOnlyHidden, false);
  assert.match(help.playbackOnlyText, /cannot be recorded into Anki/u);
  assert.match(help.playbackOnlyText, /downloadable pronunciation source/u);
  const playback = await recordPulse('baseline-web-speech-playback.wav', () => (
    extensionMessage(settingsWindow, 'hachidori-audio', 'hd_audio_play', {
      term: { expression: '食べる', reading: 'たべる' },
    })
  ));
  const beforeMedia = await ankiAction('getMediaFilesNames', { pattern: AUDIO_MEDIA_PATTERN });
  const mined = await mine(settingsWindow, '食べる');
  const afterMedia = await ankiAction('getMediaFilesNames', { pattern: AUDIO_MEDIA_PATTERN });
  const fields = noteFields(mined.note);
  assert.equal(fields.Audio, '');
  assert.deepEqual(afterMedia, beforeMedia);
  assert.deepEqual(
    (await settingsWindow.webContents.executeJavaScript(
      `(async () => (await chrome.storage.local.get("options")).options.anki.fieldTemplates)()`,
    )),
    configuration.afterMapping,
  );
  return {
    configuration,
    help,
    playback,
    mining: {
      ...mined,
      fields,
      mediaBefore: beforeMedia,
      mediaAfter: afterMedia,
      observedIssue: 'Web Speech produced audible PCM, but the mined note has no audio reference or stored media.',
    },
  };
}

async function runFixed(settingsWindow, voice) {
  const help = await audioHelp(settingsWindow);
  assert.equal(help.playbackOnlyHidden, true);
  assert.equal(help.embeddedCaptureHidden, false);
  assert.match(help.embeddedCaptureText, /records the selected browser voice/u);
  const playbackConfiguration = await configure(settingsWindow, {
    deck: SUCCESS_DECK,
    voice: voice.voiceURI,
  });
  const playback = await recordPulse('fixed-web-speech-playback.wav', () => (
    extensionMessage(settingsWindow, 'hachidori-audio', 'hd_audio_play', {
      term: { expression: '食べる', reading: 'たべる' },
    })
  ));
  const captureHost = await captureLifecycleHost();

  const failureConfiguration = await configure(settingsWindow, {
    deck: FAILURE_DECK,
    voice: voice.voiceURI,
  });
  const mediaBeforeFailure = await ankiAction('getMediaFilesNames', { pattern: AUDIO_MEDIA_PATTERN });
  const notesBeforeFailure = await ankiAction('findNotes', { query: `deck:"${FAILURE_DECK}"` });
  synthesisMode = 'unsupported';
  await lifecycleState(captureHost, 'globalThis.__i21CaptureLifecycle.failNextProcessor = true');
  const graphFailure = await directFrameCapture(captureHost, voice, 'ありがとう');
  assert.equal(graphFailure.ok, false);
  assert.match(graphFailure.error, /injected I21 audio-graph failure/u);
  const frameFallback = await recordPulse(
    'fixed-frame-fallback-local-echo.wav',
    () => directFrameCapture(captureHost, voice, 'ありがとう', 1_500),
    500,
  );
  assert.equal(frameFallback.value.ok, false);
  assert.match(
    frameFallback.value.error,
    /did not capture audible browser text-to-speech|timed out|aborted/iu,
  );
  synthesisMode = 'failure';
  const failure = await rejectedMine(settingsWindow, 'ありがとう');
  synthesisMode = 'default';
  const mediaAfterFailure = await ankiAction('getMediaFilesNames', { pattern: AUDIO_MEDIA_PATTERN });
  const notesAfterFailure = await ankiAction('findNotes', { query: `deck:"${FAILURE_DECK}"` });
  const failureLifecycle = await lifecycleState(captureHost);
  fs.writeFileSync(
    path.join(evidenceDirectory, 'fixed-failure-phase-diagnostic.json'),
    `${JSON.stringify({
      submit: failure.submit,
      lifecycle: failureLifecycle,
      notesBefore: notesBeforeFailure,
      notesAfter: notesAfterFailure,
      mediaBefore: mediaBeforeFailure,
      mediaAfter: mediaAfterFailure,
      graphFailure,
      frameFallback: {
        result: frameFallback.value,
        output: frameFallback.output,
        wav: frameFallback.wav,
      },
    }, null, 2)}\n`,
  );
  assert.match(failure.submit.error, /injected I21 native synthesis failure/u);
  assert.deepEqual(notesAfterFailure, notesBeforeFailure);
  assert.deepEqual(mediaAfterFailure, mediaBeforeFailure);
  assert.equal(failureLifecycle.streams, 2);
  assert.equal(failureLifecycle.stops, failureLifecycle.tracks);
  assert.equal(failureLifecycle.contextCloses, 2);
  assert.equal(failureLifecycle.directDestinationConnections, 0);
  assert.equal(failureLifecycle.keepaliveConnections, 1);
  assert.deepEqual(failureLifecycle.keepaliveGainValues, [0]);
  assert.equal(failureLifecycle.mediaPlayCalls, 0);
  assert.equal(failureLifecycle.mediaEndedEvents, 0);

  const successConfiguration = await configure(settingsWindow, {
    deck: SUCCESS_DECK,
    voice: voice.voiceURI,
    duplicateBehavior: 'new',
  });
  assert.deepEqual(successConfiguration.afterMapping, playbackConfiguration.afterMapping);
  assert.deepEqual(successConfiguration.afterMapping, failureConfiguration.afterMapping);
  const firstRecorded = await recordPulse(
    'fixed-mining-local-echo.wav',
    () => mine(settingsWindow, '食べる'),
    800,
  );
  const repeated = await mine(settingsWindow, '食べる');
  const changed = await mine(settingsWindow, '読む');
  assert.deepEqual(firstRecorded.value.submit.warnings, []);
  assert.deepEqual(repeated.submit.warnings, []);
  assert.deepEqual(changed.submit.warnings, []);
  const firstAudio = await storedAudio(firstRecorded.value.note);
  const repeatedAudio = await storedAudio(repeated.note);
  const changedAudio = await storedAudio(changed.note);
  assert.equal(firstAudio.filename, repeatedAudio.filename);
  assert.equal(firstAudio.sha256, repeatedAudio.sha256);
  assert.deepEqual(firstAudio.data, repeatedAudio.data);
  assert.notEqual(firstAudio.filename, changedAudio.filename);
  assert.notEqual(firstAudio.sha256, changedAudio.sha256);
  assert.notDeepEqual(firstAudio.data, changedAudio.data);
  for (const audio of [firstAudio, repeatedAudio, changedAudio]) {
    assert.equal(audio.wav.channels, 1);
    assert.equal(audio.wav.sampleRate, 22_050);
    assert.equal(audio.wav.bitsPerSample, 16);
    assert.ok(audio.wav.peak > 0);
    assert.ok(audio.wav.durationSeconds > 0);
  }
  const mediaAfterSuccess = await ankiAction('getMediaFilesNames', { pattern: AUDIO_MEDIA_PATTERN });
  assert.ok(mediaAfterSuccess.includes(firstAudio.filename));
  assert.ok(mediaAfterSuccess.includes(changedAudio.filename));
  assert.equal(mediaAfterSuccess.filter(filename => filename === firstAudio.filename).length, 1);
  assert.equal(nativeSynthesis.length, 3);
  assert.equal(nativeSynthesis[0].sha256, firstAudio.sha256);
  assert.equal(nativeSynthesis[1].sha256, repeatedAudio.sha256);
  assert.equal(nativeSynthesis[2].sha256, changedAudio.sha256);
  const successLifecycle = await lifecycleState(captureHost);
  assert.equal(successLifecycle.streams, 2);
  assert.equal(successLifecycle.stops, successLifecycle.tracks);
  assert.equal(successLifecycle.contextCloses, 2);
  assert.equal(successLifecycle.directDestinationConnections, 0);
  assert.equal(successLifecycle.keepaliveConnections, 1);
  assert.deepEqual(successLifecycle.keepaliveGainValues, [0]);
  assert.equal(successLifecycle.mediaPlayCalls, 3, 'each native-byte mining request plays exactly once');
  assert.equal(successLifecycle.mediaEndedEvents, 3, 'each native-byte playback reaches its end once');
  const miningEchoRatio = firstRecorded.wav.audibleSpanSeconds / firstAudio.wav.audibleSpanSeconds;
  assert.ok(
    miningEchoRatio >= 0.5 && miningEchoRatio <= 1.35,
    'the real output envelope is consistent with one native WAV playback',
  );
  const mappingAfterMining = await settingsWindow.webContents.executeJavaScript(
    `(async () => (await chrome.storage.local.get("options")).options.anki.fieldTemplates)()`,
  );
  assert.deepEqual(mappingAfterMining, successConfiguration.afterMapping);

  assert.equal(await ankiAction('guiDeckReview', { name: SUCCESS_DECK }), true);
  const currentCard = await waitFor('the resulting Anki card in the reviewer', async () => {
    try {
      const card = await ankiAction('guiCurrentCard');
      return card.fields?.Expression?.value === '食べる' ? card : null;
    } catch {
      return null;
    }
  });
  const replay = await recordPulse(
    'fixed-resulting-anki-card-replay.wav',
    () => ankiAction('guiReplayAudioForHachidoriTest'),
    Math.ceil(firstAudio.wav.durationSeconds * 1000) + 1200,
  );
  assert.equal(replay.value, true);
  assert.equal(currentCard.fields.Audio.value, `[sound:${firstAudio.filename}]`);
  const replayRatio = replay.wav.audibleSpanSeconds / firstAudio.wav.audibleSpanSeconds;
  assert.ok(
    replayRatio >= 0.5 && replayRatio <= 1.35,
    'the real Anki reviewer decodes the stored WAV into one audible output envelope',
  );

  return {
    help,
    voicePlaybackConfiguration: playbackConfiguration,
    playback,
    failure: {
      configuration: failureConfiguration,
      mediaBefore: mediaBeforeFailure,
      mediaAfter: mediaAfterFailure,
      notesBefore: notesBeforeFailure,
      notesAfter: notesAfterFailure,
      lifecycle: failureLifecycle,
      submit: failure.submit,
      graphFailure,
      frameFallback: {
        output: frameFallback.output,
        wav: frameFallback.wav,
        error: frameFallback.value.error,
      },
    },
    repeatedMining: {
      configuration: successConfiguration,
      first: {
        noteId: firstRecorded.value.note.noteId,
        submit: firstRecorded.value.submit,
        fields: firstAudio.fields,
        filename: firstAudio.filename,
        wav: firstAudio.wav,
        sha256: firstAudio.sha256,
      },
      repeated: {
        noteId: repeated.note.noteId,
        submit: repeated.submit,
        fields: repeatedAudio.fields,
        filename: repeatedAudio.filename,
        wav: repeatedAudio.wav,
        sha256: repeatedAudio.sha256,
      },
      changed: {
        noteId: changed.note.noteId,
        submit: changed.submit,
        fields: changedAudio.fields,
        filename: changedAudio.filename,
        wav: changedAudio.wav,
        sha256: changedAudio.sha256,
      },
      mediaAfter: mediaAfterSuccess,
      lifecycle: successLifecycle,
      mappingAfterMining,
      localEcho: {
        output: firstRecorded.output,
        wav: firstRecorded.wav,
        audibleSpanRatioToStored: miningEchoRatio,
      },
      nativeSynthesis,
    },
    ankiReplay: {
      currentCard,
      output: replay.output,
      wav: replay.wav,
      audibleSpanRatioToStored: replayRatio,
    },
  };
}

app.whenReady().then(async () => {
  const overlay = require('../main.js');
  try {
    assert.equal(
      app.commandLine.hasSwitch('enable-speech-dispatcher'),
      true,
      'the real Electron process enables its Linux Web Speech backend',
    );
    await overlay.startOverlayApp();
    const mainWindow = await waitFor('the GSM overlay window', () => (
      windowBy((window) => window.getTitle() === 'GSM Overlay')
    ));
    await waitFor('the GSM overlay page', async () => (
      mainWindow.webContents.getURL().endsWith('/index.html')
      && await mainWindow.webContents.executeJavaScript('document.readyState === "complete"')
    ));
    await waitFor('Hachidori as the active GSM dictionary reader', async () => (
      await mainWindow.webContents.executeJavaScript(`dictionaryReader === "hachidori"`)
    ));
    const settingsWindow = await openSettings(mainWindow);
    await importFixture(settingsWindow);
    const voiceReply = await waitFor(
      'Electron Web Speech voices',
      async () => {
        const reply = await extensionMessage(
          settingsWindow,
          'hachidori-audio',
          'hd_audio_voices',
        );
        return reply.voices.length ? reply : null;
      },
      30_000,
    );
    const voice = voiceReply.voices.find((candidate) => /^ja(?:-|$)/iu.test(candidate.lang))
      || voiceReply.voices.find((candidate) => candidate.default)
      || voiceReply.voices[0];
    assert.ok(voice, `Electron exposes at least one Web Speech voice: ${JSON.stringify(voiceReply.voices)}`);
    const phase = mode === 'baseline'
      ? await runBaseline(settingsWindow, voice)
      : await runFixed(settingsWindow, voice);
    const result = {
      ok: true,
      mode,
      sourceCommit: require('../hachidori/SOURCE.json').commit,
      extensionId: settingsWindow.webContents.getURL().split('/')[2],
      ankiUrl,
      configuredLoopbackEndpoints: [
        ankiUrl,
        'ws://127.0.0.1:7275/ws/plaintext',
        'ws://127.0.0.1:7275/ws/overlay',
        'http://127.0.0.1:7275/texthooker',
      ],
      voice,
      availableVoiceCount: voiceReply.voices.length,
      availableJapaneseVoiceCount: voiceReply.voices
        .filter((candidate) => /^ja(?:-|$)/iu.test(candidate.lang)).length,
      phase,
    };
    const resultPath = path.join(evidenceDirectory, `${mode}-real-gsm-electron-tts.json`);
    fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify({
      ok: true,
      mode,
      sourceCommit: result.sourceCommit,
      voice,
      evidence: resultPath,
    }));
    await overlay.stopOverlayApp();
    restoreSpeechSynthesis();
    clearTimeout(timeout);
    app.exit(0);
  } catch (error) {
    console.error(error);
    try {
      await overlay.stopOverlayApp();
    } catch (cleanupError) {
      console.error(cleanupError);
    }
    restoreSpeechSynthesis();
    clearTimeout(timeout);
    app.exit(1);
  }
}).catch((error) => {
  console.error(error);
  clearTimeout(timeout);
  app.exit(1);
});
