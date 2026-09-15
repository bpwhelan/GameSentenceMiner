// SPDX-License-Identifier: GPL-3.0-or-later

export const CAPTURE_ENCODING_TIMEOUT_MS = 30_000;

export function encodeCapturedAnimation(frames, options, {
  WorkerClass = globalThis.Worker,
  timeoutMs = CAPTURE_ENCODING_TIMEOUT_MS,
  onProgress = () => {},
  signal,
} = {}) {
  if (typeof WorkerClass !== "function") return Promise.reject(new Error("Media encoder workers are unavailable."));
  const worker = new WorkerClass(new URL("./capture-encoder-worker.js", import.meta.url), {
    type: "module",
    name: "hachidori-capture-encoder",
  });
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
      callback(value);
    };
    const onAbort = () => finish(reject, new Error("Media encoding was cancelled."));
    timer = setTimeout(() => {
      finish(reject, new Error("Media encoding exceeded the 30-second deadline."));
    }, timeoutMs);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.addEventListener("error", event => {
      finish(reject, event.error ?? new Error(event.message || "The media encoder worker stopped."));
    });
    worker.addEventListener("message", event => {
      const response = event.data;
      if (response?.id !== id) return;
      if (response.type === "progress") {
        onProgress(response.completed, response.total, response.heapBytes);
        return;
      }
      if (response.type !== "result") return;
      if (!response.ok) {
        finish(reject, new Error(response.error || "Media encoding failed."));
        return;
      }
      finish(resolve, new Uint8Array(response.data));
    });
    const transferable = [];
    const payloadFrames = frames.map(frame => {
      const data = frame.data instanceof Uint8Array ? frame.data.slice()
        : new Uint8Array(frame.data).slice();
      transferable.push(data.buffer);
      return { ...frame, data: data.buffer };
    });
    worker.postMessage({ type: "encode", id, frames: payloadFrames, ...options }, transferable);
  });
}
