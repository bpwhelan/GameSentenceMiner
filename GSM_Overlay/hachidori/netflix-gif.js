// SPDX-License-Identifier: GPL-3.0-or-later
import { GIFEncoder, quantize, applyPalette } from "./vendor/gifenc.js";

// Experimental Netflix mining's looping GIF. netflix-capture.js samples the
// tab-capture video track while the page replays one subtitle line; this file
// turns the frames it kept, in the cue's own window, into one looping GIF whose
// frame delays match the sampled times, with the pinned MIT encoder gifenc.
// The pure arithmetic (which frames to keep, each frame's delay) lives here so
// Node tests cover it without a browser.

// At most this many frames per second of the cue, and this many pixels wide.
export const GIF_MAX_FPS = 10;
export const GIF_MAX_WIDTH = 480;
// A single-frame cue still loops; a GIF needs a positive delay.
const MIN_DELAY_MS = 20;

// The frames to keep for a cue, from the frames the stream delivered. Each
// delivered frame carries its media time (ms, on the clip's clock). Frames
// inside [startMs, endMs] are kept, thinned so no two kept frames are closer
// than 1000 / GIF_MAX_FPS apart, and each kept frame's delay is the gap to the
// next kept frame (the last frame holds for the median gap so the loop pauses
// evenly before repeating).
export function selectGifFrames(frames, { startMs, endMs }) {
  const spacing = 1000 / GIF_MAX_FPS;
  const inside = frames
    .filter(frame => Number.isFinite(frame.mediaMs) && frame.mediaMs >= startMs && frame.mediaMs <= endMs)
    .sort((left, right) => left.mediaMs - right.mediaMs);
  const kept = [];
  for (const frame of inside) {
    if (kept.length === 0 || frame.mediaMs - kept.at(-1).mediaMs >= spacing - 1) kept.push(frame);
  }
  if (kept.length === 0) return [];
  const gaps = kept.slice(1).map((frame, index) => frame.mediaMs - kept[index].mediaMs);
  const sorted = [...gaps].sort((left, right) => left - right);
  const typical = sorted.length ? sorted[Math.floor(sorted.length / 2)] : spacing;
  return kept.map((frame, index) => ({
    frame,
    delayMs: Math.max(MIN_DELAY_MS, Math.round(index < gaps.length ? gaps[index] : typical)),
  }));
}

// A looping GIF of the kept frames. Each entry is { data (width*height*4 RGBA,
// as getImageData returns it), delayMs }. The line's frames share one 256-colour
// palette, quantised from all of them at once: gifenc's quantiser costs nearly
// as much for one detailed video frame as for the whole line, so a palette per
// frame made a few seconds of anime take seconds to encode while the note
// waited. The palette is the GIF's global colour table, written with the first
// frame, as is the loop marker.
export function encodeLoopingGif(entries, width, height) {
  const pixels = width * height;
  const rgba = new Uint8Array(entries.length * pixels * 4);
  entries.forEach(({ data }, index) => {
    // A resize during the replay changes the canvas between frames.
    if (data.length !== pixels * 4) throw new Error("A GIF frame is not width×height RGBA.");
    rgba.set(data, index * pixels * 4);
  });
  const palette = quantize(rgba, 256);
  const indexed = applyPalette(rgba, palette);
  const gif = GIFEncoder();
  entries.forEach(({ delayMs }, index) => {
    // gifenc's `delay` is milliseconds; it writes round(delay / 10) centiseconds.
    gif.writeFrame(indexed.subarray(index * pixels, (index + 1) * pixels), width, height,
      { ...(index === 0 ? { palette } : {}), delay: delayMs, repeat: 0 });
  });
  gif.finish();
  return gif.bytes();
}
