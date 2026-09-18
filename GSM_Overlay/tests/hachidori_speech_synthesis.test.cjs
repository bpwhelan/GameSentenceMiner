// SPDX-License-Identifier: LGPL-3.0-only
const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createHachidoriSpeechSynthesisHandler,
  inspectPcmWav,
  synthesizeEspeakSpeech,
} = require('../hachidori_speech_synthesis');

function streamingWav(samples, sampleRate = 22_050) {
  const output = Buffer.alloc(44 + samples.length * 2);
  output.write('RIFF', 0, 'ascii');
  output.writeUInt32LE(0x7ffff024, 4);
  output.write('WAVEfmt ', 8, 'ascii');
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * 2, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write('data', 36, 'ascii');
  output.writeUInt32LE(0x7ffff000, 40);
  samples.forEach((sample, index) => output.writeInt16LE(sample, 44 + index * 2));
  return output;
}

test('eSpeak synthesis exports the selected browser voice as normalized audible PCM WAV', async () => {
  const source = streamingWav([0, 1000, -2000, 500]);
  const calls = [];
  const result = await synthesizeEspeakSpeech({
    text: 'たべる',
    voice: {
      voiceURI: 'Mandarin espeak',
      name: 'Mandarin espeak',
      lang: 'zh',
    },
  }, {
    executables: ['/test/espeak'],
    async execute(...args) {
      calls.push(args);
      return { stdout: source, stderr: Buffer.alloc(0) };
    },
  });
  assert.equal(result.backend, 'espeak');
  assert.equal(result.voice, 'zh');
  assert.equal(result.data.readUInt32LE(4), result.data.length - 8);
  assert.equal(result.data.readUInt32LE(40), result.data.length - 44);
  assert.deepEqual(result.metadata, {
    audioFormat: 1,
    channels: 1,
    sampleRate: 22_050,
    bitsPerSample: 16,
    bytes: 52,
    dataBytes: 8,
    frames: 4,
    durationSeconds: 4 / 22_050,
    peak: 2000,
  });
  assert.deepEqual(calls[0].slice(0, 2), [
    '/test/espeak',
    ['--stdout', '-v', 'zh', 'たべる'],
  ]);
});

test('WAV inspection rejects silence and unsupported sample formats', () => {
  assert.throws(() => inspectPcmWav(streamingWav([0, 0, 0])), /silent/u);
  const unsupported = streamingWav([100]);
  unsupported.writeUInt16LE(8, 34);
  assert.throws(() => inspectPcmWav(unsupported), /unsupported WAV format/u);
  const partialFrame = streamingWav([100]);
  partialFrame.writeUInt32LE(1, 40);
  assert.throws(() => inspectPcmWav(partialFrame), /unsupported WAV format/u);
});

test('non-eSpeak Web Speech voices fall through to Electron frame capture', async () => {
  await assert.rejects(synthesizeEspeakSpeech({
    text: '猫',
    voice: { voiceURI: 'System Japanese', name: 'System Japanese', lang: 'ja-JP' },
  }, {
    executables: [],
  }), error => error.code === 'HACHIDORI_SPEECH_UNSUPPORTED');
});

test('IPC handler serves only the active dedicated capture window', async () => {
  const mainFrame = { url: 'chrome-extension://hachidori-id/speech-capture.html' };
  const webContents = { mainFrame };
  const captureWindow = { isDestroyed: () => false, webContents };
  const handler = createHachidoriSpeechSynthesisHandler({
    getCaptureWindow: () => captureWindow,
    getExtensionId: () => 'hachidori-id',
    isHachidoriActive: () => true,
    async synthesize() {
      const wav = inspectPcmWav(streamingWav([1000, -1000]));
      return { backend: 'espeak', voice: 'ja', data: wav.data, metadata: wav.metadata };
    },
  });
  const reply = await handler({ sender: webContents, senderFrame: mainFrame }, { text: '猫', voice: {} });
  assert.equal(reply.ok, true);
  assert.equal(Buffer.from(reply.data, 'base64').subarray(0, 4).toString('ascii'), 'RIFF');
  for (const event of [
    { sender: {}, senderFrame: mainFrame },
    {
      sender: webContents,
      senderFrame: { url: 'chrome-extension://hachidori-id/speech-capture.html' },
    },
  ]) {
    await assert.rejects(handler(event, { text: '猫', voice: {} }), /unavailable/u);
  }
  mainFrame.url = 'https://example.test/';
  await assert.rejects(
    handler({ sender: webContents, senderFrame: mainFrame }, { text: '猫', voice: {} }),
    /unavailable/u,
  );
});
