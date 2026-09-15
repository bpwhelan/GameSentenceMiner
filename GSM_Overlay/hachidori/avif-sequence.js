// SPDX-License-Identifier: GPL-3.0-or-later
import { CAPTURE_SAMPLE_RATE } from "./capture-buffer.js";

export const MAX_ANIMATED_AVIF_BYTES = 4 * 1024 * 1024;
export const AVIF_TIMESCALE = CAPTURE_SAMPLE_RATE;

function encoderError(module, handle) {
  return module.UTF8ToString(module._hda_last_error(handle)) || "Animated AVIF encoding failed.";
}

export function frameDurations(frames, endMs, timescale = AVIF_TIMESCALE) {
  if (!Array.isArray(frames) || !frames.length || !Number.isFinite(endMs)
      || !Number.isSafeInteger(timescale) || timescale < 1) {
    throw new Error("AVIF frame timing is invalid");
  }
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    if (!Number.isFinite(frame.timestampMs)
        || (index > 0 && frame.timestampMs <= frames[index - 1].timestampMs)) {
      throw new Error("AVIF frame timestamps must increase");
    }
  }
  const startMs = frames[0].timestampMs;
  let previousTick = 0;
  return frames.map((frame, index) => {
    const nextMs = index + 1 < frames.length ? frames[index + 1].timestampMs : endMs;
    if (nextMs <= frame.timestampMs) throw new Error("AVIF frame duration is empty");
    // Quantize cumulative boundaries, so rounding never drifts across frames.
    // The final ceil matches the WAV's exact number of PCM samples.
    const nextTick = index + 1 === frames.length
      ? Math.ceil((nextMs - startMs) * timescale / 1000)
      : Math.round((nextMs - startMs) * timescale / 1000);
    const duration = nextTick - previousTick;
    if (duration < 1) throw new Error("AVIF frame duration is below the timebase precision");
    previousTick = nextTick;
    return duration;
  });
}

export function createAvifSequenceEncoder(module, {
  width,
  height,
  timescale = AVIF_TIMESCALE,
  quality = 55,
  speed = 8,
} = {}) {
  const handle = module._hda_create(width, height, timescale, quality, speed);
  if (!handle) throw new Error(encoderError(module, 0));
  let finished = false;
  return {
    add(rgba, duration) {
      if (finished) throw new Error("AVIF sequence is already finished");
      if (!(rgba instanceof Uint8Array) || rgba.byteLength !== width * height * 4) {
        throw new Error("AVIF RGBA frame has the wrong size");
      }
      const pointer = module._malloc(rgba.byteLength);
      if (!pointer) throw new Error("Could not allocate AVIF frame memory.");
      try {
        module.HEAPU8.set(rgba, pointer);
        if (!module._hda_add_rgba(handle, pointer, rgba.byteLength, duration)) {
          throw new Error(encoderError(module, handle));
        }
      } finally {
        module._free(pointer);
      }
    },
    finish() {
      if (finished) throw new Error("AVIF sequence is already finished");
      finished = true;
      if (!module._hda_finish(handle)) throw new Error(encoderError(module, handle));
      const size = module._hda_output_size(handle);
      if (!size || size > MAX_ANIMATED_AVIF_BYTES) throw new Error("Animated AVIF exceeds its output limit.");
      const pointer = module._hda_output(handle);
      return module.HEAPU8.slice(pointer, pointer + size);
    },
    destroy() {
      module._hda_destroy(handle);
    },
  };
}

export async function encodeJpegSequence(module, frames, {
  endMs,
  quality = 55,
  speed = 8,
  createBitmap = globalThis.createImageBitmap?.bind(globalThis),
  createCanvas = (width, height) => new OffscreenCanvas(width, height),
  onProgress = () => {},
} = {}) {
  if (!Array.isArray(frames) || !frames.length || typeof createBitmap !== "function") {
    throw new Error("Captured video frames cannot be decoded.");
  }
  const [{ width, height }] = frames;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) throw new Error("Captured frame dimensions are invalid.");
  if (frames.some(frame => frame.width !== width || frame.height !== height)) {
    throw new Error("Captured frame dimensions changed during the selected interval.");
  }
  const durations = frameDurations(frames, endMs);
  if (frames.length === 1 && durations[0] < 2) {
    throw new Error("AVIF sequence duration is below the timebase precision");
  }
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  if (!context) throw new Error("Could not create the AVIF frame decoder canvas.");
  const encoder = createAvifSequenceEncoder(module, { width, height, quality, speed });
  try {
    for (let index = 0; index < frames.length; index += 1) {
      const frame = frames[index];
      const bitmap = await createBitmap(new Blob([frame.data], { type: "image/jpeg" }));
      try {
        context.drawImage(bitmap, 0, 0, width, height);
        const rgba = context.getImageData(0, 0, width, height).data;
        const pixels = new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength);
        if (frames.length === 1) {
          // libavif writes one image as a still AVIF without sequence timing.
          // Repeat its pixels while preserving the exact selected sample count.
          const firstDuration = Math.floor(durations[index] / 2);
          encoder.add(pixels, firstDuration);
          encoder.add(pixels, durations[index] - firstDuration);
        } else {
          encoder.add(pixels, durations[index]);
        }
      } finally {
        bitmap.close();
      }
      onProgress(index + 1, frames.length);
    }
    return encoder.finish();
  } finally {
    encoder.destroy();
  }
}
