// SPDX-License-Identifier: GPL-3.0-or-later
import {
  EMBEDDED_SPEECH_CAPTURE_TARGET,
  recordEmbeddedSpeech,
} from "./embedded-speech-capture.js";

const CAPTURE_TIMEOUT_MS = 30_000;

function describe(error) {
  return error instanceof Error ? error.message || String(error) : String(error);
}

function encodeBase64(window, data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    chunks.push(String.fromCodePoint(...bytes.subarray(offset, offset + 32_768)));
  }
  return window.btoa(chunks.join(""));
}

function captureSender(window, sender) {
  return sender?.id === window.chrome.runtime.id
    && sender.url === window.chrome.runtime.getURL("offscreen.html");
}

export function createEmbeddedSpeechCaptureHost(window, {
  capture = recordEmbeddedSpeech,
  timeoutMs = CAPTURE_TIMEOUT_MS,
} = {}) {
  const active = new Map();
  let tail = Promise.resolve();
  const listener = (message, sender, sendResponse) => {
    if (message?.target !== EMBEDDED_SPEECH_CAPTURE_TARGET || !captureSender(window, sender)) {
      return false;
    }
    const captureId = typeof message.captureId === "string" ? message.captureId : "";
    if (!captureId) return false;
    if (message.type === "hd_embedded_speech_capture_cancel") {
      active.get(captureId)?.abort(new DOMException("Speech capture was cancelled.", "AbortError"));
      sendResponse({
        type: `${message.type}_result`,
        requestId: message.requestId ?? null,
        ok: true,
      });
      return false;
    }
    if (message.type !== "hd_embedded_speech_capture" || active.has(captureId)) return false;

    const controller = new AbortController();
    active.set(captureId, controller);
    const timer = window.setTimeout(() => {
      controller.abort(new DOMException("Speech capture timed out.", "TimeoutError"));
    }, timeoutMs);
    const operation = tail.then(() => capture(
      window,
      message.source,
      message.term,
      controller.signal,
      { record: message.record !== false },
    ));
    tail = operation.catch(() => {});
    operation.then(result => {
      window.clearTimeout(timer);
      active.delete(captureId);
      sendResponse({
        type: `${message.type}_result`,
        requestId: message.requestId ?? null,
        ok: true,
        recordingRequired: result.recordingRequired === true,
        ...(result.data === undefined ? {} : { data: encodeBase64(window, result.data) }),
        ...(result.candidate === undefined ? {} : { candidate: result.candidate }),
      });
    }, error => {
      window.clearTimeout(timer);
      active.delete(captureId);
      sendResponse({
        type: `${message.type}_result`,
        requestId: message.requestId ?? null,
        ok: false,
        error: describe(error),
      });
    });
    return true;
  };
  window.chrome.runtime.onMessage.addListener(listener);
  return () => {
    window.chrome.runtime.onMessage.removeListener?.(listener);
    for (const controller of active.values()) {
      controller.abort(new DOMException("Speech capture host stopped.", "AbortError"));
    }
    active.clear();
  };
}

if (globalThis.chrome?.runtime?.onMessage) {
  createEmbeddedSpeechCaptureHost(globalThis);
}
