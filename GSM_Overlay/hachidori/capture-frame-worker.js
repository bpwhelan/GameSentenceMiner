// SPDX-License-Identifier: GPL-3.0-or-later
import { MAX_FRAME_BYTES } from "./capture-buffer.js";

let canvas = null;
let context = null;

async function encodeFrame({ frame, width, height }) {
  try {
    if (!canvas) {
      canvas = new OffscreenCanvas(width, height);
      context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("Could not create the capture frame canvas.");
    }
    // Keep the initial output size as the captured window changes shape.
    const sourceWidth = frame.displayWidth || frame.width;
    const sourceHeight = frame.displayHeight || frame.height;
    const scale = Math.min(1, canvas.width / sourceWidth, canvas.height / sourceHeight);
    const drawWidth = sourceWidth * scale;
    const drawHeight = sourceHeight * scale;
    context.fillStyle = "#000";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(frame, (canvas.width - drawWidth) / 2,
      (canvas.height - drawHeight) / 2, drawWidth, drawHeight);
  } finally {
    frame.close();
  }
  // Chrome uses idle tasks for main-thread JPEG encoding, delaying hidden
  // capture documents by about a second. Worker encoding runs directly.
  let blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.72 });
  if (blob.size > MAX_FRAME_BYTES) {
    blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.5 });
  }
  return blob.size > MAX_FRAME_BYTES ? null : blob.arrayBuffer();
}

self.addEventListener("message", async ({ data }) => {
  try {
    const bytes = await encodeFrame(data);
    self.postMessage({ bytes }, bytes ? [bytes] : []);
  } catch (error) {
    self.postMessage({ error: error.message || String(error) });
  }
});
