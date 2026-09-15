// SPDX-License-Identifier: GPL-3.0-or-later

export const MAX_LIVE_FRAME_BYTES = 64 * 1024 * 1024;
export const MAX_PINNED_FRAME_BYTES = 32 * 1024 * 1024;
export const MAX_FRAME_BYTES = 256 * 1024;
export const MAX_WAV_BYTES = 1024 * 1024;
export const CAPTURE_SAMPLE_RATE = 48_000;

function finiteTime(value, label) {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}

function bytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new Error("capture frame data must be bytes");
}

export function createFrameRing({
  maxBytes = MAX_LIVE_FRAME_BYTES,
  maxAgeMs,
  maxFrameBytes = MAX_FRAME_BYTES,
} = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1
      || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0
      || !Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) {
    throw new Error("frame ring limits are invalid");
  }
  const frames = [];
  let totalBytes = 0;

  function evict(nowMs) {
    // Keep the predecessor that is still displayed at the retention boundary.
    while (frames.length && (totalBytes > maxBytes
        || (frames.length > 1 && frames[1].timestampMs <= nowMs - maxAgeMs))) {
      totalBytes -= frames.shift().data.byteLength;
    }
  }

  function append(value) {
    const data = bytes(value?.data);
    const timestampMs = finiteTime(value?.timestampMs, "frame timestamp");
    if (!Number.isSafeInteger(value?.width) || value.width < 1
        || !Number.isSafeInteger(value?.height) || value.height < 1) {
      throw new Error("capture frame dimensions are invalid");
    }
    if (data.byteLength === 0 || data.byteLength > maxFrameBytes) {
      throw new Error(`capture frame exceeds the ${maxFrameBytes}-byte limit`);
    }
    if (frames.length && timestampMs <= frames.at(-1).timestampMs) {
      throw new Error("capture frame timestamps must increase");
    }
    const frame = { timestampMs, width: value.width, height: value.height, data: data.slice() };
    frames.push(frame);
    totalBytes += frame.data.byteLength;
    evict(timestampMs);
    return { ...frame, data: frame.data.slice() };
  }

  function select(startMs, endMs, pinnedLimit = MAX_PINNED_FRAME_BYTES) {
    finiteTime(startMs, "pin start");
    finiteTime(endMs, "pin end");
    if (endMs <= startMs) throw new Error("capture pin interval is empty");
    const first = frames.findLastIndex(frame => frame.timestampMs <= startMs);
    if (first < 0) throw new Error("No retained video frame covers the start of this lookup.");
    const selected = frames.slice(first).filter(frame => frame.timestampMs < endMs);
    const size = selected.reduce((sum, frame) => sum + frame.data.byteLength, 0);
    if (size > pinnedLimit) throw new Error("The selected video exceeds the pinned-frame memory limit.");
    return selected.map((frame, index) => ({ ...frame,
      timestampMs: index === 0 ? startMs : frame.timestampMs, data: frame.data.slice() }));
  }

  return {
    append,
    select,
    clear() { frames.length = 0; totalBytes = 0; },
    oldestTimestamp: () => frames.length
      ? Math.max(frames[0].timestampMs, frames.at(-1).timestampMs - maxAgeMs) : null,
    newestTimestamp: () => frames.at(-1)?.timestampMs ?? null,
    size: () => ({ count: frames.length, bytes: totalBytes }),
  };
}

function sampleRange(block, startMs, endMs, length, rate) {
  return {
    first: Math.max(0, Math.round((block.startMs - startMs) * rate / 1000)),
    last: block.endMs >= endMs ? length
      : Math.min(length, Math.round((block.endMs - startMs) * rate / 1000)),
  };
}

