// SPDX-License-Identifier: LGPL-3.0-only
const { execFile: execFileCallback } = require('node:child_process');
const { promisify } = require('node:util');
const {
  isHachidoriSpeechCaptureFrame,
} = require('./hachidori_speech_capture');

const execFile = promisify(execFileCallback);
const HACHIDORI_SPEECH_SYNTHESIS_CHANNEL = 'hachidori-speech-synthesize';
const MAX_TEXT_BYTES = 4 * 1024;
const MAX_WAV_BYTES = 1024 * 1024;

class UnsupportedHachidoriSpeechVoiceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsupportedHachidoriSpeechVoiceError';
    this.code = 'HACHIDORI_SPEECH_UNSUPPORTED';
  }
}

function normalizeSpeechRequest(value) {
  const text = typeof value?.text === 'string' ? value.text : '';
  if (!text || Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) {
    throw new TypeError('Hachidori speech text must contain 1 to 4096 UTF-8 bytes.');
  }
  const voice = Object.fromEntries(
    ['voiceURI', 'name', 'lang'].map((key) => [
      key,
      typeof value?.voice?.[key] === 'string' ? value.voice[key].trim() : '',
    ]),
  );
  if (!voice.voiceURI || !voice.name || !voice.lang
      || [voice.voiceURI, voice.name, voice.lang].some((item) => item.length > 256)) {
    throw new TypeError('Hachidori speech requires one bounded browser voice descriptor.');
  }
  return { text, voice };
}

function espeakVoiceKeys(voice) {
  const identity = `${voice.name} ${voice.voiceURI}`;
  if (!/\bespeak(?:-ng)?\b/iu.test(identity)) return [];
  const language = voice.lang.toLowerCase().replaceAll('_', '-');
  const keys = [];
  if (/mandarin/iu.test(identity) || /^zh(?:-|$)/u.test(language)) {
    keys.push('zh');
  } else if (/cantonese/iu.test(identity) || /^yue(?:-|$)/u.test(language)) {
    keys.push('zh-yue');
  } else {
    keys.push(language);
    const base = language.split('-')[0];
    if (base !== language) keys.push(base);
  }
  return [...new Set(keys.filter(Boolean))];
}

function defaultEspeakExecutables(environment = process.env) {
  return [...new Set([
    environment.GSM_ESPEAK_EXECUTABLE,
    '/usr/bin/espeak-ng',
    '/usr/local/bin/espeak-ng',
    '/usr/bin/espeak',
    '/usr/local/bin/espeak',
    'espeak-ng',
    'espeak',
  ].filter(Boolean))];
}

function normalizeStreamingWav(value) {
  let data = Buffer.from(value);
  if (data.length < 44
      || data.subarray(0, 4).toString('ascii') !== 'RIFF'
      || data.subarray(8, 12).toString('ascii') !== 'WAVE') {
    throw new Error('The system speech backend did not return a WAV file.');
  }
  let offset = 12;
  let dataChunk = null;
  while (offset + 8 <= data.length) {
    const id = data.subarray(offset, offset + 4).toString('ascii');
    const declaredSize = data.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === 'data') {
      const actualSize = Math.min(declaredSize, data.length - start);
      data = Buffer.from(data.subarray(0, start + actualSize));
      data.writeUInt32LE(actualSize, offset + 4);
      dataChunk = { start, size: actualSize };
      break;
    }
    const next = start + declaredSize + (declaredSize % 2);
    if (next > data.length) break;
    offset = next;
  }
  if (dataChunk === null) throw new Error('The system speech WAV has no audio data chunk.');
  data.writeUInt32LE(data.length - 8, 4);
  return { data, dataChunk };
}

function inspectPcmWav(value) {
  const normalized = normalizeStreamingWav(value);
  const { data, dataChunk } = normalized;
  let offset = 12;
  let format = null;
  while (offset + 8 <= data.length) {
    const id = data.subarray(offset, offset + 4).toString('ascii');
    const size = data.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === 'fmt ' && size >= 16 && start + size <= data.length) {
      format = {
        audioFormat: data.readUInt16LE(start),
        channels: data.readUInt16LE(start + 2),
        sampleRate: data.readUInt32LE(start + 4),
        bitsPerSample: data.readUInt16LE(start + 14),
      };
      break;
    }
    offset = start + size + (size % 2);
  }
  if (!format
      || format.audioFormat !== 1
      || ![1, 2].includes(format.channels)
      || format.sampleRate < 8_000
      || format.sampleRate > 192_000
      || format.bitsPerSample !== 16
      || dataChunk.size < format.channels * 2
      || dataChunk.size % (format.channels * 2) !== 0) {
    throw new Error('The system speech backend returned an unsupported WAV format.');
  }
  if (data.length > MAX_WAV_BYTES) {
    throw new Error('The system speech WAV exceeds Hachidori’s 1 MiB limit.');
  }
  let peak = 0;
  for (let index = dataChunk.start; index + 1 < dataChunk.start + dataChunk.size; index += 2) {
    peak = Math.max(peak, Math.abs(data.readInt16LE(index)));
  }
  if (peak === 0) throw new Error('The system speech backend returned silent WAV data.');
  const frames = dataChunk.size / (format.channels * 2);
  return {
    data,
    metadata: {
      ...format,
      bytes: data.length,
      dataBytes: dataChunk.size,
      frames,
      durationSeconds: frames / format.sampleRate,
      peak,
    },
  };
}

