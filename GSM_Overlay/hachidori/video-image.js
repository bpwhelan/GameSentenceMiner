// SPDX-License-Identifier: GPL-3.0-or-later
import { encodeLoopingGif } from "./netflix-gif.js";

// Canvas uses the browser's maintained libwebp encoder. Wrap its still-frame
// chunks in WebP's animation container (RIFF, VP8X, ANIM, ANMF), preserving
// the capture's frame delays and looping indefinitely. No extra WASM codec.
const little = (value, length) => Uint8Array.from({ length }, (_, index) => (value >>> (8 * index)) & 255);
const concat = parts => {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
};
const ascii = value => new TextEncoder().encode(value);
const chunk = (type, data) => concat([ascii(type), little(data.length, 4), data, new Uint8Array(data.length % 2)]);

async function encodeWebP(entries, width, height, quality) {
  const canvas = new OffscreenCanvas(width, height), context = canvas.getContext("2d");
  const frames = [];
  for (const { data, delayMs } of entries) {
    context.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/webp", quality: quality / 100 }); // NOSONAR: frames share one canvas; finish this frame before drawing the next
    if (blob.type !== "image/webp") throw new Error("This browser cannot encode WebP animations.");
    const still = new Uint8Array(await blob.arrayBuffer()); // NOSONAR: keep frame payloads in capture order without retaining every Blob
    const payload = [];
    for (let offset = 12; offset < still.length;) {
      const size = new DataView(still.buffer).getUint32(offset + 4, true);
      const type = new TextDecoder().decode(still.subarray(offset, offset + 4));
      const end = offset + 8 + size + size % 2;
      if (type === "VP8 " || type === "VP8L" || type === "ALPH") payload.push(still.subarray(offset, end));
      offset = end;
    }
    frames.push(chunk("ANMF", concat([new Uint8Array(6), little(width - 1, 3), little(height - 1, 3),
      little(delayMs, 3), new Uint8Array([2]), ...payload])));
  }
  const body = concat([ascii("WEBP"), chunk("VP8X", concat([new Uint8Array([2, 0, 0, 0]),
    little(width - 1, 3), little(height - 1, 3)])), chunk("ANIM", new Uint8Array(6)), ...frames]);
  return concat([ascii("RIFF"), little(body.length, 4), body]);
}

export async function encodeVideoImage(entries, width, height, { videoImageFormat = "gif", videoImageQuality = 70 } = {}) {
  if (videoImageFormat === "gif") return encodeLoopingGif(entries, width, height);
  if (videoImageFormat === "avif") {
    const { encodeAvif } = await import("./video-avif.js");
    return encodeAvif(entries, width, height, videoImageQuality);
  }
  return encodeWebP(entries, width, height, videoImageQuality);
}
