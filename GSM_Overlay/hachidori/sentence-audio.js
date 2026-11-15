// SPDX-License-Identifier: GPL-3.0-or-later

// Netflix and YouTube mining: a subtitle line's {sentence-audio}
// as a mono MP3 at a steady level. The reader cuts the line from what the
// viewer heard (netflix-audio.js) and the recorder frame from a tab recording
// (netflix-capture.js); both encode it here. The reader loads this module by
// its extension URL when it first adds a line.
import { Mp3Encoder } from "./vendor/lamejs.js";
import { encodeBase64 } from "./base64.js";

// Mono MP3 at 64 kbit/s: every Anki client plays MP3, and AnkiMobile plays
// neither Ogg nor Opus.
// The clip's mean (RMS) level is brought to TARGET_DBFS, louder or quieter, as
// far as its loudest sample allows without passing PEAK_DBFS, so a line sounds
// the same whatever the player's volume or the title's mix.
const TARGET_DBFS = -20;
const PEAK_DBFS = -1;
const amplitude = dbfs => 10 ** (dbfs / 20);
// The reader encodes on the page's own thread, where a line of a few seconds
// takes hundreds of milliseconds, so the encoder hands the thread back to the
// page whenever a slice of work has run this long, keeping each task the page
// sees under 50 ms. A chunk is four frames.
const SLICE_MS = 25;
const CHUNK = 4 * 1152;

// What the samples are multiplied by to reach the level.
export function levelGain(samples) {
  let energy = 0, peak = 0;
  for (const sample of samples) {
    energy += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
  }
  if (peak === 0) return 1;
  return Math.min(amplitude(TARGET_DBFS) / Math.sqrt(energy / samples.length), amplitude(PEAK_DBFS) / peak);
}

export async function encodeSentenceAudio(samples, sampleRate, { videoAudioFormat = "mp3", videoAudioBitrate = 64 } = {}) {
  if (!(samples instanceof Float32Array)) throw new TypeError("Sentence audio must be mono Float32 samples.");
  if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) throw new RangeError("The sentence audio's sample rate is invalid.");
  // Levelled samples stay within ±1, so none clips.
  const gain = levelGain(samples);
  if (videoAudioFormat === "opus") {
    const { AudioSample, AudioSampleSource, BufferTarget, OggOutputFormat, Output } = await import("./vendor/mediabunny/mediabunny.js");
    const target = new BufferTarget();
    const output = new Output({ target, format: new OggOutputFormat() });
    // Opus accepts 48 kHz; the viewer's audio device can deliver 44.1 kHz.
    const source = new AudioSampleSource({ codec: "opus", bitrate: videoAudioBitrate * 1000,
      transform: { sampleRate: 48_000 } });
    output.addAudioTrack(source);
    await output.start();
    const sample = new AudioSample({ data: samples.map(value => value * gain), format: "f32-planar",
      numberOfChannels: 1, sampleRate, timestamp: 0 });
    try {
      await source.add(sample);
      await output.finalize();
    } catch (error) { await output.cancel(); throw error; }
    finally { sample.close(); }
    return new Uint8Array(target.buffer);
  }
  const pcm = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index] * gain;
    pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  const encoder = new Mp3Encoder(1, sampleRate, videoAudioBitrate);
  const parts = [];
  let slice = performance.now();
  for (let start = 0; start < pcm.length; start += CHUNK) {
    parts.push(encoder.encodeBuffer(pcm.subarray(start, start + CHUNK)));
    if (performance.now() - slice >= SLICE_MS) {
      await new Promise(resolve => setTimeout(resolve)); // NOSONAR: the page gets its thread back between slices
      slice = performance.now();
    }
  }
  parts.push(encoder.flush());
  // lamejs answers with Int8Arrays, whatever its typings say.
  const bytes = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(new Uint8Array(part.buffer, part.byteOffset, part.length), offset);
    offset += part.length;
  }
  return bytes;
}

// The line as extension messages carry it: they are JSON, so base64.
export async function sentenceAudioBase64(samples, sampleRate, options) {
  return encodeBase64(await encodeSentenceAudio(samples, sampleRate, options));
}
