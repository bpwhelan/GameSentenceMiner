// SPDX-License-Identifier: GPL-3.0-or-later

export function createCaptureFrameEncoder({ WorkerClass = globalThis.Worker,
  createBitmap = globalThis.createImageBitmap } = {}) {
  const worker = new WorkerClass(new URL("./capture-frame-worker.js", import.meta.url), {
    type: "module", name: "hachidori-capture-frames",
  });
  let pending = null;
  let closed = false;
  const close = (error = new Error("Frame capture stopped.")) => {
    closed = true;
    worker.terminate();
    pending?.reject(error);
    pending = null;
  };
  worker.addEventListener("error", event => {
    close(event.error ?? new Error(event.message || "The frame encoder stopped."));
  });
  worker.addEventListener("message", ({ data }) => {
    const request = pending;
    pending = null;
    if (!request) return;
    if (data.error) request.reject(new Error(data.error));
    else request.resolve(data.bytes ? new Uint8Array(data.bytes) : null);
  });
  return {
    async encode(source, dimensions) {
      if (closed) throw new Error("Frame capture stopped.");
      // Clone raw VideoFrames without copying pixels; the preview fallback
      // supplies an ImageBitmap. Only one frame is submitted at a time.
      const frame = typeof source.clone === "function" ? source.clone() : await createBitmap(source);
      if (closed || pending) {
        frame.close();
        throw new Error(closed ? "Frame capture stopped." : "A capture frame is already being encoded.");
      }
      return new Promise((resolve, reject) => {
        pending = { resolve, reject };
        try { worker.postMessage({ frame, ...dimensions }, [frame]); }
        catch (error) {
          pending = null;
          frame.close();
          reject(error);
        }
      });
    },
    close,
  };
}