async function synthesizeEspeakSpeech(request, {
  execute = execFile,
  executables = defaultEspeakExecutables(),
} = {}) {
  const normalized = normalizeSpeechRequest(request);
  const voiceKeys = espeakVoiceKeys(normalized.voice);
  if (voiceKeys.length === 0) {
    throw new UnsupportedHachidoriSpeechVoiceError(
      `The selected browser voice (${normalized.voice.name}) has no byte-exporting system synthesizer.`,
    );
  }
  let lastError = null;
  for (const executable of executables) {
    for (const voice of voiceKeys) {
      try {
        const { stdout } = await execute(
          executable,
          ['--stdout', '-v', voice, normalized.text],
          {
            encoding: null,
            maxBuffer: MAX_WAV_BYTES + 64 * 1024,
            timeout: 15_000,
            windowsHide: true,
          },
        );
        const wav = inspectPcmWav(stdout);
        return {
          backend: 'espeak',
          executable,
          voice,
          data: wav.data,
          metadata: wav.metadata,
        };
      } catch (error) {
        if (error?.code !== 'ENOENT') lastError = error;
      }
    }
  }
  throw new UnsupportedHachidoriSpeechVoiceError(
    lastError?.message
      ? `The selected eSpeak voice could not be exported: ${lastError.message}`
      : 'No eSpeak executable is available to export the selected browser voice.',
  );
}

let synthesisOverride = null;

function setHachidoriSpeechSynthesisForTesting(override) {
  const previous = synthesisOverride;
  synthesisOverride = override;
  return () => { synthesisOverride = previous; };
}

async function synthesizeHachidoriSpeech(request) {
  const runDefault = () => synthesizeEspeakSpeech(request);
  return synthesisOverride ? synthesisOverride(request, runDefault) : runDefault();
}

function createHachidoriSpeechSynthesisHandler({
  getCaptureWindow,
  getExtensionId,
  isHachidoriActive,
  synthesize = synthesizeHachidoriSpeech,
}) {
  if (typeof getCaptureWindow !== 'function'
      || typeof getExtensionId !== 'function'
      || typeof isHachidoriActive !== 'function') {
    throw new TypeError(
      'Hachidori speech synthesis requires window, extension identity, and active-reader callbacks.',
    );
  }
  return async (event, request) => {
    const captureWindow = getCaptureWindow();
    const extensionId = getExtensionId();
    if (!captureWindow || captureWindow.isDestroyed()
        || event?.sender !== captureWindow.webContents
        || event?.senderFrame !== captureWindow.webContents.mainFrame
        || !isHachidoriSpeechCaptureFrame(event.senderFrame, extensionId)
        || isHachidoriActive() !== true) {
      throw new Error('Hachidori speech synthesis is unavailable to this renderer.');
    }
    try {
      const result = await synthesize(request);
      return {
        ok: true,
        backend: result.backend,
        voice: result.voice,
        wav: result.metadata,
        data: result.data.toString('base64'),
      };
    } catch (error) {
      return {
        ok: false,
        unsupported: error?.code === 'HACHIDORI_SPEECH_UNSUPPORTED',
        error: error instanceof Error ? error.message || String(error) : String(error),
      };
    }
  };
}

module.exports = {
  HACHIDORI_SPEECH_SYNTHESIS_CHANNEL,
  UnsupportedHachidoriSpeechVoiceError,
  createHachidoriSpeechSynthesisHandler,
  defaultEspeakExecutables,
  espeakVoiceKeys,
  inspectPcmWav,
  normalizeSpeechRequest,
  setHachidoriSpeechSynthesisForTesting,
  synthesizeEspeakSpeech,
  synthesizeHachidoriSpeech,
};