export function createAudioRing({ maxAgeMs } = {}) {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) throw new Error("audio ring age is invalid");
  const blocks = [];

  function append(value) {
    const startMs = finiteTime(value?.startMs, "audio timestamp");
    const sampleRate = Number(value?.sampleRate);
    if (!Number.isSafeInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) {
      throw new Error("capture audio sample rate is invalid");
    }
    const samples = value?.samples instanceof Float32Array
      ? value.samples : new Float32Array(value?.samples ?? []);
    if (!samples.length) return null;
    const endMs = startMs + samples.length * 1000 / sampleRate;
    const block = { startMs, endMs, sampleRate, samples: samples.slice() };
    blocks.push(block);
    const cutoff = endMs - maxAgeMs;
    while (blocks.length && blocks[0].endMs < cutoff) blocks.shift();
    return { startMs, endMs, sampleRate, sampleCount: samples.length };
  }

  function covers(startMs, endMs, rate = CAPTURE_SAMPLE_RATE) {
    const length = Math.ceil((endMs - startMs) * rate / 1000);
    const ranges = blocks.map(block => sampleRange(block, startMs, endMs, length, rate))
      .filter(range => range.last > range.first).sort((a, b) => a.first - b.first);
    let coveredUntil = 0;
    for (const range of ranges) {
      if (range.first > coveredUntil) return false;
      coveredUntil = Math.max(coveredUntil, range.last);
    }
    return coveredUntil >= length;
  }

  function select(startMs, endMs, outputRate = CAPTURE_SAMPLE_RATE) {
    finiteTime(startMs, "audio pin start");
    finiteTime(endMs, "audio pin end");
    if (endMs <= startMs) throw new Error("capture audio interval is empty");
    const rate = Math.min(CAPTURE_SAMPLE_RATE, Math.trunc(outputRate));
    const length = Math.ceil((endMs - startMs) * rate / 1000);
    const output = new Float32Array(length);
    for (const block of blocks) {
      const { first, last } = sampleRange(block, startMs, endMs, length, rate);
      for (let index = first; index < last; index += 1) {
        const sourceTime = startMs + index * 1000 / rate;
        const sourceIndex = Math.min(block.samples.length - 1,
          Math.max(0, Math.floor((sourceTime - block.startMs) * block.sampleRate / 1000)));
        output[index] = block.samples[sourceIndex];
      }
    }
    return { samples: output, sampleRate: rate, partial: !covers(startMs, endMs, rate) };
  }

  return {
    append,
    covers,
    select,
    clear() { blocks.length = 0; },
    oldestTimestamp: () => blocks[0]?.startMs ?? null,
    newestTimestamp: () => blocks.at(-1)?.endMs ?? null,
    size: () => ({ blocks: blocks.length, samples: blocks.reduce((sum, block) => sum + block.samples.length, 0) }),
  };
}

function setAscii(view, offset, value) {
  for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.codePointAt(index));
}

export function encodeMonoWav(samples, sampleRate, maxBytes = MAX_WAV_BYTES) {
  if (!(samples instanceof Float32Array)) throw new Error("WAV input must be mono Float32 samples");
  if (!Number.isSafeInteger(sampleRate) || sampleRate < 8_000 || sampleRate > CAPTURE_SAMPLE_RATE) {
    throw new Error("WAV sample rate is invalid");
  }
  const byteLength = 44 + samples.length * 2;
  if (byteLength > maxBytes) throw new Error("Captured audio exceeds the 1 MiB WAV limit.");
  const output = new ArrayBuffer(byteLength);
  const view = new DataView(output);
  setAscii(view, 0, "RIFF");
  view.setUint32(4, byteLength - 8, true);
  setAscii(view, 8, "WAVE");
  setAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  setAscii(view, 36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Uint8Array(output);
}

export function createCapturePinStore({ now = Date.now, lifetimeMs = 2 * 60 * 1000 } = {}) {
  let pin = null;
  function releaseExpired() {
    if (pin && now() >= pin.expiresAt) pin = null;
  }
  return {
    create(value) {
      releaseExpired();
      if (pin) throw new Error("Another lookup already owns the capture pin.");
      const token = crypto.randomUUID();
      pin = { ...value, token, expiresAt: now() + lifetimeMs };
      return { ...pin };
    },
    get(token) {
      releaseExpired();
      return pin?.token === token ? pin : null;
    },
    release(token) {
      if (pin?.token !== token) return false;
      pin = null;
      return true;
    },
    clear() { pin = null; },
    active() { releaseExpired(); return pin !== null; },
  };
}
