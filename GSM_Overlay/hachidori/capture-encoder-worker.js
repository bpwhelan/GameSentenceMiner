// SPDX-License-Identifier: GPL-3.0-or-later
import createAvifEncoderModule from "./vendor/avif-encoder.mjs";
import { encodeJpegSequence } from "./avif-sequence.js";

let modulePromise;

function encoderModule() {
  modulePromise ??= createAvifEncoderModule({
    locateFile: name => new URL(`./vendor/${name}`, import.meta.url).href,
  });
  return modulePromise;
}

// A dedicated worker receives messages only from its owning Worker. Window
// MessageEvent.origin checks do not form a security boundary in this context.
self.addEventListener("message", async event => { // NOSONAR -- S2819 applies to Window messaging, not this worker.
  const request = event.data;
  if (request?.type !== "encode" || typeof request.id !== "string") return;
  try {
    const module = await encoderModule();
    const data = await encodeJpegSequence(module, request.frames, {
      endMs: request.endMs,
      quality: request.videoPreset === "compact" ? 50 : 55,
      speed: 8,
      onProgress(completed, total) {
        self.postMessage({ type: "progress", id: request.id, completed, total,
          heapBytes: module.HEAPU8.byteLength });
      },
    });
    // WebAssembly memory only grows; this includes any final muxing allocation.
    self.postMessage({ type: "progress", id: request.id,
      completed: request.frames.length, total: request.frames.length,
      heapBytes: module.HEAPU8.byteLength });
    self.postMessage({ type: "result", id: request.id, ok: true, data: data.buffer }, [data.buffer]);
  } catch (error) {
    self.postMessage({ type: "result", id: request.id, ok: false,
      error: error instanceof Error ? error.message : String(error) });
  }
});
